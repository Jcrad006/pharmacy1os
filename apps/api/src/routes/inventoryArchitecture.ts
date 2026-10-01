import type {
  InventoryCustodyEventType,
  InventoryLocationType,
  InventoryStockState,
  ReceivingDiscrepancyType,
} from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import {
  getFefoRecommendation,
  moveStockLocation,
  projectBalanceAsOf,
  refreshInventoryExceptions,
  reconcileDemandAvailability,
} from "../inventoryArchitecture.js";
import { InventoryError } from "../inventoryError.js";
import {
  AccessError,
  resolveDevelopmentActor,
} from "../security/devIdentity.js";

const locationTypes = new Set<InventoryLocationType>([
  "SHELF",
  "BIN",
  "REFRIGERATOR",
  "FREEZER",
  "SAFE",
  "RECEIVING",
  "QUARANTINE",
  "RETURN_TO_VENDOR",
  "WILL_CALL",
  "OTHER",
]);

const stockStates = new Set<InventoryStockState>([
  "AVAILABLE",
  "QUARANTINED",
]);

const discrepancyTypes = new Set<ReceivingDiscrepancyType>([
  "SHORT_SHIPMENT",
  "OVERAGE",
  "WRONG_PRODUCT",
  "DAMAGED_PRODUCT",
  "LOT_EXPIRATION_MISMATCH",
  "INVOICE_MISMATCH",
  "DUPLICATE_SHIPMENT",
  "UNEXPECTED_PRODUCT",
  "OTHER",
]);

const custodyTypes = new Set<InventoryCustodyEventType>([
  "PACKED",
  "VERIFIED",
  "HANDED_OFF",
  "RECEIVED",
  "EXCEPTION",
]);

