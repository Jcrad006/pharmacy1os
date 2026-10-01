import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PaymentMethod,
  type PickupFulfillmentMode,
  type PickupIdentityMethod,
  type PickupSignatureMethod,
  type PosPriceBasis,
} from "@prisma/client";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";

export class PosError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type PosActorContext = {
  siteId: string;
  actorId: string;
  requestId?: string;
};

export type PosTenderInput = {
  method: PaymentMethod;
  amount: number | string | Prisma.Decimal;
  reference?: string | null;
};

export type PickupVerificationInput = {
  recipientName: string;
  relationship?: string | null;
  identityMethod: PickupIdentityMethod;
  identityValue?: string | null;
  signatureMethod: PickupSignatureMethod;
  signatureName?: string | null;
  signatureReference?: string | null;
};

export type PickupPackageInput = {
  fillId: string;
  bagBarcode: string;
};

const paymentMethods = new Set<PaymentMethod>([
  "CASH",
  "CARD",
  "CHECK",
  "OTHER",
]);

const pickupIdentityMethods = new Set<PickupIdentityMethod>([
  "DATE_OF_BIRTH",
  "ADDRESS",
  "GOVERNMENT_ID",
  "KNOWN_PATIENT",
  "OTHER",
]);

const pickupSignatureMethods = new Set<PickupSignatureMethod>([
  "ELECTRONIC_TYPED",
  "EXTERNAL_DEVICE",
  "PAPER",
]);

const MAX_CHECKOUT_FILLS = 20;

