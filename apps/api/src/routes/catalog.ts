import type { ProductUnit } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { parseBarcode } from "../barcode.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type MedicationQuery = {
  query?: string;
};

type CreateMedicationBody = {
  genericName?: string;
  brandName?: string;
  strength?: string;
  dosageForm?: string;
  route?: string;
};

type CreateProductBody = {
  ndc?: string;
  manufacturerName?: string;
  manufacturerLabelerCode?: string;
  descriptor?: string;
  packageDescription?: string;
  packageType?: string;
  unitsPerPackage?: number;
  dispensingUnit?: ProductUnit;
  unitPrice?: number;
  packagePrice?: number;
};

type CreateLotBody = {
  lotNumber?: string;
  receivedAt?: string;
};

type CreateExpirationBody = {
  expirationDate?: string;
};

type CreateBarcodeBody = {
  rawBarcode?: string;
  isPrimary?: boolean;
  note?: string;
};

function normalizeNdc(value?: string) {
  return (value ?? "").replace(/\D/g, "");
}

function normalizeLotNumber(value?: string) {
  return (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function parseDate(value?: string) {
  if (!value?.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function positiveNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonnegativeNumber(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

const productInclude = (siteId: string) => ({
  manufacturer: true,
  lots: {
    where: { siteId },
    orderBy: [{ lotNumber: "asc" as const }],
  },
  expirations: {
    where: { siteId },
    orderBy: [{ expirationDate: "asc" as const }],
  },
  barcodes: {
    orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
  },
});

export async function catalogRoutes(app: FastifyInstance) {
  app.get("/medications", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:read");
      const { query } = request.query as MedicationQuery;
      const raw = query?.trim();
      const ndcSearch = normalizeNdc(raw);
      const lotSearch = normalizeLotNumber(raw);

      const medications = await db.medication.findMany({
        where: raw
          ? {
              OR: [
                { genericName: { contains: raw, mode: "insensitive" } },
                { brandName: { contains: raw, mode: "insensitive" } },
                { strength: { contains: raw, mode: "insensitive" } },
                { dosageForm: { contains: raw, mode: "insensitive" } },
                { route: { contains: raw, mode: "insensitive" } },
                {
                  products: {
                    some: {
                      OR: [
                        { descriptor: { contains: raw, mode: "insensitive" } },
                        { packageDescription: { contains: raw, mode: "insensitive" } },
                        { packageType: { contains: raw, mode: "insensitive" } },
                        ...(ndcSearch
                          ? [{ ndcSearch: { contains: ndcSearch } }]
                          : []),
                        {
                          manufacturer: {
                            name: { contains: raw, mode: "insensitive" },
                          },
                        },
                        ...(lotSearch
                          ? [
                              {
                                lots: {
                                  some: {
                                    siteId: actor.siteId,
                                    lotNumberSearch: { contains: lotSearch },
                                  },
                                },
                              },
                            ]
                          : []),
                      ],
                    },
                  },
                },
              ],
            }
          : undefined,
        include: {
          products: {
            include: productInclude(actor.siteId),
            orderBy: [
              { manufacturer: { name: "asc" } },
              { ndcSearch: "asc" },
            ],
          },
        },
        orderBy: [
          { genericName: "asc" },
          { strength: "asc" },
          { dosageForm: "asc" },
        ],
        take: 200,
      });

      return { medications };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/medications", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const body = request.body as CreateMedicationBody;

      if (
        !body.genericName?.trim() ||
        !body.strength?.trim() ||
        !body.dosageForm?.trim()
      ) {
        return reply.code(400).send({
          error: "genericName, strength, and dosageForm are required.",
        });
      }

      const medication = await db.$transaction(async (tx) => {
        const created = await tx.medication.create({
          data: {
            genericName: body.genericName!.trim(),
            brandName: body.brandName?.trim() || undefined,
            strength: body.strength!.trim(),
            dosageForm: body.dosageForm!.trim(),
            route: body.route?.trim() || undefined,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "MEDICATION_CREATED",
          entityType: "Medication",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            genericName: created.genericName,
            strength: created.strength,
            dosageForm: created.dosageForm,
          },
        });

        return created;
      });

      return reply.code(201).send({ medication });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/medications/:id/products", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const medicationId = (request.params as { id: string }).id;
      const body = request.body as CreateProductBody;

      const ndc = body.ndc?.trim();
      const ndcSearch = normalizeNdc(ndc);
      const descriptor = body.descriptor?.trim();
      const packageType = body.packageType?.trim();
      const unitsPerPackage = positiveNumber(body.unitsPerPackage);
      const suppliedUnitPrice = nonnegativeNumber(body.unitPrice);
      const suppliedPackagePrice = nonnegativeNumber(body.packagePrice);

      if (
        !ndc ||
        !body.manufacturerName?.trim() ||
        !descriptor ||
        !packageType ||
        !body.dispensingUnit
      ) {
        return reply.code(400).send({
          error:
            "NDC, manufacturer, descriptor, package type, units per package, and dispensing unit are required.",
        });
      }

      if (unitsPerPackage === null) {
        return reply.code(400).send({
          error: "unitsPerPackage must be a number greater than zero.",
        });
      }

      if (suppliedUnitPrice === null || suppliedPackagePrice === null) {
        return reply.code(400).send({
          error: "Prices must be zero or greater when entered.",
        });
      }

      if (![10, 11].includes(ndcSearch.length)) {
        return reply.code(400).send({
          error: "NDC must contain 10 or 11 digits in this prototype.",
        });
      }

      const medication = await db.medication.findUnique({
        where: { id: medicationId },
        select: { id: true, dosageForm: true },
      });
      if (!medication) {
        return reply.code(404).send({ error: "Medication not found." });
      }

      const duplicate = await db.product.findUnique({
        where: { ndcSearch },
        select: { id: true },
      });
      if (duplicate) {
        return reply.code(409).send({
          error: "That normalized NDC is already assigned to a product.",
        });
      }

      let unitPrice = suppliedUnitPrice;
      let packagePrice = suppliedPackagePrice;

      if (unitPrice === undefined && packagePrice !== undefined) {
        unitPrice = packagePrice / unitsPerPackage;
      } else if (packagePrice === undefined && unitPrice !== undefined) {
        packagePrice = unitPrice * unitsPerPackage;
      }

      const product = await db.$transaction(async (tx) => {
        const existingManufacturer = await tx.manufacturer.findFirst({
          where: {
            name: {
              equals: body.manufacturerName!.trim(),
              mode: "insensitive",
            },
          },
        });

        const manufacturer =
          existingManufacturer ??
          (await tx.manufacturer.create({
            data: {
              name: body.manufacturerName!.trim(),
              labelerCode: body.manufacturerLabelerCode?.trim() || undefined,
            },
          }));

        const created = await tx.product.create({
          data: {
            medicationId,
            manufacturerId: manufacturer.id,
            ndc,
            ndcSearch,
            descriptor,
            packageDescription: body.packageDescription?.trim() || undefined,
            packageType,
            unitsPerPackage,
            dispensingUnit: body.dispensingUnit,
            unitPrice,
            packagePrice,
          },
          include: productInclude(actor.siteId),
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRODUCT_CREATED",
          entityType: "Product",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            medicationId,
            dosageForm: medication.dosageForm,
            ndc,
            ndcSearch,
            descriptor,
            manufacturerId: manufacturer.id,
            manufacturerName: manufacturer.name,
            packageType,
            unitsPerPackage,
            dispensingUnit: body.dispensingUnit,
            unitPrice,
            packagePrice,
          },
        });

        return created;
      });

      return reply.code(201).send({ product });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/products/:id/lots", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const productId = (request.params as { id: string }).id;
      const body = request.body as CreateLotBody;

      const lotNumber = body.lotNumber?.trim();
      const lotNumberSearch = normalizeLotNumber(lotNumber);
      const receivedAt = parseDate(body.receivedAt);

      if (!lotNumber || !lotNumberSearch) {
        return reply.code(400).send({
          error: "lotNumber is required.",
        });
      }

      if (receivedAt === null) {
        return reply.code(400).send({ error: "Invalid received date." });
      }

      const product = await db.product.findUnique({
        where: { id: productId },
        include: { manufacturer: true, medication: true },
      });

      if (!product) {
        return reply.code(404).send({ error: "Product not found." });
      }

      const duplicate = await db.productLot.findFirst({
        where: {
          siteId: actor.siteId,
          productId,
          lotNumberSearch,
        },
      });

      if (duplicate) {
        return reply.code(409).send({
          error: "That lot number is already stored for this NDC at this site.",
        });
      }

      const lot = await db.$transaction(async (tx) => {
        const created = await tx.productLot.create({
          data: {
            siteId: actor.siteId,
            productId,
            lotNumber,
            lotNumberSearch,
            receivedAt: receivedAt ?? undefined,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRODUCT_LOT_RECORDED",
          entityType: "ProductLot",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            productId,
            medicationId: product.medicationId,
            ndc: product.ndc,
            manufacturerName: product.manufacturer.name,
            lotNumber,
          },
        });

        return created;
      });

      return reply.code(201).send({ lot });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/products/:id/expirations", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const productId = (request.params as { id: string }).id;
      const body = request.body as CreateExpirationBody;
      const expirationDate = parseDate(body.expirationDate);

      if (!body.expirationDate?.trim()) {
        return reply.code(400).send({
          error: "expirationDate is required.",
        });
      }

      if (expirationDate === null) {
        return reply.code(400).send({ error: "Invalid expiration date." });
      }

      const product = await db.product.findUnique({
        where: { id: productId },
        include: { manufacturer: true, medication: true },
      });

      if (!product) {
        return reply.code(404).send({ error: "Product not found." });
      }

      const duplicate = await db.productExpiration.findFirst({
        where: {
          siteId: actor.siteId,
          productId,
          expirationDate: expirationDate!,
        },
      });

      if (duplicate) {
        return reply.code(409).send({
          error: "That expiration date is already stored for this NDC at this site.",
        });
      }

      const expiration = await db.$transaction(async (tx) => {
        const created = await tx.productExpiration.create({
          data: {
            siteId: actor.siteId,
            productId,
            expirationDate: expirationDate!,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRODUCT_EXPIRATION_RECORDED",
          entityType: "ProductExpiration",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            productId,
            medicationId: product.medicationId,
            ndc: product.ndc,
            manufacturerName: product.manufacturer.name,
            expirationDate: expirationDate!.toISOString(),
          },
        });

        return created;
      });

      return reply.code(201).send({ expiration });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/products/:id/barcodes", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "inventory:write");
      const productId = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as CreateBarcodeBody;
      const parsed = parseBarcode(body.rawBarcode ?? "");

      if (!parsed) {
        return reply.code(400).send({ error: "A barcode value is required." });
      }

      const product = await db.product.findUnique({
        where: { id: productId },
        include: { medication: true, manufacturer: true },
      });

      if (!product) {
        return reply.code(404).send({ error: "Product not found." });
      }

      const conflicting = await db.productBarcode.findUnique({
        where: {
          type_identifierSearch: {
            type: parsed.type,
            identifierSearch: parsed.identifierSearch,
          },
        },
        include: {
          product: { include: { medication: true, manufacturer: true } },
        },
      });

      if (conflicting && conflicting.productId !== productId) {
        return reply.code(409).send({
          error: "That barcode identifier is already assigned to another product.",
          code: "BARCODE_ALREADY_ASSIGNED",
          assignedProduct: conflicting.product,
        });
      }

      const result = await db.$transaction(async (tx) => {
        const currentPrimary = await tx.productBarcode.findFirst({
          where: { productId, isPrimary: true },
        });

        const barcode =
          conflicting ??
          (await tx.productBarcode.create({
            data: {
              productId,
              type: parsed.type,
              identifier: parsed.identifier,
              identifierSearch: parsed.identifierSearch,
              isPrimary: body.isPrimary ?? !currentPrimary,
              note: body.note?.trim() || undefined,
            },
          }));

        if (body.isPrimary && !barcode.isPrimary) {
          await tx.productBarcode.updateMany({
            where: { productId, id: { not: barcode.id } },
            data: { isPrimary: false },
          });
          await tx.productBarcode.update({
            where: { id: barcode.id },
            data: { isPrimary: true },
          });
        }

        let lot = null;
        if (parsed.lotNumber) {
          const lotNumberSearch = parsed.lotNumber
            .replace(/[^A-Za-z0-9]/g, "")
            .toUpperCase();

          lot = await tx.productLot.upsert({
            where: {
              siteId_productId_lotNumberSearch: {
                siteId: actor.siteId,
                productId,
                lotNumberSearch,
              },
            },
            update: { active: true },
            create: {
              siteId: actor.siteId,
              productId,
              lotNumber: parsed.lotNumber,
              lotNumberSearch,
            },
          });
        }

        let expiration = null;
        if (parsed.expirationDate) {
          expiration = await tx.productExpiration.upsert({
            where: {
              siteId_productId_expirationDate: {
                siteId: actor.siteId,
                productId,
                expirationDate: parsed.expirationDate,
              },
            },
            update: { active: true },
            create: {
              siteId: actor.siteId,
              productId,
              expirationDate: parsed.expirationDate,
            },
          });
        }

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRODUCT_BARCODE_ASSIGNED",
          entityType: "ProductBarcode",
          entityId: barcode.id,
          requestId: request.id,
          metadata: {
            productId,
            medicationId: product.medicationId,
            ndc: product.ndc,
            type: parsed.type,
            identifier: parsed.identifier,
            parsedLot: parsed.lotNumber,
            parsedExpiration: parsed.expirationDate?.toISOString() ?? null,
          },
        });

        return { barcode, lot, expiration };
      });

      return reply.code(conflicting ? 200 : 201).send({
        ...result,
        parsed,
        product,
      });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

}