function knownError(reply: any, error: unknown) {
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

export async function inventoryArchitectureRoutes(app: FastifyInstance) {
  app.get("/inventory/locations", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const locations = await db.inventoryLocation.findMany({
        where: { siteId: actor.siteId },
        include: {
          stockPositions: {
            where: { quantity: { gt: 0 } },
            include: {
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
          },
        },
        orderBy: [{ active: "desc" }, { code: "asc" }],
      });
      return { locations };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.post("/inventory/locations", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const body = (request.body ?? {}) as {
        code?: string;
        name?: string;
        type?: InventoryLocationType;
        isDefaultReceiving?: boolean;
        isDefaultDispensing?: boolean;
        isQuarantine?: boolean;
        temperatureMinC?: number;
        temperatureMaxC?: number;
        barcode?: string;
      };
      const code = body.code?.trim().toUpperCase();
      const name = body.name?.trim();
      const barcode = body.barcode?.trim().toUpperCase() || null;

      if (!code || !name || !body.type || !locationTypes.has(body.type)) {
        return reply.code(400).send({
          error: "code, name, and a valid location type are required.",
        });
      }
      const locationType = body.type;
      if (
        body.temperatureMinC !== undefined &&
        body.temperatureMaxC !== undefined &&
        body.temperatureMinC > body.temperatureMaxC
      ) {
        return reply.code(400).send({
          error: "temperatureMinC cannot exceed temperatureMaxC.",
        });
      }

      const location = await db.$transaction(async (tx) => {
        if (body.isDefaultReceiving) {
          await tx.inventoryLocation.updateMany({
            where: { siteId: actor.siteId, isDefaultReceiving: true },
            data: { isDefaultReceiving: false },
          });
        }
        if (body.isDefaultDispensing) {
          await tx.inventoryLocation.updateMany({
            where: { siteId: actor.siteId, isDefaultDispensing: true },
            data: { isDefaultDispensing: false },
          });
        }
        if (body.isQuarantine) {
          await tx.inventoryLocation.updateMany({
            where: { siteId: actor.siteId, isQuarantine: true },
            data: { isQuarantine: false },
          });
        }

        const created = await tx.inventoryLocation.create({
          data: {
            siteId: actor.siteId,
            code,
            name,
            type: locationType,
            isDefaultReceiving: body.isDefaultReceiving ?? false,
            isDefaultDispensing: body.isDefaultDispensing ?? false,
            isQuarantine: body.isQuarantine ?? false,
            temperatureMinC: body.temperatureMinC,
            temperatureMaxC: body.temperatureMaxC,
            barcode,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_LOCATION_CREATED",
          entityType: "InventoryLocation",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            code,
            name,
            type: locationType,
            isDefaultReceiving: created.isDefaultReceiving,
            isDefaultDispensing: created.isDefaultDispensing,
            isQuarantine: created.isQuarantine,
            barcode: created.barcode,
          },
        });
        return created;
      });

      return reply.code(201).send({ location });
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.post("/inventory/locations/move", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as {
        inventoryBalanceId?: string;
        fromLocationId?: string;
        toLocationId?: string;
        state?: InventoryStockState;
        quantity?: number;
        reason?: string;
      };
      const reason = body.reason?.trim();
      if (
        !body.inventoryBalanceId ||
        !body.fromLocationId ||
        !body.toLocationId ||
        !body.state ||
        !stockStates.has(body.state) ||
        typeof body.quantity !== "number" ||
        !Number.isFinite(body.quantity) ||
        body.quantity <= 0 ||
        !reason
      ) {
        return reply.code(400).send({
          error:
            "balance, source/destination locations, stock state, positive quantity, and reason are required.",
        });
      }

      const transaction = await db.$transaction(async (tx) => {
        const moved = await moveStockLocation(tx, {
          siteId: actor.siteId,
          inventoryBalanceId: body.inventoryBalanceId!,
          actorId: actor.id,
          fromLocationId: body.fromLocationId!,
          toLocationId: body.toLocationId!,
          state: body.state!,
          quantity: body.quantity!,
          reason,
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_LOCATION_MOVED",
          entityType: "InventoryBalance",
          entityId: body.inventoryBalanceId,
          requestId: request.id,
          metadata: {
            fromLocationId: body.fromLocationId,
            toLocationId: body.toLocationId,
            state: body.state,
            quantity: body.quantity,
            reason,
            inventoryTransactionId: moved.id,
          },
        });
        return moved;
      });
      return { transaction };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.get("/inventory/policies", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const policies = await db.inventoryPolicy.findMany({
        where: { siteId: actor.siteId },
        include: {
          product: {
            include: {
              medication: true,
              manufacturer: true,
            },
          },
        },
        orderBy: [{ scope: "asc" }, { policyKey: "asc" }],
      });
      return { policies };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.put("/inventory/policies/:policyKey", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const policyKey = decodeURIComponent(
        (request.params as { policyKey: string }).policyKey,
      );
      const body = (request.body ?? {}) as {
        scope?: "SITE" | "PRODUCT";
        productId?: string | null;
        reorderPoint?: number | null;
        targetStockLevel?: number | null;
        minShelfLifeDays?: number;
        expirationWarningDays?: number;
        fefoEnabled?: boolean;
        staleReservationHours?: number;
        staleTransferHours?: number;
        purchaseOrderOverdueDays?: number;
        technicianAdjustmentThreshold?: number | null;
        preferredSupplierName?: string | null;
      };

      const scope = body.scope ?? (body.productId ? "PRODUCT" : "SITE");
      if (scope === "PRODUCT" && !body.productId) {
        return reply.code(400).send({
          error: "A productId is required for a product policy.",
        });
      }
      const nonnegative = [
        body.reorderPoint,
        body.targetStockLevel,
        body.technicianAdjustmentThreshold,
      ].filter((value): value is number => value !== null && value !== undefined);
      if (nonnegative.some((value) => !Number.isFinite(value) || value < 0)) {
        return reply.code(400).send({
          error: "Policy quantity values must be nonnegative.",
        });
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
            scope,
            productId: body.productId ?? null,
            reorderPoint: body.reorderPoint,
            targetStockLevel: body.targetStockLevel,
            minShelfLifeDays: body.minShelfLifeDays,
            expirationWarningDays: body.expirationWarningDays,
            fefoEnabled: body.fefoEnabled,
            staleReservationHours: body.staleReservationHours,
            staleTransferHours: body.staleTransferHours,
            purchaseOrderOverdueDays: body.purchaseOrderOverdueDays,
            technicianAdjustmentThreshold:
              body.technicianAdjustmentThreshold,
            preferredSupplierName:
              body.preferredSupplierName?.trim() || null,
            active: true,
          },
          create: {
            siteId: actor.siteId,
            policyKey,
            scope,
            productId: body.productId ?? null,
            reorderPoint: body.reorderPoint,
            targetStockLevel: body.targetStockLevel,
            minShelfLifeDays: body.minShelfLifeDays ?? 30,
            expirationWarningDays: body.expirationWarningDays ?? 90,
            fefoEnabled: body.fefoEnabled ?? true,
            staleReservationHours: body.staleReservationHours ?? 24,
            staleTransferHours: body.staleTransferHours ?? 48,
            purchaseOrderOverdueDays:
              body.purchaseOrderOverdueDays ?? 3,
            technicianAdjustmentThreshold:
              body.technicianAdjustmentThreshold,
            preferredSupplierName:
              body.preferredSupplierName?.trim() || null,
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_POLICY_UPDATED",
          entityType: "InventoryPolicy",
          entityId: updated.id,
          requestId: request.id,
          metadata: { policyKey, scope, productId: body.productId ?? null },
        });
        return updated;
      });
      return { policy };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.get("/inventory/demands", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const demands = await db.inventoryDemand.findMany({
        where: { siteId: actor.siteId },
        include: {
          medication: true,
          product: {
            include: { manufacturer: true },
          },
          fill: {
            include: {
              prescription: {
                include: { patient: true },
              },
            },
          },
        },
        orderBy: [{ status: "asc" }, { neededBy: "asc" }, { createdAt: "asc" }],
      });
      return { demands };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.post("/inventory/demands/reconcile", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as { medicationId?: string };
      if (!body.medicationId) {
        return reply.code(400).send({ error: "medicationId is required." });
      }
      const result = await db.$transaction((tx) =>
        reconcileDemandAvailability(tx, actor.siteId, body.medicationId!),
      );
      return {
        availableQuantity: result.availableQuantity.toString(),
        demandCount: result.demandCount,
      };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.get("/inventory/fefo", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const query = request.query as {
        productId?: string;
        quantity?: string;
      };
      const quantity = Number(query.quantity);
      if (
        !query.productId ||
        !Number.isFinite(quantity) ||
        quantity <= 0
      ) {
        return reply.code(400).send({
          error: "productId and a positive quantity are required.",
        });
      }
      return await db.$transaction((tx) =>
        getFefoRecommendation(tx, {
          siteId: actor.siteId,
          productId: query.productId!,
          quantity,
        }),
      );
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.get("/inventory/balances/:id/as-of", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const id = (request.params as { id: string }).id;
      const query = request.query as { at?: string };
      const asOf = query.at ? new Date(query.at) : new Date();
      if (Number.isNaN(asOf.getTime())) {
        return reply.code(400).send({ error: "Invalid as-of date/time." });
      }
      const projection = await db.$transaction((tx) =>
        projectBalanceAsOf(tx, {
          siteId: actor.siteId,
          inventoryBalanceId: id,
          asOf,
        }),
      );
      return {
        ...projection,
        onHandQuantity: projection.onHandQuantity.toString(),
        reservedQuantity: projection.reservedQuantity.toString(),
        quarantinedQuantity: projection.quarantinedQuantity.toString(),
        availableQuantity: projection.availableQuantity.toString(),
        recordedAcquisitionCost:
          projection.recordedAcquisitionCost.toString(),
      };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.get("/inventory/exceptions", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const exceptions = await db.$transaction((tx) =>
        refreshInventoryExceptions(tx, actor.siteId),
      );
      return { exceptions };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.post("/inventory/exceptions/:id/acknowledge", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const id = (request.params as { id: string }).id;
      const exception = await db.inventoryException.findFirst({
        where: { id, siteId: actor.siteId },
      });
      if (!exception) {
        return reply.code(404).send({ error: "Inventory exception not found." });
      }
      const updated = await db.inventoryException.update({
        where: { id },
        data: {
          status: "ACKNOWLEDGED",
          acknowledgedById: actor.id,
          acknowledgedAt: new Date(),
        },
      });
      return { exception: updated };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.post("/inventory/exceptions/:id/resolve", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as { resolutionNote?: string };
      const resolutionNote = body.resolutionNote?.trim();

      if (!resolutionNote) {
        return reply.code(400).send({
          error: "An inventory-exception resolution note is required.",
        });
      }

      const exception = await db.inventoryException.findFirst({
        where: { id, siteId: actor.siteId },
      });

      if (!exception) {
        return reply.code(404).send({
          error: "Inventory exception not found.",
        });
      }

      if (exception.status === "RESOLVED") {
        return reply.code(409).send({
          error: "Inventory exception is already resolved.",
        });
      }

      const resolved = await db.$transaction(async (tx) => {
        const updated = await tx.inventoryException.update({
          where: { id },
          data: {
            status: "RESOLVED",
            resolvedById: actor.id,
            resolvedAt: new Date(),
            resolutionNote,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_EXCEPTION_RESOLVED",
          entityType: "InventoryException",
          entityId: id,
          requestId: request.id,
          metadata: {
            type: exception.type,
            entityType: exception.entityType,
            entityId: exception.entityId,
            resolutionNote,
          },
        });

        return updated;
      });

      return { exception: resolved };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.post("/inventory/discrepancies", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as {
        type?: ReceivingDiscrepancyType;
        purchaseOrderId?: string;
        purchaseOrderLineId?: string;
        receiptId?: string;
        expectedProductId?: string;
        observedProductId?: string;
        expectedQuantity?: number;
        observedQuantity?: number;
        note?: string;
      };
      if (!body.type || !discrepancyTypes.has(body.type)) {
        return reply.code(400).send({
          error: "A valid receiving discrepancy type is required.",
        });
      }

      const discrepancy = await db.$transaction(async (tx) => {
        const created = await tx.receivingDiscrepancy.create({
          data: {
            siteId: actor.siteId,
            type: body.type!,
            purchaseOrderId: body.purchaseOrderId,
            purchaseOrderLineId: body.purchaseOrderLineId,
            receiptId: body.receiptId,
            expectedProductId: body.expectedProductId,
            observedProductId: body.observedProductId,
            expectedQuantity: body.expectedQuantity,
            observedQuantity: body.observedQuantity,
            note: body.note?.trim() || null,
            createdById: actor.id,
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "RECEIVING_DISCREPANCY_OPENED",
          entityType: "ReceivingDiscrepancy",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            type: created.type,
            purchaseOrderId: created.purchaseOrderId,
            purchaseOrderLineId: created.purchaseOrderLineId,
          },
        });
        return created;
      });
      return reply.code(201).send({ discrepancy });
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.get("/inventory/discrepancies", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const discrepancies = await db.receivingDiscrepancy.findMany({
        where: { siteId: actor.siteId },
        include: {
          createdBy: {
            select: { displayName: true, role: true },
          },
          resolvedBy: {
            select: { displayName: true, role: true },
          },
          expectedProduct: {
            include: { medication: true, manufacturer: true },
          },
          observedProduct: {
            include: { medication: true, manufacturer: true },
          },
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      });
      return { discrepancies };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.post("/inventory/discrepancies/:id/resolve", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as { resolutionNote?: string };
      const resolutionNote = body.resolutionNote?.trim();
      if (!resolutionNote) {
        return reply.code(400).send({
          error: "A discrepancy resolution note is required.",
        });
      }
      const discrepancy = await db.receivingDiscrepancy.findFirst({
        where: { id, siteId: actor.siteId },
      });
      if (!discrepancy) {
        return reply.code(404).send({ error: "Discrepancy not found." });
      }
      if (discrepancy.status === "RESOLVED") {
        return reply.code(409).send({ error: "Discrepancy is already resolved." });
      }
      const resolved = await db.$transaction(async (tx) => {
        const updated = await tx.receivingDiscrepancy.update({
          where: { id },
          data: {
            status: "RESOLVED",
            resolvedById: actor.id,
            resolvedAt: new Date(),
            resolutionNote,
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "RECEIVING_DISCREPANCY_RESOLVED",
          entityType: "ReceivingDiscrepancy",
          entityId: id,
          requestId: request.id,
          metadata: { resolutionNote },
        });
        return updated;
      });
      return { discrepancy: resolved };
    } catch (error) {
      return knownError(reply, error);
    }
  });

  app.post("/inventory/transfers/:id/custody", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as {
        type?: InventoryCustodyEventType;
        carrier?: string;
        trackingNumber?: string;
        sealIdentifier?: string;
        note?: string;
      };
      if (!body.type || !custodyTypes.has(body.type)) {
        return reply.code(400).send({
          error: "A valid custody event type is required.",
        });
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
        return reply.code(404).send({ error: "Inventory transfer not found." });
      }

      const event = await db.$transaction(async (tx) => {
        const created = await tx.inventoryTransferCustodyEvent.create({
          data: {
            transferId: id,
            siteId: actor.siteId,
            actorId: actor.id,
            type: body.type!,
            carrier: body.carrier?.trim() || null,
            trackingNumber: body.trackingNumber?.trim() || null,
            sealIdentifier: body.sealIdentifier?.trim() || null,
            note: body.note?.trim() || null,
          },
        });
        await tx.inventoryTransfer.update({
          where: { id },
          data: {
            carrier: body.carrier?.trim() || transfer.carrier,
            trackingNumber:
              body.trackingNumber?.trim() || transfer.trackingNumber,
            sealIdentifier:
              body.sealIdentifier?.trim() || transfer.sealIdentifier,
          },
        });
        return created;
      });
      return reply.code(201).send({ event });
    } catch (error) {
      return knownError(reply, error);
    }
  });
}
