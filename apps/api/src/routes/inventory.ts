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
}
