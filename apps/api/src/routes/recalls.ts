import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import {
  InventoryError,
  quarantineInventory,
  releaseInventoryReservation,
} from "../inventory.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type CreateRecallBody = {
  productLotId?: string;
  source?: string;
  referenceNumber?: string;
  reason?: string;
};

type CloseRecallBody = {
  closureNote?: string;
};

const recallInclude = {
  product: {
    include: {
      medication: true,
      manufacturer: true,
    },
  },
  productLot: true,
  initiatedBy: {
    select: {
      id: true,
      displayName: true,
      role: true,
    },
  },
  closedBy: {
    select: {
      id: true,
      displayName: true,
      role: true,
    },
  },
  holds: {
    include: {
      inventoryBalance: {
        include: {
          productExpiration: true,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
  affectedFills: {
    include: {
      fill: {
        include: {
          prescription: {
            include: {
              patient: true,
              prescriber: true,
            },
          },
          productExpiration: true,
        },
      },
    },
    orderBy: { identifiedAt: "asc" as const },
  },
};

type RecallWithDetails = Prisma.InventoryRecallGetPayload<{
  include: typeof recallInclude;
}>;

function presentRecall(recall: RecallWithDetails) {
  return {
    ...recall,
    holds: recall.holds.map((hold) => ({
      ...hold,
      quantity: hold.quantity.toString(),
      inventoryBalance: {
        ...hold.inventoryBalance,
        onHandQuantity: hold.inventoryBalance.onHandQuantity.toString(),
        reservedQuantity: hold.inventoryBalance.reservedQuantity.toString(),
        quarantinedQuantity:
          hold.inventoryBalance.quarantinedQuantity.toString(),
      },
    })),
    summary: {
      affectedFillCount: recall.affectedFills.length,
      soldFillCount: recall.affectedFills.filter(
        (affected) => affected.fillStatusAtIdentification === "SOLD",
      ).length,
      readyFillCount: recall.affectedFills.filter(
        (affected) => affected.fillStatusAtIdentification === "READY",
      ).length,
      activeFillCount: recall.affectedFills.filter((affected) =>
        ["SCHEDULED", "IN_PROGRESS"].includes(
          affected.fillStatusAtIdentification,
        ),
      ).length,
      quarantinedQuantity: recall.holds
        .filter((hold) => hold.status === "ACTIVE")
        .reduce((sum, hold) => sum + Number(hold.quantity.toString()), 0),
    },
  };
}

async function getRecall(id: string, siteId: string) {
  return db.inventoryRecall.findFirst({
    where: { id, siteId },
    include: recallInclude,
  });
}

export async function recallRoutes(app: FastifyInstance) {
  app.get("/inventory/recalls", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const recalls = await db.inventoryRecall.findMany({
        where: { siteId: actor.siteId },
        include: recallInclude,
        orderBy: { initiatedAt: "desc" },
        take: 100,
      });

      return { recalls: recalls.map(presentRecall) };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/inventory/recalls/:id", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const id = (request.params as { id: string }).id;
      const recall = await getRecall(id, actor.siteId);

      if (!recall) {
        return reply.code(404).send({ error: "Inventory recall not found." });
      }

      return { recall: presentRecall(recall) };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/inventory/recalls", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const body = (request.body ?? {}) as CreateRecallBody;
      const productLotId = body.productLotId?.trim();
      const reason = body.reason?.trim();

      if (!productLotId || !reason) {
        return reply.code(400).send({
          error: "productLotId and a recall reason are required.",
        });
      }

      const lot = await db.productLot.findFirst({
        where: {
          id: productLotId,
          siteId: actor.siteId,
        },
        include: {
          product: {
            include: {
              medication: true,
              manufacturer: true,
            },
          },
        },
      });

      if (!lot) {
        return reply.code(404).send({
          error: "Product lot not found at this pharmacy site.",
        });
      }

      const existing = await db.inventoryRecall.findFirst({
        where: {
          siteId: actor.siteId,
          productLotId,
          status: "OPEN",
        },
        select: {
          id: true,
          referenceNumber: true,
        },
      });

      if (existing) {
        return reply.code(409).send({
          error: "This lot already has an open recall.",
          code: "RECALL_ALREADY_OPEN",
          recallId: existing.id,
          referenceNumber: existing.referenceNumber,
        });
      }

      const recallId = await db.$transaction(async (tx) => {
        const recall = await tx.inventoryRecall.create({
          data: {
            siteId: actor.siteId,
            productId: lot.productId,
            productLotId,
            source: body.source?.trim() || null,
            referenceNumber: body.referenceNumber?.trim() || null,
            reason,
            initiatedById: actor.id,
          },
        });

        const affectedFills = await tx.prescriptionFill.findMany({
          where: {
            productId: lot.productId,
            productLotId,
            prescription: {
              siteId: actor.siteId,
            },
          },
          include: {
            prescription: {
              select: {
                id: true,
                status: true,
                heldFromStatus: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        });

        if (affectedFills.length > 0) {
          await tx.inventoryRecallAffectedFill.createMany({
            data: affectedFills.map((fill) => ({
              recallId: recall.id,
              fillId: fill.id,
              fillStatusAtIdentification: fill.status,
              prescriptionStatusAtIdentification: fill.prescription.status,
            })),
          });
        }

        const invalidatedFillIds: string[] = [];
        const resetPrescriptionIds = new Set<string>();

        for (const fill of affectedFills) {
          if (
            fill.inventoryReservedAt &&
            !fill.inventoryCommittedAt &&
            fill.inventoryBalanceId
          ) {
            await releaseInventoryReservation(tx, {
              fillId: fill.id,
              siteId: actor.siteId,
              actorId: actor.id,
              reason: `Reservation released because lot ${lot.lotNumber} entered recall.`,
            });

            await tx.prescriptionFill.update({
              where: { id: fill.id },
              data: {
                productId: null,
                productLotId: null,
                productExpirationId: null,
                scannedNdc: null,
                scannedLotNumber: null,
                scannedExpiration: null,
                productVerifiedAt: null,
                inventoryBalanceId: null,
                inventoryReservedAt: null,
                inventoryCommittedAt: null,
                inventoryReturnedAt: null,
              },
            });

            invalidatedFillIds.push(fill.id);

            if (fill.prescription.status === "PHARMACIST_REVIEW") {
              await tx.prescription.update({
                where: { id: fill.prescription.id },
                data: { status: "PRODUCT_FILL" },
              });
              resetPrescriptionIds.add(fill.prescription.id);
            } else if (
              fill.prescription.status === "ON_HOLD" &&
              fill.prescription.heldFromStatus === "PHARMACIST_REVIEW"
            ) {
              await tx.prescription.update({
                where: { id: fill.prescription.id },
                data: { heldFromStatus: "PRODUCT_FILL" },
              });
              resetPrescriptionIds.add(fill.prescription.id);
            }
          }
        }

        const balances = await tx.inventoryBalance.findMany({
          where: {
            siteId: actor.siteId,
            productId: lot.productId,
            productLotId,
          },
          orderBy: { createdAt: "asc" },
        });

        const quarantineHoldIds: string[] = [];
        let quarantinedQuantity = new Prisma.Decimal(0);

        for (const balance of balances) {
          const available = balance.onHandQuantity
            .minus(balance.reservedQuantity)
            .minus(balance.quarantinedQuantity);

          if (available.lte(0)) continue;

          const quarantined = await quarantineInventory(tx, {
            balanceId: balance.id,
            siteId: actor.siteId,
            actorId: actor.id,
            quantity: available,
            reasonCode: "RECALL",
            note: `Automatically quarantined when lot ${lot.lotNumber} entered recall.`,
            recallId: recall.id,
          });
          quarantineHoldIds.push(quarantined.hold.id);
          quarantinedQuantity = quarantinedQuantity.plus(available);
        }

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_RECALL_OPENED",
          entityType: "InventoryRecall",
          entityId: recall.id,
          requestId: request.id,
          metadata: {
            productId: lot.productId,
            ndc: lot.product.ndc,
            productLotId,
            lotNumber: lot.lotNumber,
            source: recall.source,
            referenceNumber: recall.referenceNumber,
            reason,
            affectedFillIds: affectedFills.map((fill) => fill.id),
            invalidatedFillIds,
            resetPrescriptionIds: [...resetPrescriptionIds],
            quarantineHoldIds,
            quarantinedQuantity: quarantinedQuantity.toString(),
          },
        });

        return recall.id;
      });

      const recall = await getRecall(recallId, actor.siteId);
      if (!recall) {
        throw new Error("Recall was created but could not be reloaded.");
      }

      return reply.code(201).send({
        recall: presentRecall(recall),
      });
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

  app.post("/inventory/recalls/:id/close", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as CloseRecallBody;
      const closureNote = body.closureNote?.trim();

      if (!closureNote) {
        return reply.code(400).send({
          error: "A recall closure note is required.",
        });
      }

      const current = await db.inventoryRecall.findFirst({
        where: {
          id,
          siteId: actor.siteId,
        },
      });

      if (!current) {
        return reply.code(404).send({ error: "Inventory recall not found." });
      }

      if (current.status !== "OPEN") {
        return reply.code(409).send({
          error: "Only an open recall can be closed.",
          code: "RECALL_NOT_OPEN",
        });
      }

      await db.$transaction(async (tx) => {
        await tx.inventoryRecall.update({
          where: { id },
          data: {
            status: "CLOSED",
            closedById: actor.id,
            closedAt: new Date(),
            closureNote,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_RECALL_CLOSED",
          entityType: "InventoryRecall",
          entityId: id,
          requestId: request.id,
          metadata: {
            productId: current.productId,
            productLotId: current.productLotId,
            referenceNumber: current.referenceNumber,
            closureNote,
            quarantinedStockAutomaticallyReleased: false,
          },
        });
      });

      const recall = await getRecall(id, actor.siteId);
      if (!recall) {
        throw new Error("Recall was closed but could not be reloaded.");
      }

      return {
        recall: presentRecall(recall),
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
}
