import { Prisma } from "@prisma/client";
import { InventoryError } from "./inventoryError.js";

export function addBusinessDays(start: Date, days: number) {
  const result = new Date(start);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const weekday = result.getDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return result;
}

export function calculateNcPatientDiscardDate(
  dispensedAt: Date,
  sourceExpirations: Date[],
) {
  const oneYear = new Date(dispensedAt);
  oneYear.setFullYear(oneYear.getFullYear() + 1);

  const earliestExpiration = sourceExpirations.reduce<Date | null>(
    (earliest, expiration) =>
      !earliest || expiration.getTime() < earliest.getTime()
        ? expiration
        : earliest,
    null,
  );

  if (!earliestExpiration) return oneYear;
  return earliestExpiration.getTime() < oneYear.getTime()
    ? earliestExpiration
    : oneYear;
}

export async function validateFillProductSourceCompliance(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    productId: string;
  },
) {
  const fill = await tx.prescriptionFill.findUnique({
    where: { id: input.fillId },
    include: {
      prescription: {
        select: {
          id: true,
          patientId: true,
          medicationId: true,
          productSelectionDirective: true,
          prescribedProductId: true,
        },
      },
      productSources: {
        include: {
          product: true,
          manufacturer: true,
        },
        orderBy: { sequence: "asc" },
      },
      ntiManufacturerConsents: true,
    },
  });

  if (!fill) {
    throw new InventoryError(404, "FILL_NOT_FOUND", "Fill not found.");
  }

  const product = await tx.product.findUnique({
    where: { id: input.productId },
    include: {
      medication: true,
      manufacturer: true,
    },
  });

  if (!product || !product.active) {
    throw new InventoryError(
      404,
      "PRODUCT_NOT_FOUND",
      "The scanned product is not active in the Drug/Product catalog.",
    );
  }

  if (
    !fill.prescription.medicationId ||
    product.medicationId !== fill.prescription.medicationId
  ) {
    throw new InventoryError(
      409,
      "PRODUCT_DRUG_MISMATCH",
      "The scanned NDC does not belong to the Drug selected during Data Entry.",
      {
        expectedMedicationId: fill.prescription.medicationId,
        scannedMedicationId: product.medicationId,
      },
    );
  }

  if (
    fill.prescription.productSelectionDirective === "DISPENSE_AS_WRITTEN"
  ) {
    if (!fill.prescription.prescribedProductId) {
      throw new InventoryError(
        409,
        "DAW_PRESCRIBED_PRODUCT_REQUIRED",
        "This prescription prohibits product selection, but the prescribed product/NDC has not been identified.",
      );
    }

    if (product.id !== fill.prescription.prescribedProductId) {
      throw new InventoryError(
        409,
        "DAW_PRODUCT_SELECTION_BLOCKED",
        "The prescriber prohibited product selection; only the prescribed product may be used.",
        {
          prescribedProductId: fill.prescription.prescribedProductId,
          scannedProductId: product.id,
        },
      );
    }
  }

  for (const existing of fill.productSources) {
    const existingCode = existing.product.therapeuticEquivalenceCode;
    const candidateCode = product.therapeuticEquivalenceCode;
    if (
      existing.productId !== product.id &&
      existingCode &&
      candidateCode &&
      existingCode !== candidateCode
    ) {
      throw new InventoryError(
        409,
        "THERAPEUTIC_EQUIVALENCE_MISMATCH",
        "The scanned NDC is not in the same configured therapeutic-equivalence group as the existing fill source.",
        {
          existingProductId: existing.productId,
          existingTherapeuticEquivalenceCode: existingCode,
          scannedProductId: product.id,
          scannedTherapeuticEquivalenceCode: candidateCode,
        },
      );
    }
  }

  const existingManufacturers = new Set(
    fill.productSources.map((source) => source.manufacturerId),
  );

  if (
    product.medication.ncNarrowTherapeuticIndex &&
    existingManufacturers.size > 0 &&
    !existingManufacturers.has(product.manufacturerId)
  ) {
    throw new InventoryError(
      409,
      "NC_NTI_SPLIT_MANUFACTURER_BLOCKED",
      "North Carolina NTI safety policy does not permit multiple manufacturers in the same physical dispense. Multiple lots from the same manufacturer remain permitted.",
    );
  }

  if (
    product.medication.isBiological &&
    existingManufacturers.size > 0 &&
    !existingManufacturers.has(product.manufacturerId)
  ) {
    throw new InventoryError(
      409,
      "NC_BIOLOGIC_SPLIT_MANUFACTURER_BLOCKED",
      "Mixed-manufacturer biological-product filling is disabled. Use one manufacturer for the physical dispense.",
    );
  }

  let priorManufacturerId: string | null = null;
  let priorManufacturerName: string | null = null;

  if (product.medication.ncNarrowTherapeuticIndex) {
    const priorSource = await tx.fillProductSource.findFirst({
      where: {
        fillId: { not: fill.id },
        returnedAt: null,
        fill: {
          status: "SOLD",
          prescription: {
            patientId: fill.prescription.patientId,
            medicationId: product.medicationId,
          },
        },
      },
      include: {
        manufacturer: true,
        fill: true,
      },
      orderBy: {
        fill: {
          soldAt: "desc",
        },
      },
    });

    if (priorSource) {
      priorManufacturerId = priorSource.manufacturerId;
      priorManufacturerName = priorSource.manufacturer.name;

      if (priorSource.manufacturerId !== product.manufacturerId) {
        const consent = fill.ntiManufacturerConsents.find(
          (item) =>
            item.priorManufacturerId === priorSource.manufacturerId &&
            item.newManufacturerId === product.manufacturerId,
        );

        if (!consent) {
          throw new InventoryError(
            409,
            "NC_NTI_MANUFACTURER_CONSENT_REQUIRED",
            "North Carolina requires documented prescriber notification/consent and patient consent before changing manufacturers for continuing NTI therapy.",
            {
              priorManufacturerId: priorSource.manufacturerId,
              priorManufacturerName: priorSource.manufacturer.name,
              newManufacturerId: product.manufacturerId,
              newManufacturerName: product.manufacturer.name,
            },
          );
        }
      }
    }
  }

  return {
    fill,
    product,
    priorManufacturerId,
    priorManufacturerName,
  };
}

