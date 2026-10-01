import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import {
  adjustInventoryBalance,
  InventoryError,
} from "../inventory.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type AdjustBody = {
  delta?: number;
  reason?: string;
};

type CreateCycleCountBody = {
  balanceIds?: string[];
  note?: string;
};

type CountLineBody = {
  countedQuantity?: number;
};

type ReviewCycleCountBody = {
  decision?: "APPROVE" | "REJECT";
  reviewNote?: string;
};

const cycleCountInclude = {
  createdBy: {
    select: {
      id: true,
      displayName: true,
      role: true,
    },
  },
  submittedBy: {
    select: {
      id: true,
      displayName: true,
      role: true,
    },
  },
  reviewedBy: {
    select: {
      id: true,
      displayName: true,
      role: true,
    },
  },
  lines: {
    include: {
      countedBy: {
        select: {
          id: true,
          displayName: true,
          role: true,
        },
      },
      reconciledTransaction: true,
      inventoryBalance: {
        include: {
          product: {
            include: {
              medication: true,
              manufacturer: true,
            },
          },
          productLot: true,
          productExpiration: true,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
};

type CycleCountWithLines = Prisma.CycleCountSessionGetPayload<{
  include: typeof cycleCountInclude;
}>;

function presentBalance<T extends {
  onHandQuantity: { toString(): string };
  reservedQuantity: { toString(): string };
}>(balance: T) {
  const onHand = Number(balance.onHandQuantity.toString());
  const reserved = Number(balance.reservedQuantity.toString());
  return {
    ...balance,
    onHandQuantity: balance.onHandQuantity.toString(),
    reservedQuantity: balance.reservedQuantity.toString(),
    availableQuantity: (onHand - reserved).toFixed(3),
  };
}

function presentCycleCount(session: CycleCountWithLines) {
  return {
    ...session,
    lines: session.lines.map((line) => ({
      ...line,
      expectedOnHand: line.expectedOnHand?.toString() ?? null,
      expectedReserved: line.expectedReserved?.toString() ?? null,
      countedQuantity: line.countedQuantity?.toString() ?? null,
      discrepancy: line.discrepancy?.toString() ?? null,
      inventoryBalance: presentBalance(line.inventoryBalance),
    })),
  };
}

async function getCycleCount(id: string, siteId: string) {
  return db.cycleCountSession.findFirst({
    where: { id, siteId },
    include: cycleCountInclude,
  });
}

export async function inventoryRoutes(app: FastifyInstance) {
  app.get("/inventory/balances", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");

      const balances = await db.inventoryBalance.findMany({
        where: { siteId: actor.siteId },
        include: {
          product: {
            include: {
              medication: true,
              manufacturer: true,
            },
          },
          productLot: true,
          productExpiration: true,
          transactions: {
            orderBy: { occurredAt: "desc" },
            take: 25,
            include: {
              actor: {
                select: {
                  displayName: true,
                  role: true,
                },
              },
            },
          },
        },
        orderBy: [
          { product: { medication: { genericName: "asc" } } },
          { product: { ndc: "asc" } },
          { productLot: { lotNumber: "asc" } },
        ],
      });

      return {
        balances: balances.map(presentBalance),
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/inventory/balances/:id/adjust", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as AdjustBody;
      const reason = body.reason?.trim();
      const delta = body.delta;

      if (
        typeof delta !== "number" ||
        !Number.isFinite(delta) ||
        !reason
      ) {
        return reply.code(400).send({
          error: "A finite non-zero delta and adjustment reason are required.",
        });
      }

      const result = await db.$transaction(async (tx) => {
        const adjusted = await adjustInventoryBalance(tx, {
          balanceId: id,
          siteId: actor.siteId,
          actorId: actor.id,
          delta,
          reason,
          source: "MANUAL_ADJUSTMENT",
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_BALANCE_ADJUSTED",
          entityType: "InventoryBalance",
          entityId: id,
          requestId: request.id,
          metadata: {
            delta,
            reason,
            resultingOnHand: adjusted.balance.onHandQuantity.toString(),
            resultingReserved: adjusted.balance.reservedQuantity.toString(),
          },
        });

        return adjusted;
      });

      return {
        balance: presentBalance(result.balance),
        transaction: result.transaction,
      };
    } catch (error) {
      if (error instanceof AccessError || error instanceof InventoryError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error instanceof InventoryError
            ? { code: error.code, details: error.details }
            : {}),
        });
      }
      throw error;
    }
  });

  app.get("/inventory/cycle-counts", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");

      const sessions = await db.cycleCountSession.findMany({
        where: { siteId: actor.siteId },
        include: cycleCountInclude,
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      return {
        sessions: sessions.map(presentCycleCount),
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/inventory/cycle-counts/:id", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const id = (request.params as { id: string }).id;
      const session = await getCycleCount(id, actor.siteId);

      if (!session) {
        return reply.code(404).send({ error: "Cycle count not found." });
      }

      return { session: presentCycleCount(session) };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/inventory/cycle-counts", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as CreateCycleCountBody;
      const requestedIds = Array.isArray(body.balanceIds)
        ? [...new Set(body.balanceIds.filter(Boolean))]
        : [];

      const balances = await db.inventoryBalance.findMany({
        where: {
          siteId: actor.siteId,
          ...(requestedIds.length > 0 ? { id: { in: requestedIds } } : {}),
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });

      if (balances.length === 0) {
        return reply.code(409).send({
          error: "There are no inventory balances available for this cycle count.",
          code: "NO_INVENTORY_TO_COUNT",
        });
      }

      if (requestedIds.length > 0 && balances.length !== requestedIds.length) {
        return reply.code(404).send({
          error: "One or more inventory balances were not found at this pharmacy site.",
        });
      }

      const balanceIds = balances.map((balance) => balance.id);
      const overlapping = await db.cycleCountLine.findFirst({
        where: {
          inventoryBalanceId: { in: balanceIds },
          cycleCountSession: {
            siteId: actor.siteId,
            status: { in: ["OPEN", "SUBMITTED"] },
          },
        },
        include: {
          cycleCountSession: {
            select: {
              id: true,
              status: true,
            },
          },
        },
      });

      if (overlapping) {
        return reply.code(409).send({
          error:
            "At least one selected inventory balance is already part of an open or submitted cycle count.",
          code: "CYCLE_COUNT_ALREADY_ACTIVE",
          cycleCountId: overlapping.cycleCountSession.id,
          balanceId: overlapping.inventoryBalanceId,
        });
      }

      const session = await db.$transaction(async (tx) => {
        const created = await tx.cycleCountSession.create({
          data: {
            siteId: actor.siteId,
            createdById: actor.id,
            note: body.note?.trim() || null,
            lines: {
              create: balanceIds.map((inventoryBalanceId) => ({
                inventoryBalanceId,
              })),
            },
          },
          include: cycleCountInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_CYCLE_COUNT_CREATED",
          entityType: "CycleCountSession",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            lineCount: created.lines.length,
            balanceIds,
            note: created.note,
          },
        });

        return created;
      });

      return reply.code(201).send({
        session: presentCycleCount(session),
      });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch(
    "/inventory/cycle-counts/:id/lines/:lineId",
    async (request, reply) => {
      try {
        const actor = await resolveDevelopmentActor(request, "inventory:write");
        const { id, lineId } = request.params as {
          id: string;
          lineId: string;
        };
        const body = (request.body ?? {}) as CountLineBody;
        const countedQuantity = body.countedQuantity;

        if (
          typeof countedQuantity !== "number" ||
          !Number.isFinite(countedQuantity) ||
          countedQuantity < 0
        ) {
          return reply.code(400).send({
            error: "A finite physical count of zero or greater is required.",
          });
        }

        const existing = await db.cycleCountLine.findFirst({
          where: {
            id: lineId,
            cycleCountSessionId: id,
            cycleCountSession: { siteId: actor.siteId },
          },
          include: {
            cycleCountSession: true,
            inventoryBalance: true,
          },
        });

        if (!existing) {
          return reply.code(404).send({ error: "Cycle count line not found." });
        }

        if (existing.cycleCountSession.status !== "OPEN") {
          return reply.code(409).send({
            error: "Only an open cycle count can be edited.",
            code: "CYCLE_COUNT_NOT_OPEN",
          });
        }

        const updated = await db.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "InventoryBalance" WHERE "id" = ${existing.inventoryBalanceId} FOR UPDATE`,
          );

          const balance = await tx.inventoryBalance.findUniqueOrThrow({
            where: { id: existing.inventoryBalanceId },
          });
          const counted = new Prisma.Decimal(countedQuantity);
          const countedAt = new Date();

          const line = await tx.cycleCountLine.update({
            where: { id: lineId },
            data: {
              expectedOnHand: balance.onHandQuantity,
              expectedReserved: balance.reservedQuantity,
              countedQuantity: counted,
              discrepancy: counted.minus(balance.onHandQuantity),
              countedById: actor.id,
              countedAt,
              reconciledTransactionId: null,
            },
          });

          await writeAuditEvent(tx, {
            siteId: actor.siteId,
            actorId: actor.id,
            action: "INVENTORY_CYCLE_COUNT_LINE_COUNTED",
            entityType: "CycleCountLine",
            entityId: line.id,
            requestId: request.id,
            metadata: {
              cycleCountId: id,
              inventoryBalanceId: line.inventoryBalanceId,
              expectedOnHand: balance.onHandQuantity.toString(),
              expectedReserved: balance.reservedQuantity.toString(),
              countedQuantity: counted.toString(),
              discrepancy: counted.minus(balance.onHandQuantity).toString(),
            },
          });

          return line;
        });

        const session = await getCycleCount(id, actor.siteId);
        return {
          line: {
            ...updated,
            expectedOnHand: updated.expectedOnHand?.toString() ?? null,
            expectedReserved: updated.expectedReserved?.toString() ?? null,
            countedQuantity: updated.countedQuantity?.toString() ?? null,
            discrepancy: updated.discrepancy?.toString() ?? null,
          },
          session: session ? presentCycleCount(session) : null,
        };
      } catch (error) {
        if (error instanceof AccessError || error instanceof InventoryError) {
          return reply.code(error.statusCode).send({
            error: error.message,
            ...(error instanceof InventoryError
              ? { code: error.code, details: error.details }
              : {}),
          });
        }
        throw error;
      }
    },
  );

  app.post("/inventory/cycle-counts/:id/submit", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const id = (request.params as { id: string }).id;
      const session = await getCycleCount(id, actor.siteId);

      if (!session) {
        return reply.code(404).send({ error: "Cycle count not found." });
      }

      if (session.status !== "OPEN") {
        return reply.code(409).send({
          error: "Only an open cycle count can be submitted.",
          code: "CYCLE_COUNT_NOT_OPEN",
        });
      }

      const incomplete = session.lines.filter(
        (line) => line.countedQuantity === null || line.countedAt === null,
      );

      if (incomplete.length > 0) {
        return reply.code(409).send({
          error: "Every cycle count line must have a physical count before submission.",
          code: "CYCLE_COUNT_INCOMPLETE",
          incompleteLineIds: incomplete.map((line) => line.id),
        });
      }

      const submitted = await db.$transaction(async (tx) => {
        const updated = await tx.cycleCountSession.update({
          where: { id },
          data: {
            status: "SUBMITTED",
            submittedById: actor.id,
            submittedAt: new Date(),
          },
          include: cycleCountInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_CYCLE_COUNT_SUBMITTED",
          entityType: "CycleCountSession",
          entityId: id,
          requestId: request.id,
          metadata: {
            lineCount: updated.lines.length,
            discrepancyCount: updated.lines.filter(
              (line) => line.discrepancy && !line.discrepancy.eq(0),
            ).length,
          },
        });

        return updated;
      });

      return { session: presentCycleCount(submitted) };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/inventory/cycle-counts/:id/review", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as ReviewCycleCountBody;
      const reviewNote = body.reviewNote?.trim();

      if (
        (body.decision !== "APPROVE" && body.decision !== "REJECT") ||
        !reviewNote
      ) {
        return reply.code(400).send({
          error: "A review decision and review note are required.",
        });
      }

      const session = await getCycleCount(id, actor.siteId);
      if (!session) {
        return reply.code(404).send({ error: "Cycle count not found." });
      }

      if (session.status !== "SUBMITTED") {
        return reply.code(409).send({
          error: "Only a submitted cycle count can be reviewed.",
          code: "CYCLE_COUNT_NOT_SUBMITTED",
        });
      }

      if (body.decision === "REJECT") {
        const rejected = await db.$transaction(async (tx) => {
          const updated = await tx.cycleCountSession.update({
            where: { id },
            data: {
              status: "REJECTED",
              reviewedById: actor.id,
              reviewedAt: new Date(),
              reviewNote,
            },
            include: cycleCountInclude,
          });

          await writeAuditEvent(tx, {
            siteId: actor.siteId,
            actorId: actor.id,
            action: "INVENTORY_CYCLE_COUNT_REJECTED",
            entityType: "CycleCountSession",
            entityId: id,
            requestId: request.id,
            metadata: {
              reviewNote,
              lineCount: updated.lines.length,
            },
          });

          return updated;
        });

        return { session: presentCycleCount(rejected) };
      }

      const approved = await db.$transaction(async (tx) => {
        const fresh = await tx.cycleCountSession.findFirst({
          where: { id, siteId: actor.siteId, status: "SUBMITTED" },
          include: {
            lines: {
              orderBy: { createdAt: "asc" },
            },
          },
        });

        if (!fresh) {
          throw new InventoryError(
            409,
            "CYCLE_COUNT_NOT_SUBMITTED",
            "The cycle count is no longer awaiting review.",
          );
        }

        for (const line of fresh.lines) {
          if (
            line.countedQuantity === null ||
            line.expectedOnHand === null ||
            line.expectedReserved === null ||
            line.countedAt === null
          ) {
            throw new InventoryError(
              409,
              "CYCLE_COUNT_INCOMPLETE",
              "Every cycle count line must be counted before approval.",
              { lineId: line.id },
            );
          }

          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "InventoryBalance" WHERE "id" = ${line.inventoryBalanceId} FOR UPDATE`,
          );

          const balance = await tx.inventoryBalance.findUniqueOrThrow({
            where: { id: line.inventoryBalanceId },
          });

          const laterMovement = await tx.inventoryTransaction.findFirst({
            where: {
              inventoryBalanceId: line.inventoryBalanceId,
              occurredAt: { gt: line.countedAt },
            },
            orderBy: { occurredAt: "asc" },
          });

          if (
            laterMovement ||
            !balance.onHandQuantity.eq(line.expectedOnHand) ||
            !balance.reservedQuantity.eq(line.expectedReserved)
          ) {
            throw new InventoryError(
              409,
              "CYCLE_COUNT_STALE",
              "Inventory changed after a physical count was recorded. Recount the affected balance before approval.",
              {
                lineId: line.id,
                inventoryBalanceId: line.inventoryBalanceId,
                countedAt: line.countedAt.toISOString(),
                currentOnHand: balance.onHandQuantity.toString(),
                expectedOnHand: line.expectedOnHand.toString(),
                currentReserved: balance.reservedQuantity.toString(),
                expectedReserved: line.expectedReserved.toString(),
                laterMovementId: laterMovement?.id ?? null,
              },
            );
          }

          const delta = line.countedQuantity.minus(balance.onHandQuantity);
          let reconciledTransactionId: string | null = null;

          if (!delta.eq(0)) {
            const adjusted = await adjustInventoryBalance(tx, {
              balanceId: line.inventoryBalanceId,
              siteId: actor.siteId,
              actorId: actor.id,
              delta,
              reason: `Cycle count reconciliation: ${reviewNote}`,
              source: "CYCLE_COUNT",
              reference: id,
            });
            reconciledTransactionId = adjusted.transaction.id;

            await writeAuditEvent(tx, {
              siteId: actor.siteId,
              actorId: actor.id,
              action: "INVENTORY_CYCLE_COUNT_ADJUSTED",
              entityType: "InventoryBalance",
              entityId: line.inventoryBalanceId,
              requestId: request.id,
              metadata: {
                cycleCountId: id,
                cycleCountLineId: line.id,
                expectedOnHand: line.expectedOnHand.toString(),
                countedQuantity: line.countedQuantity.toString(),
                delta: delta.toString(),
                inventoryTransactionId: reconciledTransactionId,
                reviewNote,
              },
            });
          }

          await tx.cycleCountLine.update({
            where: { id: line.id },
            data: {
              discrepancy: delta,
              reconciledTransactionId,
            },
          });
        }

        const updated = await tx.cycleCountSession.update({
          where: { id },
          data: {
            status: "APPROVED",
            reviewedById: actor.id,
            reviewedAt: new Date(),
            reviewNote,
          },
          include: cycleCountInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_CYCLE_COUNT_APPROVED",
          entityType: "CycleCountSession",
          entityId: id,
          requestId: request.id,
          metadata: {
            reviewNote,
            lineCount: updated.lines.length,
            adjustedLineCount: updated.lines.filter(
              (line) => line.reconciledTransactionId !== null,
            ).length,
          },
        });

        return updated;
      });

      return { session: presentCycleCount(approved) };
    } catch (error) {
      if (error instanceof AccessError || error instanceof InventoryError) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(error instanceof InventoryError
            ? { code: error.code, details: error.details }
            : {}),
        });
      }
      throw error;
    }
  });
}
