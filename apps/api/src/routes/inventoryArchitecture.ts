import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import {
  InventoryArchitectureError,
  moveInventoryPosition,
} from "../inventoryArchitecture.js";
import {
  AccessError,
  resolveDevelopmentActor,
} from "../security/devIdentity.js";

type LocationBody = {
  code?: string;
  name?: string;
  type?: string;
  temperatureMinC?: number | null;
  temperatureMaxC?: number | null;
  pickPriority?: number;
};

type LocationMoveBody = {
  inventoryBalanceId?: string;
  fromLocationId?: string;
  toLocationId?: string;
  quantity?: number;
  reason?: string;
};

type PolicyBody = {
  medicationId?: string | null;
  productId?: string | null;
  reorderPoint?: number | null;
  parLevel?: number | null;
  minShelfLifeDays?: number | null;
  expirationWarningDays?: number;
  fefoEnabled?: boolean;
  preferredSupplierName?: string | null;
  adjustmentApprovalThreshold?: number | null;
  requireTransferSecondCheck?: boolean;
  staleReservationHours?: number;
};

type DemandBody = {
  medicationId?: string;
  preferredProductId?: string | null;
  quantityRequired?: number;
  dueAt?: string | null;
  note?: string;
  reason?: "SHORTAGE" | "SCHEDULED_FILL" | "MANUAL";
};

type LinkDemandBody = {
  purchaseOrderLineId?: string;
  quantityPlanned?: number;
};

type DiscrepancyBody = {
  purchaseOrderLineId?: string | null;
  purchaseOrderReceiptId?: string | null;
  type?: string;
  expectedQuantity?: number | null;
  observedQuantity?: number | null;
  detail?: string;
};

type ResolveDiscrepancyBody = {
  resolutionNote?: string;
  status?: "RESOLVED" | "DISMISSED";
};

type CustodyBody = {
  type?: "PACKED" | "VERIFIED" | "HANDED_OFF" | "RECEIVED" | "DISCREPANCY_REPORTED" | "CANCELLED";
  carrier?: string;
  trackingReference?: string;
  sealIdentifier?: string;
  note?: string;
};

function decimalString(value: Prisma.Decimal | null | undefined) {
  return value?.toString() ?? null;
}

function sendKnownError(reply: any, error: unknown) {
  if (
    error instanceof AccessError ||
    error instanceof InventoryArchitectureError
  ) {
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error instanceof InventoryArchitectureError
        ? { code: error.code, details: error.details }
        : {}),
    });
  }

  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return reply.code(409).send({
      error: "A record with that unique identifier already exists.",
      code: "DUPLICATE_RECORD",
    });
  }

  throw error;
}

async function policyFor(
  siteId: string,
  input: { medicationId?: string | null; productId?: string | null },
) {
  const keys = [
    input.productId ? `PRODUCT:${input.productId}` : null,
    input.medicationId ? `MEDICATION:${input.medicationId}` : null,
    "SITE",
  ].filter(Boolean) as string[];

  const policies = await db.inventoryPolicy.findMany({
    where: {
      siteId,
      policyKey: { in: keys },
    },
  });

  return (
    keys
      .map((key) => policies.find((policy) => policy.policyKey === key))
      .find(Boolean) ?? null
  );
}