export async function ensureBiologicCommunicationTask(
  tx: Prisma.TransactionClient,
  input: {
    fillId: string;
    siteId: string;
    dispensedAt: Date;
  },
) {
  const fill = await tx.prescriptionFill.findUnique({
    where: { id: input.fillId },
    include: {
      prescription: {
        include: { medication: true },
      },
      productSources: {
        include: {
          product: true,
          manufacturer: true,
        },
        orderBy: { sequence: "asc" },
      },
    },
  });

  if (
    !fill?.prescription.medication?.isBiological ||
    !fill.prescription.medication.hasFdaInterchangeableBiologicAlternative ||
    fill.productSources.length === 0
  ) {
    return null;
  }

  const current = fill.productSources[0]!;
  const prior = await tx.fillProductSource.findFirst({
    where: {
      fillId: { not: fill.id },
      returnedAt: null,
      fill: {
        status: "SOLD",
        prescription: {
          patientId: fill.prescription.patientId,
          medicationId: fill.prescription.medicationId,
        },
      },
    },
    include: { fill: true },
    orderBy: {
      fill: { soldAt: "desc" },
    },
  });

  if (
    prior &&
    prior.productId === current.productId &&
    prior.manufacturerId === current.manufacturerId
  ) {
    return null;
  }

  const dueAt = addBusinessDays(input.dispensedAt, 5);
  return tx.biologicCommunicationTask.upsert({
    where: { fillId: fill.id },
    update: {
      status: "OPEN",
      productName:
        current.product.descriptor ||
        fill.prescription.medicationName,
      manufacturerName: current.manufacturerSnapshot,
      dueAt,
      completedById: null,
      completedAt: null,
      note: null,
      exemptReason: null,
    },
    create: {
      siteId: input.siteId,
      fillId: fill.id,
      status: "OPEN",
      productName:
        current.product.descriptor ||
        fill.prescription.medicationName,
      manufacturerName: current.manufacturerSnapshot,
      dueAt,
    },
  });
}
