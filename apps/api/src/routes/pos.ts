import type { FastifyInstance, FastifyReply } from "fastify";
import { resolveDevelopmentActor, AccessError } from "../security/devIdentity.js";
import {
  checkoutFills,
  PosError,
  quoteFillsForCheckout,
  stageWillCallPackage,
  type PickupPackageInput,
  type PickupVerificationInput,
  type PosTenderInput,
} from "../pos/service.js";

type QuoteBody = {
  fillIds?: string[];
};

type CheckoutBody = {
  fillIds?: string[];
  tenders?: PosTenderInput[];
  pickupPackages?: PickupPackageInput[];
  pickup?: PickupVerificationInput;
  idempotencyKey?: string;
};

type StageBody = {
  bagBarcode?: string | null;
  locationId?: string | null;
  locationBarcode?: string | null;
};

function handleError(error: unknown, reply: FastifyReply) {
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
  app.post("/fills/:id/will-call/stage", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:process");
      const fillId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as StageBody;
      const packageRecord = await stageWillCallPackage(
        fillId,
        body,
        {
          siteId: actor.siteId,
          actorId: actor.id,
          requestId: request.id,
        },
      );
      return { package: packageRecord };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/will-call/packages/scan/:barcode", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const barcode = decodeURIComponent(
        (request.params as { barcode: string }).barcode,
      )
        .trim()
        .toUpperCase();
      if (!barcode) {
        return reply.code(400).send({ error: "A barcode is required." });
      }
      const { db } = await import("../db.js");

      const bag = await db.willCallPackage.findFirst({
        where: {
          siteId: actor.siteId,
          status: "STAGED",
          bagBarcode: barcode,
        },
        include: {
          location: true,
          fill: {
            include: {
              prescription: { include: { patient: true } },
            },
          },
        },
      });
      if (bag) {
        return { scanType: "BAG", packages: [bag] };
      }

      const packages = await db.willCallPackage.findMany({
        where: {
          siteId: actor.siteId,
          status: "STAGED",
          location: {
            siteId: actor.siteId,
            barcode,
            active: true,
          },
        },
        include: {
          location: true,
          fill: {
            include: {
              prescription: { include: { patient: true } },
            },
          },
        },
        orderBy: { stagedAt: "asc" },
      });
      if (packages.length === 0) {
        return reply.code(404).send({ error: "No staged Will Call package matches that barcode." });
      }
      return { scanType: "LOCATION", packages };
    } catch (error) {
      return handleError(error, reply);
    }
  });

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
      if (!Array.isArray(body.pickupPackages)) {
        return reply.code(400).send({
          error: "pickupPackages must be an array.",
          code: "PACKAGE_SCAN_REQUIRED",
        });
      }
      if (!body.pickup) {
        return reply.code(400).send({
          error: "pickup verification and signature details are required.",
          code: "PICKUP_VERIFICATION_REQUIRED",
        });
      }
      const result = await checkoutFills(
        {
          fillIds: body.fillIds,
          tenders: body.tenders ?? [],
          pickupPackages: body.pickupPackages,
          pickup: body.pickup,
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