export async function inventoryArchitectureRoutes(app: FastifyInstance) {
  app.get("/inventory/locations", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const locations = await db.inventoryLocation.findMany({
        where: { siteId: actor.siteId },
        include: {
          positions: {
            where: { quantity: { gt: 0 } },
            include: {
              inventoryBalance: {
                include: {
                  product: {
                    include: { medication: true, manufacturer: true },
                  },
                  productLot: true,
                  productExpiration: true,
                },
              },
            },
          },
        },
        orderBy: [{ pickPriority: "asc" }, { code: "asc" }],
      });
      return { locations };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/locations", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const body = (request.body ?? {}) as LocationBody;
      const code = body.code?.trim().toUpperCase();
      const name = body.name?.trim();
      const allowedTypes = new Set([
        "DISPENSING",
        "RECEIVING",
        "REFRIGERATOR",
        "FREEZER",
        "SAFE",
        "QUARANTINE",
        "RETURN_TO_VENDOR",
        "OVERFLOW",
        "UNASSIGNED",
        "OTHER",
      ]);

      if (!code || !name || !body.type || !allowedTypes.has(body.type)) {
        return reply.code(400).send({
          error: "Location code, name, and valid location type are required.",
        });
      }

      const location = await db.$transaction(async (tx) => {
        const created = await tx.inventoryLocation.create({
          data: {
            siteId: actor.siteId,
            code,
            name,
            type: body.type as any,
            temperatureMinC: body.temperatureMinC ?? null,
            temperatureMaxC: body.temperatureMaxC ?? null,
            pickPriority:
              typeof body.pickPriority === "number" &&
              Number.isInteger(body.pickPriority)
                ? body.pickPriority
                : 100,
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_LOCATION_CREATED",
          entityType: "InventoryLocation",
          entityId: created.id,
          requestId: request.id,
          metadata: { code, name, type: body.type },
        });
        return created;
      });

      return reply.code(201).send({ location });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/locations/move", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as LocationMoveBody;
      const reason = body.reason?.trim();

      if (
        !body.inventoryBalanceId ||
        !body.fromLocationId ||
        !body.toLocationId ||
        typeof body.quantity !== "number" ||
        !Number.isFinite(body.quantity) ||
        body.quantity <= 0 ||
        !reason
      ) {
        return reply.code(400).send({
          error:
            "Balance, source location, destination location, positive quantity, and reason are required.",
        });
      }

      const result = await db.$transaction(async (tx) => {
        const moved = await moveInventoryPosition(tx, {
          siteId: actor.siteId,
          balanceId: body.inventoryBalanceId!,
          fromLocationId: body.fromLocationId!,
          toLocationId: body.toLocationId!,
          quantity: body.quantity!,
          actorId: actor.id,
          reason,
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_LOCATION_MOVED",
          entityType: "InventoryBalance",
          entityId: body.inventoryBalanceId!,
          requestId: request.id,
          metadata: {
            fromLocationId: body.fromLocationId,
            toLocationId: body.toLocationId,
            quantity: body.quantity,
            reason,
            movementId: moved.movement.id,
          },
        });
        return moved;
      });

      return result;
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/inventory/policies", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const policies = await db.inventoryPolicy.findMany({
        where: { siteId: actor.siteId },
        include: {
          medication: true,
          product: {
            include: { medication: true, manufacturer: true },
          },
        },
        orderBy: { policyKey: "asc" },
      });
      return { policies };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.put("/inventory/policies/:policyKey", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const policyKey = decodeURIComponent(
        (request.params as { policyKey: string }).policyKey,
      ).trim();
      const body = (request.body ?? {}) as PolicyBody;

      if (
        !policyKey ||
        (body.reorderPoint !== undefined &&
          body.reorderPoint !== null &&
          body.reorderPoint < 0) ||
        (body.parLevel !== undefined &&
          body.parLevel !== null &&
          body.parLevel < 0) ||
        (body.minShelfLifeDays !== undefined &&
          body.minShelfLifeDays !== null &&
          body.minShelfLifeDays < 0) ||
        (body.expirationWarningDays !== undefined &&
          body.expirationWarningDays < 0) ||
        (body.staleReservationHours !== undefined &&
          body.staleReservationHours < 1)
      ) {
        return reply.code(400).send({ error: "Invalid inventory policy." });
      }

      const policy = await db.$transaction(async (tx) => {
        const updated = await tx.inventoryPolicy.upsert({
          where: {
            siteId_policyKey: {
              siteId: actor.siteId,
              policyKey,
            },
          },
          update: {
            medicationId: body.medicationId ?? null,
            productId: body.productId ?? null,
            reorderPoint: body.reorderPoint ?? null,
            parLevel: body.parLevel ?? null,
            minShelfLifeDays: body.minShelfLifeDays ?? null,
            expirationWarningDays: body.expirationWarningDays ?? 90,
            fefoEnabled: body.fefoEnabled ?? true,
            preferredSupplierName:
              body.preferredSupplierName?.trim() || null,
            adjustmentApprovalThreshold:
              body.adjustmentApprovalThreshold ?? null,
            requireTransferSecondCheck:
              body.requireTransferSecondCheck ?? false,
            staleReservationHours: body.staleReservationHours ?? 24,
          },
          create: {
            siteId: actor.siteId,
            policyKey,
            medicationId: body.medicationId ?? null,
            productId: body.productId ?? null,
            reorderPoint: body.reorderPoint ?? null,
            parLevel: body.parLevel ?? null,
            minShelfLifeDays: body.minShelfLifeDays ?? null,
            expirationWarningDays: body.expirationWarningDays ?? 90,
            fefoEnabled: body.fefoEnabled ?? true,
            preferredSupplierName:
              body.preferredSupplierName?.trim() || null,
            adjustmentApprovalThreshold:
              body.adjustmentApprovalThreshold ?? null,
            requireTransferSecondCheck:
              body.requireTransferSecondCheck ?? false,
            staleReservationHours: body.staleReservationHours ?? 24,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_POLICY_UPDATED",
          entityType: "InventoryPolicy",
          entityId: updated.id,
          requestId: request.id,
          metadata: { policyKey },
        });
        return updated;
      });

      return { policy };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/inventory/demands", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const demands = await db.inventoryDemand.findMany({
        where: { siteId: actor.siteId },
        include: {
          medication: true,
          preferredProduct: { include: { manufacturer: true } },
          fill: {
            include: {
              prescription: { include: { patient: true } },
            },
          },
          supplyLinks: {
            include: {
              purchaseOrderLine: {
                include: {
                  product: {
                    include: { medication: true, manufacturer: true },
                  },
                  purchaseOrder: true,
                },
              },
            },
          },
        },
        orderBy: [{ status: "asc" }, { dueAt: "asc" }, { createdAt: "asc" }],
      });
      return { demands };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/demands", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as DemandBody;
      const dueAt = body.dueAt ? new Date(body.dueAt) : null;
      if (
        !body.medicationId ||
        typeof body.quantityRequired !== "number" ||
        !Number.isFinite(body.quantityRequired) ||
        body.quantityRequired <= 0 ||
        (dueAt && Number.isNaN(dueAt.getTime()))
      ) {
        return reply.code(400).send({
          error: "Medication and positive demand quantity are required.",
        });
      }

      const demand = await db.inventoryDemand.create({
        data: {
          siteId: actor.siteId,
          medicationId: body.medicationId,
          preferredProductId: body.preferredProductId ?? null,
          reason: body.reason ?? "MANUAL",
          quantityRequired: body.quantityRequired,
          dueAt,
          note: body.note?.trim() || null,
        },
      });
      return reply.code(201).send({ demand });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/demands/:id/link-po-line", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as LinkDemandBody;
      if (
        !body.purchaseOrderLineId ||
        typeof body.quantityPlanned !== "number" ||
        !Number.isFinite(body.quantityPlanned) ||
        body.quantityPlanned <= 0
      ) {
        return reply.code(400).send({
          error: "Purchase-order line and positive planned quantity are required.",
        });
      }

      const demand = await db.inventoryDemand.findFirst({
        where: { id, siteId: actor.siteId },
      });
      const line = await db.purchaseOrderLine.findFirst({
        where: {
          id: body.purchaseOrderLineId,
          purchaseOrder: { siteId: actor.siteId },
        },
        include: { product: true },
      });
      if (!demand || !line) {
        return reply.code(404).send({ error: "Demand or PO line not found." });
      }

      const medication = await db.product.findUnique({
        where: { id: line.productId },
        select: { medicationId: true },
      });
      if (medication?.medicationId !== demand.medicationId) {
        return reply.code(409).send({
          error: "PO line product does not match the medication demand.",
          code: "DEMAND_PRODUCT_MISMATCH",
        });
      }

      const remaining = demand.quantityRequired.minus(demand.quantitySatisfied);
      if (new Prisma.Decimal(body.quantityPlanned).gt(remaining)) {
        return reply.code(409).send({
          error: "Planned supply exceeds remaining demand.",
          code: "DEMAND_OVERALLOCATION",
        });
      }

      const link = await db.inventoryDemandSupplyLink.upsert({
        where: {
          inventoryDemandId_purchaseOrderLineId: {
            inventoryDemandId: demand.id,
            purchaseOrderLineId: line.id,
          },
        },
        update: { quantityPlanned: body.quantityPlanned },
        create: {
          inventoryDemandId: demand.id,
          purchaseOrderLineId: line.id,
          quantityPlanned: body.quantityPlanned,
        },
      });
      return { link };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/demands/:id/cancel", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const id = (request.params as { id: string }).id;
      const demand = await db.inventoryDemand.findFirst({
        where: { id, siteId: actor.siteId },
      });
      if (!demand) {
        return reply.code(404).send({ error: "Inventory demand not found." });
      }
      const updated = await db.inventoryDemand.update({
        where: { id },
        data: { status: "CANCELLED" },
      });
      return { demand: updated };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/inventory/recommendations", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const query = request.query as {
        medicationId?: string;
        productId?: string;
        quantity?: string;
      };
      const quantity = Number(query.quantity ?? 0);
      if (
        (!query.medicationId && !query.productId) ||
        !Number.isFinite(quantity) ||
        quantity <= 0
      ) {
        return reply.code(400).send({
          error: "medicationId or productId plus a positive quantity is required.",
        });
      }

      const balances = await db.inventoryBalance.findMany({
        where: {
          siteId: actor.siteId,
          ...(query.productId
            ? { productId: query.productId }
            : { product: { medicationId: query.medicationId } }),
          onHandQuantity: { gt: 0 },
        },
        include: {
          product: {
            include: { medication: true, manufacturer: true },
          },
          productLot: true,
          productExpiration: true,
          positions: {
            where: { quantity: { gt: 0 } },
            include: { location: true },
          },
        },
      });

      const now = Date.now();
      const candidates = [];
      for (const balance of balances) {
        const available = balance.onHandQuantity
          .minus(balance.reservedQuantity)
          .minus(balance.quarantinedQuantity);
        if (available.lte(0)) continue;

        const policy = await policyFor(actor.siteId, {
          medicationId: balance.product.medicationId,
          productId: balance.productId,
        });
        const daysToExpiration = Math.floor(
          (balance.productExpiration.expirationDate.getTime() - now) /
            86_400_000,
        );
        if (
          policy?.minShelfLifeDays !== null &&
          policy?.minShelfLifeDays !== undefined &&
          daysToExpiration < policy.minShelfLifeDays
        ) {
          continue;
        }

        candidates.push({
          balance,
          available,
          daysToExpiration,
          policy,
        });
      }

      candidates.sort((a, b) => {
        const fefo = a.policy?.fefoEnabled ?? true;
        if (fefo) {
          const expirationDiff =
            a.balance.productExpiration.expirationDate.getTime() -
            b.balance.productExpiration.expirationDate.getTime();
          if (expirationDiff !== 0) return expirationDiff;
        }
        return Number(b.available.minus(a.available).toString());
      });

      let needed = new Prisma.Decimal(quantity);
      const recommendation = candidates.map((candidate) => {
        const allocate = Prisma.Decimal.min(candidate.available, needed);
        needed = Prisma.Decimal.max(new Prisma.Decimal(0), needed.minus(allocate));
        return {
          balanceId: candidate.balance.id,
          product: candidate.balance.product,
          lot: candidate.balance.productLot,
          expiration: candidate.balance.productExpiration,
          availableQuantity: candidate.available.toString(),
          suggestedQuantity: allocate.toString(),
          daysToExpiration: candidate.daysToExpiration,
          locations: candidate.balance.positions.map((position) => ({
            id: position.location.id,
            code: position.location.code,
            name: position.location.name,
            type: position.location.type,
            quantity: position.quantity.toString(),
          })),
        };
      });

      return {
        requestedQuantity: String(quantity),
        shortageQuantity: needed.toString(),
        recommendation,
      };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/inventory/balances/:id/as-of", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const id = (request.params as { id: string }).id;
      const query = request.query as { at?: string };
      const at = query.at ? new Date(query.at) : new Date();
      if (Number.isNaN(at.getTime())) {
        return reply.code(400).send({ error: "Invalid as-of timestamp." });
      }

      const balance = await db.inventoryBalance.findFirst({
        where: { id, siteId: actor.siteId },
        include: {
          product: { include: { medication: true, manufacturer: true } },
          productLot: true,
          productExpiration: true,
        },
      });
      if (!balance) {
        return reply.code(404).send({ error: "Inventory balance not found." });
      }

      const transactions = await db.inventoryTransaction.findMany({
        where: {
          inventoryBalanceId: id,
          occurredAt: { lte: at },
        },
        orderBy: { occurredAt: "asc" },
      });

      const snapshot = transactions.reduce(
        (state, transaction) => ({
          onHand: state.onHand.plus(transaction.onHandDelta),
          reserved: state.reserved.plus(transaction.reservedDelta),
          quarantined: state.quarantined.plus(transaction.quarantinedDelta),
        }),
        {
          onHand: new Prisma.Decimal(0),
          reserved: new Prisma.Decimal(0),
          quarantined: new Prisma.Decimal(0),
        },
      );

      return {
        at: at.toISOString(),
        balance,
        snapshot: {
          onHandQuantity: snapshot.onHand.toString(),
          reservedQuantity: snapshot.reserved.toString(),
          quarantinedQuantity: snapshot.quarantined.toString(),
          availableQuantity: snapshot.onHand
            .minus(snapshot.reserved)
            .minus(snapshot.quarantined)
            .toString(),
        },
      };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/inventory/receiving-discrepancies", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const discrepancies = await db.receivingDiscrepancy.findMany({
        where: { siteId: actor.siteId },
        include: {
          createdBy: {
            select: { id: true, displayName: true, role: true },
          },
          resolvedBy: {
            select: { id: true, displayName: true, role: true },
          },
          purchaseOrderLine: {
            include: {
              product: {
                include: { medication: true, manufacturer: true },
              },
              purchaseOrder: true,
            },
          },
          purchaseOrderReceipt: true,
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      });
      return { discrepancies };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/receiving-discrepancies", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as DiscrepancyBody;
      const allowed = new Set([
        "SHORT_SHIPMENT",
        "OVERAGE",
        "WRONG_PRODUCT",
        "DAMAGED_PRODUCT",
        "LOT_EXPIRATION_MISMATCH",
        "INVOICE_MISMATCH",
        "DUPLICATE_SHIPMENT",
        "UNPLANNED_RECEIPT",
        "OTHER",
      ]);
      if (!body.type || !allowed.has(body.type) || !body.detail?.trim()) {
        return reply.code(400).send({
          error: "Valid discrepancy type and detail are required.",
        });
      }

      const discrepancy = await db.receivingDiscrepancy.create({
        data: {
          siteId: actor.siteId,
          purchaseOrderLineId: body.purchaseOrderLineId ?? null,
          purchaseOrderReceiptId: body.purchaseOrderReceiptId ?? null,
          type: body.type as any,
          expectedQuantity: body.expectedQuantity ?? null,
          observedQuantity: body.observedQuantity ?? null,
          detail: body.detail.trim(),
          createdById: actor.id,
        },
      });
      return reply.code(201).send({ discrepancy });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post(
    "/inventory/receiving-discrepancies/:id/resolve",
    async (request, reply) => {
      try {
        const actor = await resolveDevelopmentActor(
          request,
          "inventory:correct",
        );
        const id = (request.params as { id: string }).id;
        const body = (request.body ?? {}) as ResolveDiscrepancyBody;
        const note = body.resolutionNote?.trim();
        if (
          !note ||
          (body.status !== "RESOLVED" && body.status !== "DISMISSED")
        ) {
          return reply.code(400).send({
            error: "Resolution status and note are required.",
          });
        }

        const existing = await db.receivingDiscrepancy.findFirst({
          where: { id, siteId: actor.siteId },
        });
        if (!existing) {
          return reply.code(404).send({ error: "Discrepancy not found." });
        }

        const discrepancy = await db.receivingDiscrepancy.update({
          where: { id },
          data: {
            status: body.status,
            resolvedById: actor.id,
            resolvedAt: new Date(),
            resolutionNote: note,
          },
        });
        return { discrepancy };
      } catch (error) {
        return sendKnownError(reply, error);
      }
    },
  );

  app.get("/inventory/transfers/:id/custody-events", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const id = (request.params as { id: string }).id;
      const transfer = await db.inventoryTransfer.findFirst({
        where: {
          id,
          OR: [
            { sourceSiteId: actor.siteId },
            { destinationSiteId: actor.siteId },
          ],
        },
      });
      if (!transfer) {
        return reply.code(404).send({ error: "Transfer not found." });
      }
      const events = await db.inventoryTransferCustodyEvent.findMany({
        where: { inventoryTransferId: id },
        include: {
          actor: { select: { id: true, displayName: true, role: true } },
        },
        orderBy: { occurredAt: "asc" },
      });
      return { events };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/transfers/:id/custody-events", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as CustodyBody;
      const permission = body.type === "VERIFIED"
        ? "inventory:correct"
        : "inventory:write";
      const actor = await resolveDevelopmentActor(request, permission);
      const id = (request.params as { id: string }).id;
      const allowed = new Set([
        "PACKED",
        "VERIFIED",
        "HANDED_OFF",
        "RECEIVED",
        "DISCREPANCY_REPORTED",
        "CANCELLED",
      ]);
      if (!body.type || !allowed.has(body.type)) {
        return reply.code(400).send({ error: "Valid custody event type is required." });
      }

      const transfer = await db.inventoryTransfer.findFirst({
        where: {
          id,
          OR: [
            { sourceSiteId: actor.siteId },
            { destinationSiteId: actor.siteId },
          ],
        },
      });
      if (!transfer) {
        return reply.code(404).send({ error: "Transfer not found." });
      }

      if (body.type === "VERIFIED" && transfer.initiatedById === actor.id) {
        return reply.code(409).send({
          error: "Second-person transfer verification must be performed by a different user.",
          code: "TRANSFER_SELF_VERIFICATION",
        });
      }

      const event = await db.inventoryTransferCustodyEvent.create({
        data: {
          inventoryTransferId: id,
          type: body.type,
          actorId: actor.id,
          carrier: body.carrier?.trim() || null,
          trackingReference: body.trackingReference?.trim() || null,
          sealIdentifier: body.sealIdentifier?.trim() || null,
          note: body.note?.trim() || null,
        },
      });
      return reply.code(201).send({ event });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/inventory/intelligence", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const now = new Date();
      const [
        balances,
        policies,
        demands,
        transfers,
        purchaseOrders,
        discrepancies,
      ] = await Promise.all([
        db.inventoryBalance.findMany({
          where: { siteId: actor.siteId },
          include: {
            product: {
              include: { medication: true, manufacturer: true },
            },
            productLot: true,
            productExpiration: true,
            positions: { include: { location: true } },
            inventoryCostLayers: {
              where: { quantityRemaining: { gt: 0 } },
            },
            fills: {
              where: {
                inventoryReservedAt: { not: null },
                inventoryCommittedAt: null,
              },
              select: {
                id: true,
                inventoryReservedAt: true,
                quantity: true,
              },
            },
          },
        }),
        db.inventoryPolicy.findMany({
          where: { siteId: actor.siteId },
        }),
        db.inventoryDemand.findMany({
          where: {
            siteId: actor.siteId,
            status: { in: ["OPEN", "PARTIALLY_SATISFIED"] },
          },
          include: { medication: true },
          orderBy: { dueAt: "asc" },
        }),
        db.inventoryTransfer.findMany({
          where: {
            OR: [
              { sourceSiteId: actor.siteId },
              { destinationSiteId: actor.siteId },
            ],
            status: "IN_TRANSIT",
          },
          include: { sourceSite: true, destinationSite: true },
        }),
        db.purchaseOrder.findMany({
          where: {
            siteId: actor.siteId,
            status: { in: ["OPEN", "PARTIALLY_RECEIVED"] },
          },
        }),
        db.receivingDiscrepancy.findMany({
          where: { siteId: actor.siteId, status: "OPEN" },
        }),
      ]);

      const policyMap = new Map(policies.map((policy) => [policy.policyKey, policy]));
      const exceptions: Array<Record<string, unknown>> = [];
      let inventoryValue = new Prisma.Decimal(0);

      const projections = balances.map((balance) => {
        const available = balance.onHandQuantity
          .minus(balance.reservedQuantity)
          .minus(balance.quarantinedQuantity);
        const positioned = balance.positions.reduce(
          (sum, position) => sum.plus(position.quantity),
          new Prisma.Decimal(0),
        );
        const policy =
          policyMap.get(`PRODUCT:${balance.productId}`) ??
          policyMap.get(`MEDICATION:${balance.product.medicationId}`) ??
          policyMap.get("SITE") ??
          null;
        const daysToExpiration = Math.floor(
          (balance.productExpiration.expirationDate.getTime() - now.getTime()) /
            86_400_000,
        );

        let costQty = new Prisma.Decimal(0);
        let costValue = new Prisma.Decimal(0);
        for (const layer of balance.inventoryCostLayers) {
          costQty = costQty.plus(layer.quantityRemaining);
          costValue = costValue.plus(
            layer.quantityRemaining.mul(layer.unitCost),
          );
        }
        const weightedUnitCost = costQty.gt(0)
          ? costValue.div(costQty)
          : null;
        const projectedValue = weightedUnitCost
          ? balance.onHandQuantity.mul(weightedUnitCost)
          : new Prisma.Decimal(0);
        inventoryValue = inventoryValue.plus(projectedValue);

        if (!positioned.eq(balance.onHandQuantity)) {
          exceptions.push({
            kind: "LOCATION_COVERAGE_MISMATCH",
            severity: "WARNING",
            balanceId: balance.id,
            detail: `Positioned ${positioned.toString()} vs on-hand ${balance.onHandQuantity.toString()}`,
          });
        }

        if (
          policy?.reorderPoint !== null &&
          policy?.reorderPoint !== undefined &&
          available.lte(policy.reorderPoint)
        ) {
          exceptions.push({
            kind: "BELOW_REORDER_POINT",
            severity: "WARNING",
            balanceId: balance.id,
            productId: balance.productId,
            availableQuantity: available.toString(),
            reorderPoint: policy.reorderPoint.toString(),
          });
        }

        if (
          daysToExpiration <= (policy?.expirationWarningDays ?? 90)
        ) {
          exceptions.push({
            kind: "EXPIRING_STOCK",
            severity: daysToExpiration <= 30 ? "HIGH" : "WARNING",
            balanceId: balance.id,
            daysToExpiration,
          });
        }

        const staleHours = policy?.staleReservationHours ?? 24;
        for (const fill of balance.fills) {
          if (
            fill.inventoryReservedAt &&
            now.getTime() - fill.inventoryReservedAt.getTime() >
              staleHours * 3_600_000
          ) {
            exceptions.push({
              kind: "STALE_RESERVATION",
              severity: "WARNING",
              balanceId: balance.id,
              fillId: fill.id,
              reservedAt: fill.inventoryReservedAt.toISOString(),
            });
          }
        }

        return {
          balanceId: balance.id,
          product: balance.product,
          lot: balance.productLot,
          expiration: balance.productExpiration,
          onHandQuantity: balance.onHandQuantity.toString(),
          reservedQuantity: balance.reservedQuantity.toString(),
          quarantinedQuantity: balance.quarantinedQuantity.toString(),
          availableQuantity: available.toString(),
          positionedQuantity: positioned.toString(),
          daysToExpiration,
          weightedUnitCost: decimalString(weightedUnitCost),
          projectedInventoryValue: projectedValue.toString(),
          policy,
          locations: balance.positions.map((position) => ({
            id: position.location.id,
            code: position.location.code,
            name: position.location.name,
            type: position.location.type,
            quantity: position.quantity.toString(),
          })),
        };
      });

      for (const transfer of transfers) {
        if (now.getTime() - transfer.shippedAt.getTime() > 24 * 3_600_000) {
          exceptions.push({
            kind: "TRANSFER_STUCK_IN_TRANSIT",
            severity: "WARNING",
            transferId: transfer.id,
            shippedAt: transfer.shippedAt.toISOString(),
          });
        }
      }

      for (const order of purchaseOrders) {
        if (
          order.expectedDeliveryAt &&
          order.expectedDeliveryAt.getTime() < now.getTime()
        ) {
          exceptions.push({
            kind: "PURCHASE_ORDER_OVERDUE",
            severity: "WARNING",
            purchaseOrderId: order.id,
            orderNumber: order.orderNumber,
            expectedDeliveryAt: order.expectedDeliveryAt.toISOString(),
          });
        }
      }

      for (const discrepancy of discrepancies) {
        exceptions.push({
          kind: "RECEIVING_DISCREPANCY",
          severity: "WARNING",
          discrepancyId: discrepancy.id,
          discrepancyType: discrepancy.type,
        });
      }

      return {
        generatedAt: now.toISOString(),
        inventoryValue: inventoryValue.toString(),
        projections,
        demands: demands.map((demand) => ({
          ...demand,
          quantityRequired: demand.quantityRequired.toString(),
          quantitySatisfied: demand.quantitySatisfied.toString(),
          remainingQuantity: demand.quantityRequired
            .minus(demand.quantitySatisfied)
            .toString(),
        })),
        exceptions,
      };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });
}
