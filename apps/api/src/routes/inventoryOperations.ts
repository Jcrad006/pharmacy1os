import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { InventoryError } from "../inventory.js";
import {
  cancelInventoryTransfer,
  cancelPurchaseOrder,
  closeRecallCase,
  createInventoryTransfer,
  createPurchaseOrder,
  createRecallCase,
  receiveInventoryTransfer,
  receivePurchaseOrderLine,
} from "../inventoryOperations.js";
import {
  AccessError,
  resolveDevelopmentActor,
} from "../security/devIdentity.js";

type TransferCreateBody = {
  destinationSiteId?: string;
  sourceInventoryBalanceId?: string;
  quantity?: number;
  note?: string;
};

type TransferCancelBody = {
  reason?: string;
};

type RecallCreateBody = {
  productId?: string;
  lotNumber?: string;
  reference?: string;
  reason?: string;
};

type RecallCloseBody = {
  closureNote?: string;
};

type PurchaseOrderCreateBody = {
  orderNumber?: string;
  supplierName?: string;
  note?: string;
  lines?: Array<{
    productId?: string;
    quantityOrdered?: number;
    unitCost?: number;
  }>;
};

type PurchaseOrderReceiveBody = {
  quantity?: number;
  lotNumber?: string;
  expirationDate?: string;
  invoiceReference?: string;
};

