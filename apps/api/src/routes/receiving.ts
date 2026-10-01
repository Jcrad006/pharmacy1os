import type { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { parseBarcode } from "../barcode.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type ScanBody = {
  rawBarcode?: string;
};

type AssignBody = {
  rawBarcode?: string;
  productId?: string;
  isPrimary?: boolean;
  note?: string;
};

const productInclude = (siteId: string) => ({
  medication: true,
  manufacturer: true,
  barcodes: {
    orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
  },
  lots: {
    where: { siteId },
    orderBy: { lotNumber: "asc" as const },
  },
  expirations: {
    where: { siteId },
    orderBy: { expirationDate: "asc" as const },
  },
});

async function recordTraceability(
  tx: Prisma.TransactionClient,
  input: {
    siteId: string;
    productId: string;
    lotNumber: string | null;
    expirationDate: Date | null;
  },
) {
  let lot = null;
  let expiration = null;

  if (input.lotNumber) {
    const lotNumberSearch = input.lotNumber
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase();

    lot = await tx.productLot.upsert({
      where: {
        siteId_productId_lotNumberSearch: {
          siteId: input.siteId,
          productId: input.productId,
          lotNumberSearch,
        },
      },
      update: { active: true },
      create: {
        siteId: input.siteId,
        productId: input.productId,
        lotNumber: input.lotNumber,
        lotNumberSearch,
        receivedAt: new Date(),
      },
    });
  }

  if (input.expirationDate) {
    expiration = await tx.productExpiration.upsert({
      where: {
        siteId_productId_expirationDate: {
          siteId: input.siteId,
          productId: input.productId,
          expirationDate: input.expirationDate,
        },
      },
      update: { active: true },
      create: {
        siteId: input.siteId,
        productId: input.productId,
        expirationDate: input.expirationDate,
      },
    });
  }

  return { lot, expiration };
}

export async function receivingRoutes(app: FastifyInstance) {
  app.post("/receiving/scan", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as ScanBody;
      const parsed = parseBarcode(body.rawBarcode ?? "");

      if (!parsed) {
        return reply.code(400).send({ error: "A barcode scan is required." });
      }

      const barcode = await db.productBarcode.findUnique({
        where: {
          type_identifierSearch: {
            type: parsed.type,
            identifierSearch: parsed.identifierSearch,
          },
        },
        include: {
          product: { include: productInclude(actor.siteId) },
        },
      });

      if (!barcode) {
        return {
          status: "UNKNOWN",
          parsed,
          product: null,
          barcode: null,
          traceability: null,
        };
      }

      const traceability = await db.$transaction(async (tx) => {
        const recorded = await recordTraceability(tx, {
          siteId: actor.siteId,
          productId: barcode.productId,
          lotNumber: parsed.lotNumber,
          expirationDate: parsed.expirationDate,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "RECEIVING_BARCODE_RECOGNIZED",
          entityType: "ProductBarcode",
          entityId: barcode.id,
          requestId: request.id,
          metadata: {
            productId: barcode.productId,
            identifier: parsed.identifier,
            lotNumber: parsed.lotNumber,
            expirationDate: parsed.expirationDate?.toISOString() ?? null,
          },
        });

        return recorded;
      });

      return {
        status: "KNOWN",
        parsed,
        barcode,
        product: barcode.product,
        traceability,
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/receiving/assign", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = (request.body ?? {}) as AssignBody;
      const parsed = parseBarcode(body.rawBarcode ?? "");

      if (!parsed || !body.productId) {
        return reply.code(400).send({
          error: "rawBarcode and productId are required.",
        });
      }

      const product = await db.product.findUnique({
        where: { id: body.productId },
        include: productInclude(actor.siteId),
      });

      if (!product || !product.active) {
        return reply.code(404).send({ error: "Active product not found." });
      }

      const existing = await db.productBarcode.findUnique({
        where: {
          type_identifierSearch: {
            type: parsed.type,
            identifierSearch: parsed.identifierSearch,
          },
        },
      });

      if (existing && existing.productId !== product.id) {
        return reply.code(409).send({
          error: "That barcode identifier is already assigned to another product.",
          code: "BARCODE_ALREADY_ASSIGNED",
        });
      }

      const result = await db.$transaction(async (tx) => {
        const currentPrimary = await tx.productBarcode.findFirst({
          where: { productId: product.id, isPrimary: true },
        });

        const barcode =
          existing ??
          (await tx.productBarcode.create({
            data: {
              productId: product.id,
              type: parsed.type,
              identifier: parsed.identifier,
              identifierSearch: parsed.identifierSearch,
              isPrimary: body.isPrimary ?? !currentPrimary,
              note: body.note?.trim() || undefined,
            },
          }));

        const traceability = await recordTraceability(tx, {
          siteId: actor.siteId,
          productId: product.id,
          lotNumber: parsed.lotNumber,
          expirationDate: parsed.expirationDate,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "RECEIVING_BARCODE_ASSIGNED",
          entityType: "ProductBarcode",
          entityId: barcode.id,
          requestId: request.id,
          metadata: {
            productId: product.id,
            medicationId: product.medicationId,
            ndc: product.ndc,
            identifier: parsed.identifier,
            lotNumber: parsed.lotNumber,
            expirationDate: parsed.expirationDate?.toISOString() ?? null,
          },
        });

        return { barcode, traceability };
      });

      return reply.code(existing ? 200 : 201).send({
        status: "ASSIGNED",
        parsed,
        product,
        ...result,
      });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
