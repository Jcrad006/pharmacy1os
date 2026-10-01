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

type CorrectBarcodeBody = {
  productId?: string;
  reason?: string;
  rawBarcode?: string;
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

  app.post("/receiving/barcodes/:id/correct", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:correct");
      const barcodeId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as CorrectBarcodeBody;
      const reason = body.reason?.trim();

      if (!body.productId || !reason) {
        return reply.code(400).send({
          error: "productId and a correction reason are required.",
        });
      }

      const [barcode, newProduct] = await Promise.all([
        db.productBarcode.findUnique({
          where: { id: barcodeId },
          include: {
            product: {
              include: {
                medication: true,
                manufacturer: true,
              },
            },
          },
        }),
        db.product.findUnique({
          where: { id: body.productId },
          include: productInclude(actor.siteId),
        }),
      ]);

      if (!barcode) {
        return reply.code(404).send({ error: "Barcode assignment not found." });
      }

      if (!newProduct || !newProduct.active) {
        return reply.code(404).send({ error: "Active replacement product not found." });
      }

      if (barcode.productId === newProduct.id) {
        return reply.code(409).send({
          error: "The barcode is already assigned to that product.",
        });
      }

      const parsed = body.rawBarcode?.trim()
        ? parseBarcode(body.rawBarcode)
        : null;

      if (
        parsed &&
        (parsed.type !== barcode.type ||
          parsed.identifierSearch !== barcode.identifierSearch)
      ) {
        return reply.code(409).send({
          error:
            "The rescanned barcode does not match the barcode assignment being corrected.",
          code: "CORRECTION_BARCODE_MISMATCH",
        });
      }

      const originalAssignment = await db.auditEvent.findFirst({
        where: {
          siteId: actor.siteId,
          action: "RECEIVING_BARCODE_ASSIGNED",
          entityType: "ProductBarcode",
          entityId: barcode.id,
        },
        orderBy: { occurredAt: "asc" },
        include: {
          actor: {
            select: {
              id: true,
              displayName: true,
              role: true,
            },
          },
        },
      });

      const historicalUseEvents = await db.auditEvent.findMany({
        where: {
          siteId: actor.siteId,
          action: "FILL_BARCODE_SCAN_VERIFIED",
        },
        select: { metadata: true },
      });

      const historicalUseCount = historicalUseEvents.filter((event) => {
        const metadata =
          event.metadata && typeof event.metadata === "object"
            ? (event.metadata as Record<string, unknown>)
            : null;
        return metadata?.productBarcodeId === barcode.id;
      }).length;

      let oldTraceabilityMatches = {
        lot: false,
        expiration: false,
      };

      if (parsed?.lotNumber) {
        const lotNumberSearch = parsed.lotNumber
          .replace(/[^A-Za-z0-9]/g, "")
          .toUpperCase();
        oldTraceabilityMatches.lot = Boolean(
          await db.productLot.findFirst({
            where: {
              siteId: actor.siteId,
              productId: barcode.productId,
              lotNumberSearch,
              active: true,
            },
            select: { id: true },
          }),
        );
      }

      if (parsed?.expirationDate) {
        oldTraceabilityMatches.expiration = Boolean(
          await db.productExpiration.findFirst({
            where: {
              siteId: actor.siteId,
              productId: barcode.productId,
              expirationDate: parsed.expirationDate,
              active: true,
            },
            select: { id: true },
          }),
        );
      }

      const result = await db.$transaction(async (tx) => {
        const oldProductId = barcode.productId;
        const oldProduct = barcode.product;

        const newProductPrimary = await tx.productBarcode.findFirst({
          where: { productId: newProduct.id, isPrimary: true },
          select: { id: true },
        });

        if (barcode.isPrimary) {
          const replacementOldPrimary = await tx.productBarcode.findFirst({
            where: {
              productId: oldProductId,
              id: { not: barcode.id },
            },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          });

          if (replacementOldPrimary) {
            await tx.productBarcode.update({
              where: { id: replacementOldPrimary.id },
              data: { isPrimary: true },
            });
          }
        }

        const corrected = await tx.productBarcode.update({
          where: { id: barcode.id },
          data: {
            productId: newProduct.id,
            isPrimary: !newProductPrimary,
            note: barcode.note
              ? `${barcode.note} | Corrected: ${reason}`
              : `Corrected: ${reason}`,
          },
        });

        const traceability = parsed
          ? await recordTraceability(tx, {
              siteId: actor.siteId,
              productId: newProduct.id,
              lotNumber: parsed.lotNumber,
              expirationDate: parsed.expirationDate,
            })
          : { lot: null, expiration: null };

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRODUCT_BARCODE_ASSIGNMENT_CORRECTED",
          entityType: "ProductBarcode",
          entityId: barcode.id,
          requestId: request.id,
          metadata: {
            reason,
            originalAssignment: {
              auditEventId: originalAssignment?.id ?? null,
              actorId: originalAssignment?.actorId ?? null,
              actorDisplayName: originalAssignment?.actor?.displayName ?? null,
              actorRole: originalAssignment?.actor?.role ?? null,
              occurredAt: (
                originalAssignment?.occurredAt ?? barcode.createdAt
              ).toISOString(),
              source: originalAssignment ? "AUDIT_EVENT" : "BARCODE_CREATED_AT",
            },
            correctingActor: {
              id: actor.id,
              displayName: actor.displayName,
              role: actor.role,
            },
            oldProductId,
            oldMedicationId: oldProduct.medicationId,
            oldDrug: `${oldProduct.medication.genericName} ${oldProduct.medication.strength} ${oldProduct.medication.dosageForm}`,
            oldNdc: oldProduct.ndc,
            newProductId: newProduct.id,
            newMedicationId: newProduct.medicationId,
            newDrug: `${newProduct.medication.genericName} ${newProduct.medication.strength} ${newProduct.medication.dosageForm}`,
            newNdc: newProduct.ndc,
            barcodeType: barcode.type,
            identifier: barcode.identifier,
            rescannedLot: parsed?.lotNumber ?? null,
            rescannedExpiration: parsed?.expirationDate?.toISOString() ?? null,
            oldTraceabilityMatches,
            historicalUseCount,
          },
        });

        return { corrected, traceability };
      });

      return {
        status: "CORRECTED",
        barcode: result.corrected,
        product: newProduct,
        traceability: result.traceability,
        safetyReview: {
          oldProduct: barcode.product,
          originalAssignment: {
            auditEventId: originalAssignment?.id ?? null,
            actorId: originalAssignment?.actorId ?? null,
            actorDisplayName: originalAssignment?.actor?.displayName ?? null,
            actorRole: originalAssignment?.actor?.role ?? null,
            occurredAt: (
              originalAssignment?.occurredAt ?? barcode.createdAt
            ).toISOString(),
            source: originalAssignment ? "AUDIT_EVENT" : "BARCODE_CREATED_AT",
          },
          historicalUseCount,
          oldTraceabilityMatches,
          message:
            historicalUseCount > 0
              ? "This barcode was previously used on one or more prescription fills. Review those fills for potential product-selection error."
              : oldTraceabilityMatches.lot || oldTraceabilityMatches.expiration
                ? "Matching lot and/or expiration data remains under the old NDC. Review those records before deactivating anything."
                : null,
        },
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

}