function sendKnownError(reply: any, error: unknown) {
  if (error instanceof AccessError || error instanceof InventoryError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error instanceof InventoryError
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

const transferInclude = {
  sourceSite: true,
  destinationSite: true,
  sourceInventoryBalance: {
    include: {
      product: { include: { medication: true, manufacturer: true } },
      productLot: true,
      productExpiration: true,
    },
  },
  destinationInventoryBalance: {
    include: {
      product: { include: { medication: true, manufacturer: true } },
      productLot: true,
      productExpiration: true,
    },
  },
  initiatedBy: {
    select: { id: true, displayName: true, role: true },
  },
  receivedBy: {
    select: { id: true, displayName: true, role: true },
  },
  cancelledBy: {
    select: { id: true, displayName: true, role: true },
  },
  transactions: {
    orderBy: { occurredAt: "asc" as const },
  },
};

const recallInclude = {
  product: {
    include: {
      medication: true,
      manufacturer: true,
    },
  },
  createdBy: {
    select: { id: true, displayName: true, role: true },
  },
  closedBy: {
    select: { id: true, displayName: true, role: true },
  },
  holds: {
    include: {
      inventoryBalance: {
        include: {
          productLot: true,
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
          productLot: true,
          prescription: {
            include: {
              patient: true,
            },
          },
        },
      },
    },
    orderBy: { discoveredAt: "asc" as const },
  },
};

const purchaseOrderInclude = {
  createdBy: {
    select: { id: true, displayName: true, role: true },
  },
  cancelledBy: {
    select: { id: true, displayName: true, role: true },
  },
  lines: {
    include: {
      product: {
        include: {
          medication: true,
          manufacturer: true,
        },
      },
      receipts: {
        include: {
          actor: {
            select: { id: true, displayName: true, role: true },
          },
          inventoryBalance: {
            include: {
              productLot: true,
              productExpiration: true,
            },
          },
        },
        orderBy: { receivedAt: "asc" as const },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
};

export async function inventoryOperationsRoutes(app: FastifyInstance) {
  app.get("/inventory/sites", async (request, reply) => {
    try {
      await resolveDevelopmentActor(request, "inventory:read");
      const sites = await db.pharmacySite.findMany({
        select: {
          id: true,
          name: true,
          ncpdpId: true,
          phone: true,
        },
        orderBy: { name: "asc" },
      });
      return { sites };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/inventory/transfers", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const transfers = await db.inventoryTransfer.findMany({
        where: {
          OR: [
            { sourceSiteId: actor.siteId },
            { destinationSiteId: actor.siteId },
          ],
        },
        include: transferInclude,
        orderBy: { shippedAt: "desc" },
        take: 100,
      });
      return { transfers };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/transfers", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const body = (request.body ?? {}) as TransferCreateBody;

      if (
        !body.destinationSiteId ||
        !body.sourceInventoryBalanceId ||
        typeof body.quantity !== "number" ||
        !Number.isFinite(body.quantity) ||
        body.quantity <= 0
      ) {
        return reply.code(400).send({
          error:
            "destinationSiteId, sourceInventoryBalanceId, and a positive quantity are required.",
        });
      }

      const result = await db.$transaction(async (tx) => {
        const created = await createInventoryTransfer(tx, {
          sourceSiteId: actor.siteId,
          destinationSiteId: body.destinationSiteId!,
          sourceInventoryBalanceId: body.sourceInventoryBalanceId!,
          actorId: actor.id,
          quantity: body.quantity!,
          note: body.note,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_TRANSFER_SHIPPED",
          entityType: "InventoryTransfer",
          entityId: created.transfer.id,
          requestId: request.id,
          metadata: {
            destinationSiteId: body.destinationSiteId,
            sourceInventoryBalanceId: body.sourceInventoryBalanceId,
            quantity: body.quantity,
            inventoryTransactionId: created.transaction.id,
            note: body.note?.trim() || null,
          },
        });

        return created;
      });

      const transfer = await db.inventoryTransfer.findUniqueOrThrow({
        where: { id: result.transfer.id },
        include: transferInclude,
      });

      return reply.code(201).send({ transfer });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/transfers/:id/receive", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const id = (request.params as { id: string }).id;

      const result = await db.$transaction(async (tx) => {
        const received = await receiveInventoryTransfer(tx, {
          transferId: id,
          destinationSiteId: actor.siteId,
          actorId: actor.id,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_TRANSFER_RECEIVED",
          entityType: "InventoryTransfer",
          entityId: id,
          requestId: request.id,
          metadata: {
            destinationInventoryBalanceId: received.destinationBalance.id,
            quantity: received.transfer.quantity.toString(),
            inventoryTransactionId: received.transaction.id,
          },
        });

        return received;
      });

      const transfer = await db.inventoryTransfer.findUniqueOrThrow({
        where: { id },
        include: transferInclude,
      });
      return { transfer };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/transfers/:id/cancel", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as TransferCancelBody;
      const reason = body.reason?.trim();

      if (!reason) {
        return reply.code(400).send({
          error: "A transfer cancellation reason is required.",
        });
      }

      await db.$transaction(async (tx) => {
        const cancelled = await cancelInventoryTransfer(tx, {
          transferId: id,
          sourceSiteId: actor.siteId,
          actorId: actor.id,
          reason,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_TRANSFER_CANCELLED",
          entityType: "InventoryTransfer",
          entityId: id,
          requestId: request.id,
          metadata: {
            reason,
            quantity: cancelled.transfer.quantity.toString(),
            inventoryTransactionId: cancelled.transaction.id,
          },
        });
      });

      const transfer = await db.inventoryTransfer.findUniqueOrThrow({
        where: { id },
        include: transferInclude,
      });
      return { transfer };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/inventory/recalls", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const recalls = await db.recallCase.findMany({
        where: { siteId: actor.siteId },
        include: recallInclude,
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return { recalls };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/recalls", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const body = (request.body ?? {}) as RecallCreateBody;
      const reference = body.reference?.trim();
      const reason = body.reason?.trim();

      if (!body.productId || !reference || !reason) {
        return reply.code(400).send({
          error: "productId, recall reference, and reason are required.",
        });
      }

      const result = await db.$transaction(async (tx) => {
        const created = await createRecallCase(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          productId: body.productId!,
          lotNumber: body.lotNumber,
          reference,
          reason,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_RECALL_CREATED",
          entityType: "RecallCase",
          entityId: created.recall.id,
          requestId: request.id,
          metadata: {
            productId: body.productId,
            lotNumber: body.lotNumber?.trim() || null,
            reference,
            reason,
            matchedBalanceCount: created.matchedBalanceCount,
            quarantinedHoldCount: created.quarantinedHoldCount,
            reservedAffectedQuantity:
              created.reservedAffectedQuantity.toString(),
            affectedSoldFillCount: created.affectedSoldFillCount,
          },
        });

        return created;
      });

      const recall = await db.recallCase.findUniqueOrThrow({
        where: { id: result.recall.id },
        include: recallInclude,
      });

      return reply.code(201).send({
        recall,
        summary: {
          matchedBalanceCount: result.matchedBalanceCount,
          quarantinedHoldCount: result.quarantinedHoldCount,
          reservedAffectedQuantity:
            result.reservedAffectedQuantity.toString(),
          affectedSoldFillCount: result.affectedSoldFillCount,
        },
      });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/recalls/:id/close", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as RecallCloseBody;
      const closureNote = body.closureNote?.trim();

      if (!closureNote) {
        return reply.code(400).send({
          error: "A recall closure note is required.",
        });
      }

      await db.$transaction(async (tx) => {
        await closeRecallCase(tx, {
          recallCaseId: id,
          siteId: actor.siteId,
          actorId: actor.id,
          closureNote,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_RECALL_CLOSED",
          entityType: "RecallCase",
          entityId: id,
          requestId: request.id,
          metadata: { closureNote },
        });
      });

      const recall = await db.recallCase.findUniqueOrThrow({
        where: { id },
        include: recallInclude,
      });
      return { recall };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.get("/inventory/purchase-orders", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const purchaseOrders = await db.purchaseOrder.findMany({
        where: { siteId: actor.siteId },
        include: purchaseOrderInclude,
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      return { purchaseOrders };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post("/inventory/purchase-orders", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as PurchaseOrderCreateBody;
      const orderNumber = body.orderNumber?.trim();
      const supplierName = body.supplierName?.trim();

      if (
        !orderNumber ||
        !supplierName ||
        !Array.isArray(body.lines) ||
        body.lines.length === 0
      ) {
        return reply.code(400).send({
          error:
            "orderNumber, supplierName, and at least one purchase-order line are required.",
        });
      }

      const normalizedLines = body.lines.map((line) => ({
        productId: line.productId ?? "",
        quantityOrdered: line.quantityOrdered ?? Number.NaN,
        unitCost: line.unitCost,
      }));

      if (
        normalizedLines.some(
          (line) =>
            !line.productId ||
            !Number.isFinite(line.quantityOrdered) ||
            line.quantityOrdered <= 0 ||
            (line.unitCost !== undefined &&
              (!Number.isFinite(line.unitCost) || line.unitCost < 0)),
        )
      ) {
        return reply.code(400).send({
          error:
            "Every purchase-order line requires an active product and positive ordered quantity; unit cost cannot be negative.",
        });
      }

      const order = await db.$transaction(async (tx) => {
        const created = await createPurchaseOrder(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          orderNumber,
          supplierName,
          note: body.note,
          lines: normalizedLines,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_PURCHASE_ORDER_CREATED",
          entityType: "PurchaseOrder",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            orderNumber,
            supplierName,
            lineCount: created.lines.length,
          },
        });

        return created;
      });

      return reply.code(201).send({ purchaseOrder: order });
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });

  app.post(
    "/inventory/purchase-orders/:id/lines/:lineId/receive",
    async (request, reply) => {
      try {
        const actor = await resolveDevelopmentActor(request, "inventory:write");
        const { id, lineId } = request.params as {
          id: string;
          lineId: string;
        };
        const body = (request.body ?? {}) as PurchaseOrderReceiveBody;
        const lotNumber = body.lotNumber?.trim();
        const quantity = body.quantity;
        const expirationDate = body.expirationDate
          ? new Date(body.expirationDate)
          : null;

        if (
          typeof quantity !== "number" ||
          !Number.isFinite(quantity) ||
          quantity <= 0 ||
          !lotNumber ||
          !expirationDate ||
          Number.isNaN(expirationDate.getTime())
        ) {
          return reply.code(400).send({
            error:
              "A positive quantity, lot number, and valid expiration date are required.",
          });
        }

        const result = await db.$transaction(async (tx) => {
          const received = await receivePurchaseOrderLine(tx, {
            purchaseOrderId: id,
            lineId,
            siteId: actor.siteId,
            actorId: actor.id,
            quantity,
            lotNumber,
            expirationDate,
            invoiceReference: body.invoiceReference,
          });

          await writeAuditEvent(tx, {
            siteId: actor.siteId,
            actorId: actor.id,
            action: "INVENTORY_PURCHASE_ORDER_LINE_RECEIVED",
            entityType: "PurchaseOrder",
            entityId: id,
            requestId: request.id,
            metadata: {
              lineId,
              quantity,
              lotNumber,
              expirationDate: expirationDate.toISOString(),
              invoiceReference: body.invoiceReference?.trim() || null,
              inventoryBalanceId: received.balance.id,
              inventoryTransactionId: received.transaction.id,
            },
          });

          return received;
        });

        const purchaseOrder = await db.purchaseOrder.findUniqueOrThrow({
          where: { id },
          include: purchaseOrderInclude,
        });

        return {
          purchaseOrder,
          receipt: result.receipt,
          balance: result.balance,
        };
      } catch (error) {
        return sendKnownError(reply, error);
      }
    },
  );

  app.post("/inventory/purchase-orders/:id/cancel", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const id = (request.params as { id: string }).id;

      await db.$transaction(async (tx) => {
        const order = await cancelPurchaseOrder(tx, {
          purchaseOrderId: id,
          siteId: actor.siteId,
          actorId: actor.id,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "INVENTORY_PURCHASE_ORDER_CANCELLED",
          entityType: "PurchaseOrder",
          entityId: id,
          requestId: request.id,
          metadata: {
            orderNumber: order.orderNumber,
            priorStatus: order.status,
          },
        });
      });

      const purchaseOrder = await db.purchaseOrder.findUniqueOrThrow({
        where: { id },
        include: purchaseOrderInclude,
      });
      return { purchaseOrder };
    } catch (error) {
      return sendKnownError(reply, error);
    }
  });
}
