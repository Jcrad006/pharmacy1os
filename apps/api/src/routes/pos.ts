import type { FastifyInstance } from "fastify";
import { resolveDevelopmentActor, AccessError } from "../security/devIdentity.js";
import {
  checkoutFills,
  PosError,
  quoteFillsForCheckout,
  type PosTenderInput,
} from "../pos/service.js";

type QuoteBody = {
  fillIds?: string[];
};

type CheckoutBody = {
  fillIds?: string[];
  tenders?: PosTenderInput[];
  idempotencyKey?: string;
};

function handleError(error: unknown, reply: Parameters<Parameters<FastifyInstance["post"]>[1]>[1]) {
  if (error instanceof AccessError || error instanceof PosError) {
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error instanceof PosError
        ? { code: error.code, details: error.details }
        : {}),
    });
  }
  throw error;
}

export async function posRoutes(app: FastifyInstance) {
  app.post("/pos/quote", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:sell");
      const body = request.body as QuoteBody;
      if (!Array.isArray(body.fillIds)) {
        return reply.code(400).send({ error: "fillIds must be an array." });
      }
      const quote = await quoteFillsForCheckout(body.fillIds, {
        siteId: actor.siteId,
      });
      return { quote };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/pos/checkout", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:sell");
      const body = request.body as CheckoutBody;
      if (!Array.isArray(body.fillIds)) {
        return reply.code(400).send({ error: "fillIds must be an array." });
      }
      if (!body.idempotencyKey?.trim()) {
        return reply.code(400).send({
          error: "idempotencyKey is required.",
          code: "IDEMPOTENCY_KEY_REQUIRED",
        });
      }
      const result = await checkoutFills(
        {
          fillIds: body.fillIds,
          tenders: body.tenders ?? [],
          idempotencyKey: body.idempotencyKey,
        },
        {
          siteId: actor.siteId,
          actorId: actor.id,
          requestId: request.id,
        },
      );
      return result;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/pos/transactions/:id", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const id = (request.params as { id: string }).id;
      const { db } = await import("../db.js");
      const transaction = await db.pointOfSaleTransaction.findFirst({
        where: { id, siteId: actor.siteId },
        include: {
          lines: {
            include: {
              fill: {
                include: {
                  prescription: {
                    include: { patient: true },
                  },
                },
              },
              claimTransaction: true,
            },
          },
          tenders: true,
          patient: true,
          createdBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      });
      if (!transaction) {
        return reply.code(404).send({ error: "POS transaction not found." });
      }
      return { transaction };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