function money(value: Prisma.Decimal | number | string) {
  const decimal =
    value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  return decimal.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function activeOnDate(
  coverage: {
    active: boolean;
    effectiveDate: Date | null;
    terminationDate: Date | null;
  },
  at: Date,
) {
  return (
    coverage.active &&
    (!coverage.effectiveDate || coverage.effectiveDate.getTime() <= at.getTime()) &&
    (!coverage.terminationDate || coverage.terminationDate.getTime() >= at.getTime())
  );
}

async function activePaidClaim(
  tx: Prisma.TransactionClient,
  fillId: string,
) {
  const transactions = await tx.claimTransaction.findMany({
    where: { fillId },
    orderBy: [
      { coveragePosition: "asc" },
      { createdAt: "asc" },
    ],
  });
  const reversedIds = new Set(
    transactions
      .filter(
        (item) =>
          item.operation === "REVERSAL" &&
          item.outcome === "REVERSED" &&
          item.originalTransactionId,
      )
      .map((item) => item.originalTransactionId as string),
  );

  return (
    transactions
      .filter(
        (item) =>
          item.operation === "SUBMIT" &&
          item.outcome === "PAID" &&
          !reversedIds.has(item.id),
      )
      .sort((a, b) => {
        if (a.coveragePosition !== b.coveragePosition) {
          return b.coveragePosition - a.coveragePosition;
        }
        return b.createdAt.getTime() - a.createdAt.getTime();
      })[0] ?? null
  );
}

async function resolveWillCallLocation(
  tx: Prisma.TransactionClient,
  context: PosActorContext,
  input: {
    locationId?: string | null;
    locationBarcode?: string | null;
  },
  options: { allowDefault: boolean },
) {
  const requestedLocationBarcode =
    input.locationBarcode?.trim().toUpperCase() || null;

  const location = input.locationId
    ? await tx.inventoryLocation.findFirst({
        where: {
          id: input.locationId,
          siteId: context.siteId,
          active: true,
        },
      })
    : requestedLocationBarcode
      ? await tx.inventoryLocation.findFirst({
          where: {
            siteId: context.siteId,
            barcode: requestedLocationBarcode,
            active: true,
          },
        })
      : options.allowDefault
        ? await tx.inventoryLocation.findFirst({
            where: {
              siteId: context.siteId,
              code: "WILL-CALL",
              active: true,
            },
          })
        : null;

  if (!location || location.type !== "WILL_CALL") {
    throw new PosError(
      409,
      "WILL_CALL_LOCATION_REQUIRED",
      "Scan or select an active Will Call location.",
    );
  }

  return location;
}

async function assertUnusedWillCallBagBarcode(
  tx: Prisma.TransactionClient,
  bagBarcode: string,
) {
  const prior = await tx.willCallBagBarcode.findUnique({
    where: { barcode: bagBarcode },
    include: {
      package: {
        select: {
          id: true,
          fillId: true,
          bagBarcode: true,
          status: true,
        },
      },
    },
  });

  if (prior) {
    throw new PosError(
      409,
      prior.status === "VOIDED"
        ? "BAG_BARCODE_RETIRED"
        : "BAG_BARCODE_IN_USE",
      prior.status === "VOIDED"
        ? "That bag barcode was previously used and retired. Use a new physical bag barcode."
        : "That bag barcode is already assigned to another fill.",
      {
        fillId: prior.package.fillId,
        willCallPackageId: prior.package.id,
        currentBagBarcode: prior.package.bagBarcode,
        packageStatus: prior.package.status,
      },
    );
  }
}

async function requireOpenWillCallPackage(
  tx: Prisma.TransactionClient,
  fillId: string,
  context: PosActorContext,
) {
  const fill = await tx.prescriptionFill.findFirst({
    where: {
      id: fillId,
      prescription: { siteId: context.siteId },
    },
    include: {
      prescription: true,
      willCallPackage: {
        include: { location: true },
      },
    },
  });

  if (!fill) {
    throw new PosError(404, "FILL_NOT_FOUND", "Fill not found.");
  }
  if (fill.status !== "READY" || fill.prescription.status !== "READY") {
    throw new PosError(
      409,
      "FILL_NOT_READY",
      "Only a pharmacist-verified ready fill can be changed in Will Call.",
    );
  }
  if (!fill.willCallPackage || fill.willCallPackage.status !== "STAGED") {
    throw new PosError(
      409,
      "WILL_CALL_PACKAGE_NOT_STAGED",
      "The fill does not have an active staged Will Call package.",
    );
  }

  return fill;
}

export async function stageWillCallPackage(
  fillId: string,
  input: {
    bagBarcode?: string | null;
    locationId?: string | null;
    locationBarcode?: string | null;
  },
  context: PosActorContext,
) {
  return db.$transaction(async (tx) => {
    const fill = await tx.prescriptionFill.findFirst({
      where: {
        id: fillId,
        prescription: { siteId: context.siteId },
      },
      include: {
        prescription: true,
        prescriptionLabels: {
          where: { status: "ACTIVE" },
          select: { id: true },
          take: 1,
        },
        willCallPackage: true,
      },
    });

    if (!fill) {
      throw new PosError(404, "FILL_NOT_FOUND", "Fill not found.");
    }
    if (fill.status !== "READY" || fill.prescription.status !== "READY") {
      throw new PosError(
        409,
        "FILL_NOT_READY",
        "Only a pharmacist-verified ready fill can be staged in Will Call.",
      );
    }
    if (fill.prescriptionLabels.length === 0) {
      throw new PosError(
        409,
        "ACTIVE_LABEL_REQUIRED",
        "The fill must have an active dispensing label before Will Call staging.",
      );
    }
    if (fill.willCallPackage) {
      throw new PosError(
        409,
        fill.willCallPackage.status === "STAGED"
          ? "WILL_CALL_PACKAGE_ALREADY_STAGED"
          : "WILL_CALL_PACKAGE_CLOSED",
        fill.willCallPackage.status === "STAGED"
          ? "This fill is already staged. Use Relocate or Replace Bag for physical changes."
          : "This Will Call package has already left the staged queue.",
      );
    }

    const location = await resolveWillCallLocation(tx, context, input, {
      allowDefault: true,
    });
    const bagBarcode =
      input.bagBarcode?.trim().toUpperCase() ||
      `WC-BAG-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`;

    if (bagBarcode.length > 120) {
      throw new PosError(
        400,
        "INVALID_BAG_BARCODE",
        "Will Call bag barcodes must be 120 characters or fewer.",
      );
    }
    await assertUnusedWillCallBagBarcode(tx, bagBarcode);

    const packageRecord = await tx.willCallPackage.create({
      data: {
        siteId: context.siteId,
        fillId: fill.id,
        bagBarcode,
        locationId: location.id,
        stagedById: context.actorId,
      },
      include: { location: true },
    });

    await tx.willCallBagBarcode.create({
      data: {
        siteId: context.siteId,
        packageId: packageRecord.id,
        barcode: bagBarcode,
      },
    });
    await tx.willCallEvent.create({
      data: {
        siteId: context.siteId,
        packageId: packageRecord.id,
        eventType: "STAGED",
        actorId: context.actorId,
        newBagBarcode: bagBarcode,
        toLocationId: location.id,
      },
    });

    await writeAuditEvent(tx, {
      siteId: context.siteId,
      actorId: context.actorId,
      action: "WILL_CALL_PACKAGE_STAGED",
      entityType: "WillCallPackage",
      entityId: packageRecord.id,
      requestId: context.requestId,
      metadata: {
        fillId: fill.id,
        prescriptionId: fill.prescriptionId,
        bagBarcode,
        locationId: location.id,
        locationCode: location.code,
        locationBarcode: location.barcode,
      },
    });

    return packageRecord;
  });
}

export async function rebagWillCallPackage(
  fillId: string,
  input: { bagBarcode?: string | null },
  context: PosActorContext,
) {
  return db.$transaction(async (tx) => {
    const fill = await requireOpenWillCallPackage(tx, fillId, context);
    const packageRecord = fill.willCallPackage!;
    const newBagBarcode = input.bagBarcode?.trim().toUpperCase();

    if (!newBagBarcode) {
      throw new PosError(
        400,
        "NEW_BAG_BARCODE_REQUIRED",
        "Scan the replacement bag barcode.",
      );
    }
    if (newBagBarcode.length > 120) {
      throw new PosError(
        400,
        "INVALID_BAG_BARCODE",
        "Will Call bag barcodes must be 120 characters or fewer.",
      );
    }
    if (newBagBarcode === packageRecord.bagBarcode) {
      throw new PosError(
        409,
        "SAME_BAG_BARCODE",
        "The replacement bag barcode must be different from the current bag.",
      );
    }

    await assertUnusedWillCallBagBarcode(tx, newBagBarcode);
    const changedAt = new Date();

    await tx.willCallBagBarcode.updateMany({
      where: {
        packageId: packageRecord.id,
        barcode: packageRecord.bagBarcode,
        status: "ACTIVE",
      },
      data: {
        status: "VOIDED",
        voidedAt: changedAt,
      },
    });

    const updated = await tx.willCallPackage.update({
      where: { id: packageRecord.id },
      data: {
        bagBarcode: newBagBarcode,
        stagedById: context.actorId,
      },
      include: { location: true },
    });

    await tx.willCallBagBarcode.create({
      data: {
        siteId: context.siteId,
        packageId: packageRecord.id,
        barcode: newBagBarcode,
        assignedAt: changedAt,
      },
    });
    await tx.willCallEvent.create({
      data: {
        siteId: context.siteId,
        packageId: packageRecord.id,
        eventType: "REBAGGED",
        actorId: context.actorId,
        oldBagBarcode: packageRecord.bagBarcode,
        newBagBarcode,
        fromLocationId: packageRecord.locationId,
        toLocationId: packageRecord.locationId,
        occurredAt: changedAt,
      },
    });

    await writeAuditEvent(tx, {
      siteId: context.siteId,
      actorId: context.actorId,
      action: "WILL_CALL_PACKAGE_REBAGGED",
      entityType: "WillCallPackage",
      entityId: packageRecord.id,
      requestId: context.requestId,
      metadata: {
        fillId,
        oldBagBarcode: packageRecord.bagBarcode,
        newBagBarcode,
        locationId: packageRecord.locationId,
        locationCode: packageRecord.location.code,
      },
    });

    return updated;
  });
}

export async function relocateWillCallPackage(
  fillId: string,
  input: {
    locationId?: string | null;
    locationBarcode?: string | null;
  },
  context: PosActorContext,
) {
  return db.$transaction(async (tx) => {
    const fill = await requireOpenWillCallPackage(tx, fillId, context);
    const packageRecord = fill.willCallPackage!;
    const location = await resolveWillCallLocation(tx, context, input, {
      allowDefault: false,
    });

    if (location.id === packageRecord.locationId) {
      return packageRecord;
    }

    const changedAt = new Date();
    const updated = await tx.willCallPackage.update({
      where: { id: packageRecord.id },
      data: {
        locationId: location.id,
        stagedById: context.actorId,
      },
      include: { location: true },
    });

    await tx.willCallEvent.create({
      data: {
        siteId: context.siteId,
        packageId: packageRecord.id,
        eventType: "RELOCATED",
        actorId: context.actorId,
        oldBagBarcode: packageRecord.bagBarcode,
        newBagBarcode: packageRecord.bagBarcode,
        fromLocationId: packageRecord.locationId,
        toLocationId: location.id,
        occurredAt: changedAt,
      },
    });

    await writeAuditEvent(tx, {
      siteId: context.siteId,
      actorId: context.actorId,
      action: "WILL_CALL_PACKAGE_RELOCATED",
      entityType: "WillCallPackage",
      entityId: packageRecord.id,
      requestId: context.requestId,
      metadata: {
        fillId,
        bagBarcode: packageRecord.bagBarcode,
        fromLocationId: packageRecord.locationId,
        fromLocationCode: packageRecord.location.code,
        toLocationId: location.id,
        toLocationCode: location.code,
        toLocationBarcode: location.barcode,
      },
    });

    return updated;
  });
}

const pickupFulfillmentModes = new Set<PickupFulfillmentMode>([
  "WILL_CALL",
  "IMMEDIATE",
]);

function normalizeFulfillmentMode(
  mode: PickupFulfillmentMode | undefined,
): PickupFulfillmentMode {
  const resolved = mode ?? "WILL_CALL";
  if (!pickupFulfillmentModes.has(resolved)) {
    throw new PosError(
      400,
      "INVALID_PICKUP_FULFILLMENT_MODE",
      "Pickup fulfillment mode must be WILL_CALL or IMMEDIATE.",
    );
  }
  return resolved;
}

type CheckoutQuoteLine = {
  fillId: string;
  prescriptionId: string;
  patientId: string;
  rxNumber: string | null;
  medicationName: string;
  fillNumber: number;
  partNumber: number;
  quantity: Prisma.Decimal;
  priceBasis: PosPriceBasis;
  claimTransactionId: string | null;
  patientResponsibilitySnapshot: Prisma.Decimal | null;
  cashUnitPriceSnapshot: Prisma.Decimal | null;
  cashPricingSnapshot: Prisma.InputJsonValue;
  amountDue: Prisma.Decimal;
  pickupFulfillmentMode: PickupFulfillmentMode;
  willCallPackageId: string | null;
  bagBarcode: string | null;
  willCallLocationId: string | null;
  willCallLocationCode: string | null;
  willCallLocationName: string | null;
  willCallLocationBarcode: string | null;
};

async function quoteFill(
  tx: Prisma.TransactionClient,
  fillId: string,
  siteId: string,
  at: Date,
  pickupFulfillmentMode: PickupFulfillmentMode,
): Promise<CheckoutQuoteLine> {
  const fill = await tx.prescriptionFill.findFirst({
    where: {
      id: fillId,
      prescription: { siteId },
    },
    include: {
      prescription: {
        include: {
          patient: {
            include: {
              coverages: {
                include: { payer: true },
                orderBy: { position: "asc" },
              },
            },
          },
        },
      },
      productSources: {
        include: { product: true },
        orderBy: { sequence: "asc" },
      },
      prescriptionLabels: {
        where: { status: "ACTIVE" },
        select: { id: true },
        take: 1,
      },
      posSaleLine: {
        select: {
          id: true,
          transactionId: true,
        },
      },
      willCallPackage: {
        include: { location: true },
      },
    },
  });

  if (!fill) {
    throw new PosError(404, "FILL_NOT_FOUND", "Fill not found.");
  }

  if (fill.status !== "READY" || fill.prescription.status !== "READY") {
    throw new PosError(
      409,
      "FILL_NOT_READY",
      "Only a pharmacist-verified ready fill can be checked out.",
      {
        fillStatus: fill.status,
        prescriptionStatus: fill.prescription.status,
      },
    );
  }

  if (fill.posSaleLine) {
    throw new PosError(
      409,
      "FILL_ALREADY_SOLD",
      "This fill is already attached to a completed POS transaction.",
      { transactionId: fill.posSaleLine.transactionId },
    );
  }

  if (!fill.quantity || fill.quantity.lte(0)) {
    throw new PosError(
      409,
      "FILL_QUANTITY_REQUIRED",
      "A positive physical fill quantity is required before checkout.",
    );
  }

  if (fill.prescriptionLabels.length === 0) {
    throw new PosError(
      409,
      "ACTIVE_LABEL_REQUIRED",
      "The fill must have an active generated prescription label before checkout.",
    );
  }

  let packageSnapshot: Pick<
    CheckoutQuoteLine,
    | "willCallPackageId"
    | "bagBarcode"
    | "willCallLocationId"
    | "willCallLocationCode"
    | "willCallLocationName"
    | "willCallLocationBarcode"
  >;

  if (pickupFulfillmentMode === "WILL_CALL") {
    if (!fill.willCallPackage || fill.willCallPackage.status !== "STAGED") {
      throw new PosError(
        409,
        "WILL_CALL_STAGING_REQUIRED",
        "The ready fill must be staged in a Will Call location before Will Call checkout.",
      );
    }

    packageSnapshot = {
      willCallPackageId: fill.willCallPackage.id,
      bagBarcode: fill.willCallPackage.bagBarcode,
      willCallLocationId: fill.willCallPackage.locationId,
      willCallLocationCode: fill.willCallPackage.location.code,
      willCallLocationName: fill.willCallPackage.location.name,
      willCallLocationBarcode: fill.willCallPackage.location.barcode,
    };
  } else {
    if (fill.willCallPackage) {
      throw new PosError(
        409,
        "IMMEDIATE_PICKUP_REQUIRES_UNSTAGED_FILL",
        "A fill already assigned to a Will Call bag/location must use the normal Will Call pickup workflow.",
        {
          fillId: fill.id,
          willCallPackageId: fill.willCallPackage.id,
          packageStatus: fill.willCallPackage.status,
        },
      );
    }

    packageSnapshot = {
      willCallPackageId: null,
      bagBarcode: null,
      willCallLocationId: null,
      willCallLocationCode: null,
      willCallLocationName: null,
      willCallLocationBarcode: null,
    };
  }

  const activeCoverages = fill.prescription.patient.coverages.filter((coverage) =>
    activeOnDate(coverage, at),
  );

  const claimFillId =
    fill.billingRole === "COMPLETION_OF_PRIMARY" && fill.billingAnchorFillId
      ? fill.billingAnchorFillId
      : fill.id;
  const paidClaim = await activePaidClaim(tx, claimFillId);

  if (fill.billingRole === "COMPLETION_OF_PRIMARY" && paidClaim) {
    return {
      fillId: fill.id,
      prescriptionId: fill.prescriptionId,
      patientId: fill.prescription.patientId,
      rxNumber: fill.prescription.rxNumber,
      medicationName: fill.prescription.medicationName,
      fillNumber: fill.fillNumber,
      partNumber: fill.partNumber,
      quantity: new Prisma.Decimal(fill.quantity),
      priceBasis: "COMPLETION_ALREADY_BILLED",
      claimTransactionId: paidClaim.id,
      patientResponsibilitySnapshot: money(0),
      cashUnitPriceSnapshot: null,
      cashPricingSnapshot: {
        billingAnchorFillId: fill.billingAnchorFillId,
        note: "No additional patient charge: primary logical fill was already adjudicated.",
      },
      amountDue: money(0),
      pickupFulfillmentMode,
      ...packageSnapshot,
    };
  }

  if (activeCoverages.length > 0) {
    if (!paidClaim) {
      throw new PosError(
        409,
        "ACTIVE_PAID_CLAIM_REQUIRED",
        "An active paid claim is required before an insured fill can be checked out.",
      );
    }

    const responsibility = money(paidClaim.patientResponsibility ?? 0);
    if (responsibility.lt(0)) {
      throw new PosError(
        409,
        "INVALID_PATIENT_RESPONSIBILITY",
        "The active claim contains a negative patient responsibility.",
        { claimTransactionId: paidClaim.id },
      );
    }

    return {
      fillId: fill.id,
      prescriptionId: fill.prescriptionId,
      patientId: fill.prescription.patientId,
      rxNumber: fill.prescription.rxNumber,
      medicationName: fill.prescription.medicationName,
      fillNumber: fill.fillNumber,
      partNumber: fill.partNumber,
      quantity: new Prisma.Decimal(fill.quantity),
      priceBasis: "THIRD_PARTY",
      claimTransactionId: paidClaim.id,
      patientResponsibilitySnapshot: responsibility,
      cashUnitPriceSnapshot: null,
      cashPricingSnapshot: {},
      amountDue: responsibility,
      pickupFulfillmentMode,
      ...packageSnapshot,
    };
  }

  if (fill.productSources.length === 0) {
    throw new PosError(
      409,
      "CASH_PRICE_SOURCE_REQUIRED",
      "Cash pricing requires the physical NDC sources used for the fill.",
    );
  }

  let total = new Prisma.Decimal(0);
  const priceSnapshots: Array<Record<string, string>> = [];
  const uniqueUnitPrices = new Set<string>();

  for (const source of fill.productSources) {
    if (source.product.unitPrice === null) {
      throw new PosError(
        409,
        "CASH_PRICE_MISSING",
        "A current unit price is required on every physical NDC source before a cash fill can be sold.",
        {
          productId: source.productId,
          ndc: source.ndcSnapshot,
        },
      );
    }

    const unitPrice = new Prisma.Decimal(source.product.unitPrice);
    if (unitPrice.lt(0)) {
      throw new PosError(
        409,
        "INVALID_CASH_PRICE",
        "Cash unit pricing cannot be negative.",
        { productId: source.productId },
      );
    }
    const extended = new Prisma.Decimal(source.quantity).mul(unitPrice);
    total = total.plus(extended);
    uniqueUnitPrices.add(unitPrice.toString());
    priceSnapshots.push({
      productId: source.productId,
      ndc: source.ndcSnapshot,
      quantity: source.quantity.toString(),
      unitPrice: unitPrice.toString(),
      extendedAmount: extended.toDecimalPlaces(6).toString(),
    });
  }

  const amountDue = money(total);
  const singleUnitPrice =
    uniqueUnitPrices.size === 1
      ? new Prisma.Decimal([...uniqueUnitPrices][0]!)
      : null;

  return {
    fillId: fill.id,
    prescriptionId: fill.prescriptionId,
    patientId: fill.prescription.patientId,
    rxNumber: fill.prescription.rxNumber,
    medicationName: fill.prescription.medicationName,
    fillNumber: fill.fillNumber,
    partNumber: fill.partNumber,
    quantity: new Prisma.Decimal(fill.quantity),
    priceBasis: "CASH",
    claimTransactionId: null,
    patientResponsibilitySnapshot: null,
    cashUnitPriceSnapshot: singleUnitPrice,
    cashPricingSnapshot: priceSnapshots,
    amountDue,
    pickupFulfillmentMode,
    ...packageSnapshot,
  };
}

async function quoteFillsInTransaction(
  tx: Prisma.TransactionClient,
  fillIds: string[],
  siteId: string,
  fulfillmentModeInput?: PickupFulfillmentMode,
) {
  const pickupFulfillmentMode = normalizeFulfillmentMode(fulfillmentModeInput);
  if (fillIds.length < 1 || fillIds.length > MAX_CHECKOUT_FILLS) {
    throw new PosError(
      400,
      "INVALID_FILL_COUNT",
      `Checkout requires between 1 and ${MAX_CHECKOUT_FILLS} fills.`,
    );
  }

  const uniqueIds = [...new Set(fillIds)];
  if (uniqueIds.length !== fillIds.length) {
    throw new PosError(
      400,
      "DUPLICATE_FILL",
      "The same fill cannot appear more than once in a checkout.",
    );
  }

  const now = new Date();
  const lines: CheckoutQuoteLine[] = [];
  for (const fillId of fillIds) {
    lines.push(
      await quoteFill(tx, fillId, siteId, now, pickupFulfillmentMode),
    );
  }

  const patientIds = new Set(lines.map((line) => line.patientId));
  if (patientIds.size !== 1) {
    throw new PosError(
      409,
      "MULTIPLE_PATIENTS",
      "A single POS transaction can only contain fills for one patient.",
    );
  }

  const totalDue = money(
    lines.reduce(
      (sum, line) => sum.plus(line.amountDue),
      new Prisma.Decimal(0),
    ),
  );

  return {
    patientId: lines[0]!.patientId,
    pickupFulfillmentMode,
    lines,
    totalDue,
  };
}

export async function quoteFillsForCheckout(
  fillIds: string[],
  context: Pick<PosActorContext, "siteId">,
  fulfillmentMode?: PickupFulfillmentMode,
) {
  return db.$transaction((tx) =>
    quoteFillsInTransaction(tx, fillIds, context.siteId, fulfillmentMode),
  );
}

function normalizePickup(
  input: PickupVerificationInput,
  patient: { dateOfBirth: Date | null },
) {
  const recipientName = input.recipientName?.trim();
  const relationship = input.relationship?.trim() || null;
  const signatureName = input.signatureName?.trim() || null;
  const signatureReference = input.signatureReference?.trim() || null;

  if (!recipientName || recipientName.length > 120) {
    throw new PosError(
      400,
      "PICKUP_RECIPIENT_REQUIRED",
      "Pickup recipient name is required and must be 120 characters or fewer.",
    );
  }
  if (!pickupIdentityMethods.has(input.identityMethod)) {
    throw new PosError(
      400,
      "INVALID_IDENTITY_METHOD",
      "A valid pickup identity verification method is required.",
    );
  }
  if (input.identityMethod === "DATE_OF_BIRTH") {
    const entered = input.identityValue?.trim();
    if (!patient.dateOfBirth || !entered) {
      throw new PosError(
        400,
        "DOB_VERIFICATION_REQUIRED",
        "Enter the patient's date of birth to verify pickup identity.",
      );
    }
    const expected = patient.dateOfBirth.toISOString().slice(0, 10);
    if (entered !== expected) {
      throw new PosError(
        409,
        "PICKUP_IDENTITY_MISMATCH",
        "The entered date of birth does not match the patient record.",
      );
    }
  }
  if (!pickupSignatureMethods.has(input.signatureMethod)) {
    throw new PosError(
      400,
      "INVALID_SIGNATURE_METHOD",
      "A valid pickup signature method is required.",
    );
  }
  if (input.signatureMethod === "ELECTRONIC_TYPED" && !signatureName) {
    throw new PosError(
      400,
      "SIGNATURE_REQUIRED",
      "A typed signer name is required for an electronic typed signature.",
    );
  }
  if (
    input.signatureMethod !== "ELECTRONIC_TYPED" &&
    !signatureReference
  ) {
    throw new PosError(
      400,
      "SIGNATURE_REFERENCE_REQUIRED",
      "A signature reference is required for external-device or paper signatures.",
    );
  }

  return {
    recipientName,
    relationship,
    identityMethod: input.identityMethod,
    signatureMethod: input.signatureMethod,
    signatureName,
    signatureReference,
  };
}

function validatePackageScans(
  lines: CheckoutQuoteLine[],
  packageInputs: PickupPackageInput[],
  pickupFulfillmentMode: PickupFulfillmentMode,
) {
  if (pickupFulfillmentMode === "IMMEDIATE") {
    if (packageInputs.length > 0) {
      throw new PosError(
        400,
        "IMMEDIATE_PICKUP_PACKAGE_NOT_ALLOWED",
        "Immediate pickup does not use a Will Call bag scan.",
      );
    }
    return;
  }

  if (packageInputs.length !== lines.length) {
    throw new PosError(
      400,
      "PACKAGE_SCAN_REQUIRED",
      "Each fill in the checkout must have one scanned Will Call bag barcode.",
    );
  }

  const scanned = new Map(
    packageInputs.map((item) => [
      item.fillId,
      item.bagBarcode?.trim().toUpperCase(),
    ]),
  );

  for (const line of lines) {
    const barcode = scanned.get(line.fillId);
    if (!line.bagBarcode || !barcode || barcode !== line.bagBarcode.toUpperCase()) {
      throw new PosError(
        409,
        "WILL_CALL_BAG_MISMATCH",
        "The scanned Will Call bag does not match the selected fill.",
        {
          fillId: line.fillId,
          locationCode: line.willCallLocationCode,
        },
      );
    }
  }
}

function normalizeTenders(
  input: PosTenderInput[],
  totalDue: Prisma.Decimal,
) {
  const tenders = input.map((tender, index) => {
    if (!paymentMethods.has(tender.method)) {
      throw new PosError(
        400,
        "INVALID_PAYMENT_METHOD",
        `Tender ${index + 1} has an invalid payment method.`,
      );
    }
    let amount: Prisma.Decimal;
    try {
      amount = money(tender.amount);
    } catch {
      throw new PosError(
        400,
        "INVALID_TENDER_AMOUNT",
        `Tender ${index + 1} has an invalid amount.`,
      );
    }
    if (amount.lte(0)) {
      throw new PosError(
        400,
        "INVALID_TENDER_AMOUNT",
        "Tender amounts must be greater than zero.",
      );
    }
    return {
      method: tender.method,
      amount,
      reference: tender.reference?.trim() || null,
    };
  });

  if (totalDue.eq(0)) {
    if (tenders.length > 0) {
      throw new PosError(
        400,
        "ZERO_DUE_TENDER_NOT_ALLOWED",
        "Do not collect a payment tender when the patient amount due is zero.",
      );
    }
    return {
      tenders,
      totalTendered: money(0),
      changeDue: money(0),
    };
  }

  if (tenders.length === 0) {
    throw new PosError(
      400,
      "PAYMENT_REQUIRED",
      "At least one payment tender is required for a nonzero patient balance.",
    );
  }

  const totalTendered = money(
    tenders.reduce(
      (sum, tender) => sum.plus(tender.amount),
      new Prisma.Decimal(0),
    ),
  );
  const nonCashTendered = money(
    tenders
      .filter((tender) => tender.method !== "CASH")
      .reduce(
        (sum, tender) => sum.plus(tender.amount),
        new Prisma.Decimal(0),
      ),
  );

  if (nonCashTendered.gt(totalDue)) {
    throw new PosError(
      400,
      "NONCASH_OVERPAYMENT",
      "Card, check, and other non-cash tenders cannot exceed the amount due.",
    );
  }

  if (totalTendered.lt(totalDue)) {
    throw new PosError(
      400,
      "INSUFFICIENT_TENDER",
      "Tendered payment does not cover the patient amount due.",
      {
        totalDue: totalDue.toFixed(2),
        totalTendered: totalTendered.toFixed(2),
      },
    );
  }

  const changeDue = money(totalTendered.minus(totalDue));
  if (
    changeDue.gt(0) &&
    !tenders.some((tender) => tender.method === "CASH")
  ) {
    throw new PosError(
      400,
      "CHANGE_REQUIRES_CASH",
      "Overpayment is only allowed when a cash tender can receive change.",
    );
  }

  return { tenders, totalTendered, changeDue };
}

export async function checkoutFills(
  input: {
    fillIds: string[];
    tenders?: PosTenderInput[];
    pickupPackages: PickupPackageInput[];
    pickup: PickupVerificationInput;
    pickupFulfillmentMode?: PickupFulfillmentMode;
    idempotencyKey: string;
  },
  context: PosActorContext,
) {
  const key = input.idempotencyKey.trim();
  if (!key || key.length > 160) {
    throw new PosError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A checkout idempotency key of 1-160 characters is required.",
    );
  }

  const existing = await db.pointOfSaleTransaction.findUnique({
    where: { idempotencyKey: key },
    include: {
      lines: true,
      tenders: true,
      patient: true,
      createdBy: {
        select: { id: true, displayName: true, role: true },
      },
    },
  });
  if (existing) {
    if (existing.siteId !== context.siteId) {
      throw new PosError(
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "That idempotency key belongs to another pharmacy site.",
      );
    }
    return { transaction: existing, replayed: true };
  }

  try {
    const transaction = await db.$transaction(async (tx) => {
      const replay = await tx.pointOfSaleTransaction.findUnique({
        where: { idempotencyKey: key },
        include: {
          lines: true,
          tenders: true,
          patient: true,
          createdBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      });
      if (replay) return replay;

      const quote = await quoteFillsInTransaction(
        tx,
        input.fillIds,
        context.siteId,
        input.pickupFulfillmentMode,
      );
      const payment = normalizeTenders(input.tenders ?? [], quote.totalDue);
      const patient = await tx.patient.findUnique({
        where: { id: quote.patientId },
        select: { dateOfBirth: true },
      });
      if (!patient) {
        throw new PosError(404, "PATIENT_NOT_FOUND", "Patient not found.");
      }
      const pickup = normalizePickup(input.pickup, patient);
      validatePackageScans(
        quote.lines,
        input.pickupPackages,
        quote.pickupFulfillmentMode,
      );
      const pickupVerifiedAt = new Date();
      const receiptNumber =
        `POS-${randomUUID().replace(/-/g, "").slice(0, 14).toUpperCase()}`;

      const created = await tx.pointOfSaleTransaction.create({
        data: {
          siteId: context.siteId,
          patientId: quote.patientId,
          receiptNumber,
          totalDue: quote.totalDue,
          totalTendered: payment.totalTendered,
          changeDue: payment.changeDue,
          idempotencyKey: key,
          pickupFulfillmentMode: quote.pickupFulfillmentMode,
          pickupRecipientName: pickup.recipientName,
          pickupRelationship: pickup.relationship,
          pickupIdentityMethod: pickup.identityMethod,
          pickupVerifiedAt,
          pickupSignatureMethod: pickup.signatureMethod,
          pickupSignatureName: pickup.signatureName,
          pickupSignatureReference: pickup.signatureReference,
          createdById: context.actorId,
          lines: {
            create: quote.lines.map((line) => ({
              fillId: line.fillId,
              claimTransactionId: line.claimTransactionId,
              quantity: line.quantity,
              priceBasis: line.priceBasis,
              cashUnitPriceSnapshot: line.cashUnitPriceSnapshot,
              cashPricingSnapshot: line.cashPricingSnapshot,
              patientResponsibilitySnapshot:
                line.patientResponsibilitySnapshot,
              amountDue: line.amountDue,
            })),
          },
          tenders: {
            create: payment.tenders.map((tender) => ({
              method: tender.method,
              amount: tender.amount,
              reference: tender.reference,
              actorId: context.actorId,
            })),
          },
        },
        include: {
          lines: true,
          tenders: true,
          patient: true,
          createdBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      });

      const soldAt = new Date();
      for (const line of quote.lines) {
        const current = await tx.prescriptionFill.findUnique({
          where: { id: line.fillId },
          include: {
            prescription: true,
            willCallPackage: true,
          },
        });
        if (
          !current ||
          current.status !== "READY" ||
          current.prescription.status !== "READY"
        ) {
          throw new PosError(
            409,
            "FILL_STATE_CHANGED",
            "A fill changed state while checkout was being completed.",
            { fillId: line.fillId },
          );
        }

        if (quote.pickupFulfillmentMode === "WILL_CALL") {
          if (
            !current.willCallPackage ||
            current.willCallPackage.status !== "STAGED" ||
            current.willCallPackage.id !== line.willCallPackageId
          ) {
            throw new PosError(
              409,
              "WILL_CALL_PACKAGE_STATE_CHANGED",
              "The staged Will Call package changed while checkout was being completed.",
              { fillId: line.fillId },
            );
          }
        } else if (current.willCallPackage) {
          throw new PosError(
            409,
            "IMMEDIATE_PICKUP_STATE_CHANGED",
            "The fill was staged into Will Call while immediate pickup was being completed.",
            {
              fillId: line.fillId,
              willCallPackageId: current.willCallPackage.id,
            },
          );
        }

        await tx.prescriptionFill.update({
          where: { id: current.id },
          data: {
            status: "SOLD",
            soldAt,
            physicalDispensedQuantity:
              current.quantity ?? new Prisma.Decimal(0),
          },
        });

        if (quote.pickupFulfillmentMode === "WILL_CALL" && current.willCallPackage) {
          await tx.willCallPackage.update({
            where: { id: current.willCallPackage.id },
            data: {
              status: "PICKED_UP",
              pickedUpAt: soldAt,
            },
          });
        }

        if (current.billingAnchorFillId && current.quantity) {
          const anchor = await tx.prescriptionFill.findUnique({
            where: { id: current.billingAnchorFillId },
            select: {
              id: true,
              remainingOwedQuantity: true,
            },
          });
          if (anchor) {
            await tx.prescriptionFill.update({
              where: { id: anchor.id },
              data: {
                remainingOwedQuantity: Prisma.Decimal.max(
                  anchor.remainingOwedQuantity.minus(current.quantity),
                  new Prisma.Decimal(0),
                ),
              },
            });
          }
        }

        await tx.prescription.update({
          where: { id: current.prescriptionId },
          data: {
            status: "SOLD",
            ...(current.consumesRefill
              ? {
                  refillsUsed: Math.max(
                    current.prescription.refillsUsed,
                    current.fillNumber,
                  ),
                }
              : {}),
          },
        });

        await writeAuditEvent(tx, {
          siteId: context.siteId,
          actorId: context.actorId,
          action: "POS_FILL_SOLD",
          entityType: "PrescriptionFill",
          entityId: current.id,
          requestId: context.requestId,
          metadata: {
            transactionId: created.id,
            receiptNumber: created.receiptNumber,
            priceBasis: line.priceBasis,
            amountDue: line.amountDue.toFixed(2),
            claimTransactionId: line.claimTransactionId,
            pickupFulfillmentMode: quote.pickupFulfillmentMode,
            willCallPackageId: line.willCallPackageId,
            bagBarcode: line.bagBarcode,
            willCallLocationCode: line.willCallLocationCode,
          },
        });
      }

      await writeAuditEvent(tx, {
        siteId: context.siteId,
        actorId: context.actorId,
        action: "POS_TRANSACTION_COMPLETED",
        entityType: "PointOfSaleTransaction",
        entityId: created.id,
        requestId: context.requestId,
        metadata: {
          receiptNumber: created.receiptNumber,
          pickupFulfillmentMode: quote.pickupFulfillmentMode,
          fillIds: quote.lines.map((line) => line.fillId),
          totalDue: quote.totalDue.toFixed(2),
          totalTendered: payment.totalTendered.toFixed(2),
          changeDue: payment.changeDue.toFixed(2),
          tenderMethods: payment.tenders.map((tender) => tender.method),
          pickupRecipientName: pickup.recipientName,
          pickupRelationship: pickup.relationship,
          pickupIdentityMethod: pickup.identityMethod,
          pickupSignatureMethod: pickup.signatureMethod,
          pickupPackageIds: quote.lines.map((line) => line.willCallPackageId),
        },
      });

      return created;
    });

    return { transaction, replayed: false };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const replay = await db.pointOfSaleTransaction.findUnique({
        where: { idempotencyKey: key },
        include: {
          lines: true,
          tenders: true,
          patient: true,
          createdBy: {
            select: { id: true, displayName: true, role: true },
          },
        },
      });
      if (replay && replay.siteId === context.siteId) {
        return { transaction: replay, replayed: true };
      }
      throw new PosError(
        409,
        "CHECKOUT_CONFLICT",
        "A fill was sold by another checkout before this transaction completed.",
      );
    }
    throw error;
  }
}
