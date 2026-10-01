import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PaymentMethod,
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

const paymentMethods = new Set<PaymentMethod>([
  "CASH",
  "CARD",
  "CHECK",
  "OTHER",
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
};

async function quoteFill(
  tx: Prisma.TransactionClient,
  fillId: string,
  siteId: string,
  at: Date,
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
  };
}

async function quoteFillsInTransaction(
  tx: Prisma.TransactionClient,
  fillIds: string[],
  siteId: string,
) {
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
    lines.push(await quoteFill(tx, fillId, siteId, now));
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
    lines,
    totalDue,
  };
}

export async function quoteFillsForCheckout(
  fillIds: string[],
  context: Pick<PosActorContext, "siteId">,
) {
  return db.$transaction((tx) =>
    quoteFillsInTransaction(tx, fillIds, context.siteId),
  );
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
      );
      const payment = normalizeTenders(input.tenders ?? [], quote.totalDue);
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

        await tx.prescriptionFill.update({
          where: { id: current.id },
          data: {
            status: "SOLD",
            soldAt,
            physicalDispensedQuantity:
              current.quantity ?? new Prisma.Decimal(0),
          },
        });

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
          fillIds: quote.lines.map((line) => line.fillId),
          totalDue: quote.totalDue.toFixed(2),
          totalTendered: payment.totalTendered.toFixed(2),
          changeDue: payment.changeDue.toFixed(2),
          tenderMethods: payment.tenders.map((tender) => tender.method),
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
