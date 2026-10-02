import type { FastifyInstance, FastifyReply } from "fastify";
import { resolveDevelopmentActor, AccessError } from "../security/devIdentity.js";
import { InventoryError } from "../inventoryError.js";
import {
  checkoutFills,
  PosError,
  quoteFillsForCheckout,
  rebagWillCallPackage,
  relocateWillCallPackage,
  stageWillCallPackage,
  type PickupPackageInput,
  type PickupVerificationInput,
  type PosTenderInput,
} from "../pos/service.js";

type QuoteBody = {
  fillIds?: string[];
  pickupFulfillmentMode?: "WILL_CALL" | "IMMEDIATE";
};

type CheckoutBody = {
  fillIds?: string[];
  tenders?: PosTenderInput[];
  pickupPackages?: PickupPackageInput[];
  pickup?: PickupVerificationInput;
  pickupFulfillmentMode?: "WILL_CALL" | "IMMEDIATE";
  idempotencyKey?: string;
};

type StageBody = {
  bagBarcode?: string | null;
  locationId?: string | null;
  locationBarcode?: string | null;
};

type RebagBody = {
  bagBarcode?: string | null;
};

type RelocateBody = {
  locationId?: string | null;
  locationBarcode?: string | null;
};

function handleError(error: unknown, reply: FastifyReply) {
  if (
    error instanceof AccessError ||
    error instanceof PosError ||
    error instanceof InventoryError
  ) {
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error instanceof PosError || error instanceof InventoryError
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

  app.post("/fills/:id/will-call/rebag", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:process");
      const fillId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as RebagBody;
      const packageRecord = await rebagWillCallPackage(fillId, body, {
        siteId: actor.siteId,
        actorId: actor.id,
        requestId: request.id,
      });
      return { package: packageRecord };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post("/fills/:id/will-call/relocate", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:process");
      const fillId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as RelocateBody;
      const packageRecord = await relocateWillCallPackage(fillId, body, {
        siteId: actor.siteId,
        actorId: actor.id,
        requestId: request.id,
      });
      return { package: packageRecord };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/fills/:id/will-call/history", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const fillId = (request.params as { id: string }).id;
      const { db } = await import("../db.js");
      const packageRecord = await db.willCallPackage.findFirst({
        where: {
          fillId,
          siteId: actor.siteId,
        },
        select: { id: true },
      });
      if (!packageRecord) {
        return reply.code(404).send({ error: "Will Call package not found." });
      }
      const events = await db.willCallEvent.findMany({
        where: {
          packageId: packageRecord.id,
          siteId: actor.siteId,
        },
        include: {
          actor: {
            select: { id: true, displayName: true, role: true },
          },
          fromLocation: {
            select: { id: true, code: true, name: true, barcode: true },
          },
          toLocation: {
            select: { id: true, code: true, name: true, barcode: true },
          },
        },
        orderBy: { occurredAt: "desc" },
      });
      return { events };
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

      const barcodeHistory = await db.willCallBagBarcode.findUnique({
        where: { barcode },
        include: {
          package: {
            include: {
              location: true,
              fill: {
                include: {
                  prescription: { include: { patient: true } },
                },
              },
            },
          },
        },
      });
      if (
        barcodeHistory &&
        barcodeHistory.siteId === actor.siteId &&
        barcodeHistory.status === "VOIDED"
      ) {
        return reply.code(409).send({
          error:
            "That bag barcode is retired. Use the current bag barcode shown for this prescription.",
          code: "VOID_BAG_BARCODE",
          details: {
            priorBagBarcode: barcode,
            currentBagBarcode: barcodeHistory.package.bagBarcode,
            fillId: barcodeHistory.package.fillId,
            packageStatus: barcodeHistory.package.status,
            locationCode: barcodeHistory.package.location.code,
          },
        });
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
      const quote = await quoteFillsForCheckout(
        body.fillIds,
        { siteId: actor.siteId },
        body.pickupFulfillmentMode,
      );
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
          pickupFulfillmentMode: body.pickupFulfillmentMode,
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
