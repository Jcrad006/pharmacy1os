import { randomUUID } from "node:crypto";
import {
  Prisma,
  type BillingNdcStrategy,
  type ClaimOutcome,
  type ClaimStandard,
} from "@prisma/client";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import {
  type CanonicalClaimRequest,
  type CanonicalCobPriorPayer,
  requireBillingNdcSelection,
} from "./adapter.js";
import { getClaimAdapter } from "./sandboxAdapter.js";

export class ClaimError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type ClaimActorContext = {
  siteId: string;
  actorId: string;
  requestId?: string;
};

type PersistableResponse = {
  status: ClaimOutcome;
  transactionReference?: string | null;
  authorizationNumber?: string | null;
  amountPaid?: string | null;
  patientResponsibility?: string | null;
  rejectCodes: string[];
  messages: string[];
  rawStandard: ClaimStandard;
};

function decimal(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

function jsonSnapshot(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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

function priorFromTransaction(transaction: {
  coveragePosition: number;
  payerId: string;
  outcome: ClaimOutcome;
  amountPaid: Prisma.Decimal | null;
  patientResponsibility: Prisma.Decimal | null;
  rejectCodes: Prisma.JsonValue;
  transactionReference: string | null;
  adjudicatedAt: Date;
}): CanonicalCobPriorPayer {
  if (
    transaction.outcome !== "PAID" &&
    transaction.outcome !== "REJECTED" &&
    transaction.outcome !== "ERROR"
  ) {
    throw new ClaimError(
      409,
      "INVALID_PRIOR_PAYER_OUTCOME",
      "A reversed claim cannot be forwarded as an active prior-payer COB response.",
    );
  }

  return {
    position: transaction.coveragePosition,
    payerId: transaction.payerId,
    responseStatus: transaction.outcome,
    amountPaid: transaction.amountPaid?.toString() ?? null,
    patientResponsibility:
      transaction.patientResponsibility?.toString() ?? null,
    rejectCodes: Array.isArray(transaction.rejectCodes)
      ? transaction.rejectCodes.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    transactionReference: transaction.transactionReference,
    adjudicatedAt: transaction.adjudicatedAt,
  };
}

const fillForClaimsInclude = {
  billingProduct: true,
  productSources: {
    include: {
      product: true,
      manufacturer: true,
      productLot: true,
      productExpiration: true,
    },
    orderBy: { sequence: "asc" as const },
  },
  prescription: {
    include: {
      patient: {
        include: {
          coverages: {
            include: { payer: true },
            orderBy: { position: "asc" as const },
          },
        },
      },
      prescriber: true,
    },
  },
} satisfies Prisma.PrescriptionFillInclude;

type FillForClaims = Prisma.PrescriptionFillGetPayload<{
  include: typeof fillForClaimsInclude;
}>;

async function loadFillForClaims(fillId: string, siteId: string) {
  const fill = await db.prescriptionFill.findFirst({
    where: { id: fillId, prescription: { siteId } },
    include: fillForClaimsInclude,
  });
  if (!fill) {
    throw new ClaimError(404, "FILL_NOT_FOUND", "Fill not found.");
  }
  return fill;
}

function validatePhysicalFillReady(fill: FillForClaims) {
  if (!fill.quantity || fill.quantity.lte(0)) {
    throw new ClaimError(
      409,
      "FILL_QUANTITY_REQUIRED",
      "A positive physical dispense quantity is required before adjudication.",
    );
  }

  const sourced = fill.productSources.reduce(
    (sum, source) => sum.plus(source.quantity),
    new Prisma.Decimal(0),
  );

  if (!fill.productVerifiedAt || !sourced.eq(fill.quantity)) {
    throw new ClaimError(
      409,
      "PRODUCT_SOURCES_INCOMPLETE",
      "Complete barcode/product sourcing before adjudication.",
      {
        physicalQuantity: fill.quantity.toString(),
        sourcedQuantity: sourced.toString(),
      },
    );
  }

}

async function createOrReuseLabel(
  fill: FillForClaims,
  context: ClaimActorContext,
  claimTransactionId: string | null,
) {
  const physicalQuantity = fill.quantity;
  if (!physicalQuantity || physicalQuantity.lte(0)) {
    throw new ClaimError(
      409,
      "FILL_QUANTITY_REQUIRED",
      "A positive physical dispense quantity is required before label generation.",
    );
  }

  const payerIntendedQuantity =
    fill.payerIntendedQuantity ?? fill.intendedQuantity ?? fill.quantity;
  const claimTransaction = claimTransactionId
    ? await db.claimTransaction.findFirst({
        where: { id: claimTransactionId, siteId: context.siteId },
        select: { billedNdc: true },
      })
    : null;
  const billedNdc =
    claimTransaction?.billedNdc ??
    fill.billingProduct?.ndc ??
    (fill.productSources.length === 1
      ? fill.productSources[0]!.ndcSnapshot
      : null);

  type BottleSourceSnapshot = {
    sequence: number;
    productId: string;
    ndc: string;
    manufacturer: string;
    lotNumber: string;
    expiration: string;
    quantity: string;
  };

  type BottlePlan = {
    productId: string;
    ndc: string;
    manufacturer: string;
    productDescription: string;
    quantity: Prisma.Decimal;
    firstSequence: number;
    sources: BottleSourceSnapshot[];
  };

  const grouped = new Map<string, BottlePlan>();
  for (const source of fill.productSources) {
    const snapshot: BottleSourceSnapshot = {
      sequence: source.sequence,
      productId: source.productId,
      ndc: source.ndcSnapshot,
      manufacturer: source.manufacturerSnapshot,
      lotNumber: source.lotNumberSnapshot,
      expiration: source.expirationSnapshot.toISOString(),
      quantity: source.quantity.toString(),
    };
    const current = grouped.get(source.productId);
    if (current) {
      current.quantity = current.quantity.plus(source.quantity);
      current.sources.push(snapshot);
      current.firstSequence = Math.min(current.firstSequence, source.sequence);
      continue;
    }
    grouped.set(source.productId, {
      productId: source.productId,
      ndc: source.ndcSnapshot,
      manufacturer: source.manufacturerSnapshot,
      productDescription:
        source.product.descriptor ||
        [
          fill.prescription.medicationName,
          fill.prescription.strength,
          fill.prescription.dosageForm,
        ]
          .filter(Boolean)
          .join(" "),
      quantity: new Prisma.Decimal(source.quantity),
      firstSequence: source.sequence,
      sources: [snapshot],
    });
  }

  const bottles = [...grouped.values()].sort((a, b) => {
    const quantityOrder = b.quantity.comparedTo(a.quantity);
    if (quantityOrder !== 0) return quantityOrder;
    if (billedNdc) {
      if (a.ndc === billedNdc && b.ndc !== billedNdc) return -1;
      if (b.ndc === billedNdc && a.ndc !== billedNdc) return 1;
    }
    return a.firstSequence - b.firstSequence;
  });

  if (bottles.length === 0) {
    throw new ClaimError(
      409,
      "PRODUCT_SOURCES_INCOMPLETE",
      "At least one physical NDC source is required before label generation.",
    );
  }

  const activeLabels = await db.prescriptionLabel.findMany({
    where: { fillId: fill.id, status: "ACTIVE" },
    include: {
      printJobs: { orderBy: { queuedAt: "desc" }, take: 1 },
    },
    orderBy: [{ version: "desc" }, { bottleNumber: "asc" }],
  });

  const bottleCount = bottles.length;
  const reusable =
    activeLabels.length === bottleCount &&
    activeLabels.every((label, index) => {
      const bottle = bottles[index]!;
      const sourceSummarySnapshot = jsonSnapshot(
        bottle.sources.sort((a, b) => a.sequence - b.sequence),
      );
      return (
        label.bottleNumber === index + 1 &&
        label.bottleCount === bottleCount &&
        label.physicalQuantity.eq(physicalQuantity) &&
        label.containerQuantity.eq(bottle.quantity) &&
        label.physicalProductIdSnapshot === bottle.productId &&
        label.physicalNdcSnapshot === bottle.ndc &&
        label.manufacturerSnapshot === bottle.manufacturer &&
        label.productDescriptionSnapshot === bottle.productDescription &&
        (label.payerIntendedQuantity?.eq(payerIntendedQuantity ?? 0) ??
          payerIntendedQuantity === null) &&
        label.daysSupply === fill.daysSupply &&
        label.billedNdcSnapshot === billedNdc &&
        JSON.stringify(label.sourceSummarySnapshot) ===
          JSON.stringify(sourceSummarySnapshot)
      );
    });

  if (reusable) {
    const printJobs = activeLabels
      .map((label) => label.printJobs[0] ?? null)
      .filter((job): job is NonNullable<typeof job> => Boolean(job));
    return {
      label: activeLabels[0] ?? null,
      printJob: printJobs[0] ?? null,
      labels: activeLabels,
      printJobs,
    };
  }

  const last = await db.prescriptionLabel.findFirst({
    where: { fillId: fill.id },
    select: { version: true },
    orderBy: { version: "desc" },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  if (activeLabels.length > 0) {
    await db.$transaction(async (tx) => {
      const activeIds = activeLabels.map((label) => label.id);
      await tx.prescriptionLabel.updateMany({
        where: { id: { in: activeIds } },
        data: {
          status: "VOID",
          voidedAt: new Date(),
          voidReason:
            "Dispensing bottle/NDC details changed after label generation; replacement label set required.",
        },
      });
      await tx.labelPrintJob.updateMany({
        where: { labelId: { in: activeIds }, status: "QUEUED" },
        data: { status: "CANCELLED" },
      });
      await writeAuditEvent(tx, {
        siteId: context.siteId,
        actorId: context.actorId,
        action: "PRESCRIPTION_LABEL_SET_VOIDED_FOR_REPLACEMENT",
        entityType: "PrescriptionFill",
        entityId: fill.id,
        requestId: context.requestId,
        metadata: {
          fillId: fill.id,
          priorLabelIds: activeIds,
          priorVersion: activeLabels[0]?.version ?? null,
          nextVersion,
          nextBottleCount: bottleCount,
          nextPhysicalQuantity: physicalQuantity.toString(),
        },
      });
    });
  }

  return db.$transaction(async (tx) => {
    const labels = [];
    const printJobs = [];

    for (const [index, bottle] of bottles.entries()) {
      const bottleNumber = index + 1;
      const sourceSummarySnapshot = jsonSnapshot(
        bottle.sources.sort((a, b) => a.sequence - b.sequence),
      );
      const label = await tx.prescriptionLabel.create({
        data: {
          siteId: context.siteId,
          fillId: fill.id,
          version: nextVersion,
          bottleNumber,
          bottleCount,
          claimTransactionId,
          rxNumberSnapshot: fill.prescription.rxNumber,
          patientNameSnapshot:
            `${fill.prescription.patient.lastName}, ${fill.prescription.patient.firstName}`,
          prescriberNameSnapshot:
            `${fill.prescription.prescriber.lastName}, ${fill.prescription.prescriber.firstName}`,
          medicationSnapshot: [
            fill.prescription.medicationName,
            fill.prescription.strength,
            fill.prescription.dosageForm,
          ]
            .filter(Boolean)
            .join(" "),
          sigSnapshot: fill.prescription.sig,
          physicalQuantity,
          containerQuantity: bottle.quantity,
          physicalProductIdSnapshot: bottle.productId,
          physicalNdcSnapshot: bottle.ndc,
          manufacturerSnapshot: bottle.manufacturer,
          productDescriptionSnapshot: bottle.productDescription,
          payerIntendedQuantity,
          daysSupply: fill.daysSupply,
          billedNdcSnapshot: billedNdc,
          sourceSummarySnapshot,
        },
      });

      const printJob = await tx.labelPrintJob.create({
        data: {
          siteId: context.siteId,
          labelId: label.id,
          actorId: context.actorId,
          status: "QUEUED",
          copies: 1,
        },
      });

      await writeAuditEvent(tx, {
        siteId: context.siteId,
        actorId: context.actorId,
        action: "PRESCRIPTION_BOTTLE_LABEL_GENERATED",
        entityType: "PrescriptionLabel",
        entityId: label.id,
        requestId: context.requestId,
        metadata: {
          fillId: fill.id,
          version: label.version,
          claimTransactionId,
          bottleNumber,
          bottleCount,
          physicalProductId: bottle.productId,
          physicalNdc: bottle.ndc,
          manufacturer: bottle.manufacturer,
          productDescription: bottle.productDescription,
          containerQuantity: bottle.quantity.toString(),
          totalPhysicalQuantity: physicalQuantity.toString(),
          payerIntendedQuantity: payerIntendedQuantity?.toString() ?? null,
          billedNdc,
          sourceCount: bottle.sources.length,
        },
      });

      await writeAuditEvent(tx, {
        siteId: context.siteId,
        actorId: context.actorId,
        action: "LABEL_PRINT_JOB_QUEUED",
        entityType: "LabelPrintJob",
        entityId: printJob.id,
        requestId: context.requestId,
        metadata: {
          fillId: fill.id,
          labelId: label.id,
          bottleNumber,
          bottleCount,
          copies: 1,
        },
      });

      labels.push({ ...label, printJobs: [printJob] });
      printJobs.push(printJob);
    }

    return {
      label: labels[0] ?? null,
      printJob: printJobs[0] ?? null,
      labels,
      printJobs,
    };
  });
}

async function persistClaimTransaction(input: {
  fill: FillForClaims;
  coverage: FillForClaims["prescription"]["patient"]["coverages"][number];
  context: ClaimActorContext;
  operation: "SUBMIT" | "REVERSAL";
  originalTransactionId?: string | null;
  request: CanonicalClaimRequest;
  response: PersistableResponse;
  adapterName: string;
  adapterVersion: string;
}) {
  const adjudicatedAt = new Date();
  return db.$transaction(async (tx) => {
    const transaction = await tx.claimTransaction.create({
      data: {
        siteId: input.context.siteId,
        fillId: input.fill.id,
        payerId: input.coverage.payerId,
        coverageIdSnapshot: input.coverage.id,
        coveragePosition: input.coverage.position,
        operation: input.operation,
        outcome: input.response.status,
        idempotencyKey: input.request.claimIdempotencyKey,
        originalTransactionId: input.originalTransactionId ?? null,
        claimStandard: input.coverage.payer.claimStandard,
        adapterName: input.adapterName,
        adapterVersion: input.adapterVersion,
        billedProductId: input.request.billedProductId,
        billedNdc: input.request.billedNdc,
        memberIdSnapshot: input.coverage.memberId,
        personCodeSnapshot: input.coverage.personCode,
        groupIdSnapshot: input.coverage.groupId,
        payerIntendedQuantity: new Prisma.Decimal(
          input.request.payerIntendedQuantity,
        ),
        physicalPartQuantity: new Prisma.Decimal(
          input.request.physicalPartQuantity,
        ),
        daysSupply: input.request.daysSupply,
        requestSnapshot: jsonSnapshot(input.request),
        responseSnapshot: jsonSnapshot(input.response),
        transactionReference: input.response.transactionReference ?? null,
        authorizationNumber: input.response.authorizationNumber ?? null,
        amountPaid: decimal(input.response.amountPaid),
        patientResponsibility: decimal(input.response.patientResponsibility),
        rejectCodes: jsonSnapshot(input.response.rejectCodes),
        messages: jsonSnapshot(input.response.messages),
        createdById: input.context.actorId,
        adjudicatedAt,
      },
    });

    await writeAuditEvent(tx, {
      siteId: input.context.siteId,
      actorId: input.context.actorId,
      action:
        input.operation === "SUBMIT"
          ? "THIRD_PARTY_CLAIM_ADJUDICATED"
          : "THIRD_PARTY_CLAIM_REVERSED",
      entityType: "ClaimTransaction",
      entityId: transaction.id,
      requestId: input.context.requestId,
      metadata: {
        fillId: input.fill.id,
        payerId: input.coverage.payerId,
        coveragePosition: input.coverage.position,
        operation: input.operation,
        outcome: input.response.status,
        transactionReference: input.response.transactionReference ?? null,
        rejectCodes: input.response.rejectCodes,
        payerIntendedQuantity: input.request.payerIntendedQuantity,
        physicalPartQuantity: input.request.physicalPartQuantity,
      },
    });

    return transaction;
  });
}

export async function adjudicateFillClaims(
  fillId: string,
  context: ClaimActorContext & { retryRejected?: boolean },
) {
  const fill = await loadFillForClaims(fillId, context.siteId);
  validatePhysicalFillReady(fill);

  if (fill.billingRole === "COMPLETION_OF_PRIMARY") {
    if (!fill.billingAnchorFillId) {
      throw new ClaimError(
        409,
        "BILLING_ANCHOR_REQUIRED",
        "Completion fills must retain the primary claim billing anchor.",
      );
    }

    const paid = await db.claimTransaction.findFirst({
      where: {
        fillId: fill.billingAnchorFillId,
        operation: "SUBMIT",
        outcome: "PAID",
        NOT: {
          id: {
            in: (
              await db.claimTransaction.findMany({
                where: {
                  fillId: fill.billingAnchorFillId,
                  operation: "REVERSAL",
                  outcome: "REVERSED",
                  originalTransactionId: { not: null },
                },
                select: { originalTransactionId: true },
              })
            )
              .map((item) => item.originalTransactionId)
              .filter((id): id is string => Boolean(id)),
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!paid) {
      throw new ClaimError(
        409,
        "PRIMARY_CLAIM_NOT_PAID",
        "The primary fill has no active paid claim to anchor this completion.",
      );
    }

    const generated = await createOrReuseLabel(
      fill,
      context,
      paid.id,
    );
    return {
      state: "COMPLETION_LABEL_READY" as const,
      transactions: [],
      ...generated,
    };
  }

  const now = new Date();
  const coverages = fill.prescription.patient.coverages.filter((coverage) =>
    activeOnDate(coverage, now),
  );

  if (coverages.length === 0) {
    const generated = await createOrReuseLabel(fill, context, null);
    return {
      state: "CASH_LABEL_READY" as const,
      transactions: [],
      ...generated,
    };
  }

  if (!fill.daysSupply || fill.daysSupply <= 0) {
    throw new ClaimError(
      409,
      "DAYS_SUPPLY_REQUIRED",
      "Days supply must be entered before a third-party claim can be submitted.",
    );
  }

  const existing = await db.claimTransaction.findMany({
    where: { fillId: fill.id },
    orderBy: [{ coveragePosition: "asc" }, { createdAt: "asc" }],
  });
  const reversedIds = new Set(
    existing
      .filter(
        (item) =>
          item.operation === "REVERSAL" &&
          item.outcome === "REVERSED" &&
          item.originalTransactionId,
      )
      .map((item) => item.originalTransactionId as string),
  );

  const physicalSources = fill.productSources.map((source) => ({
    productId: source.productId,
    quantity: source.quantity.toNumber(),
  }));
  const productById = new Map(
    fill.productSources.map((source) => [source.productId, source.product]),
  );
  if (fill.billingProduct) {
    productById.set(fill.billingProduct.id, fill.billingProduct);
  }

  const payerIntendedQuantity =
    fill.payerIntendedQuantity ?? fill.intendedQuantity ?? fill.quantity;
  if (!payerIntendedQuantity || payerIntendedQuantity.lte(0)) {
    throw new ClaimError(
      409,
      "PAYER_INTENDED_QUANTITY_REQUIRED",
      "The payer-intended quantity is missing from this fill.",
    );
  }

  const chain: typeof existing = [];
  let upstreamChanged = false;

  for (const coverage of coverages) {
    const submissions = existing
      .filter(
        (item) =>
          item.coveragePosition === coverage.position &&
          item.operation === "SUBMIT" &&
          !reversedIds.has(item.id),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const current = submissions[0];

    if (
      current?.outcome === "PAID" &&
      !upstreamChanged
    ) {
      chain.push(current);
      continue;
    }

    if (
      current &&
      (current.outcome === "REJECTED" || current.outcome === "ERROR") &&
      !context.retryRejected
    ) {
      chain.push(current);
      if (current.outcome === "ERROR") break;
      continue;
    }

    if (current?.outcome === "PAID" && upstreamChanged) {
      throw new ClaimError(
        409,
        "DOWNSTREAM_REVERSAL_REQUIRED",
        "A downstream paid COB claim must be reversed before an upstream payer can be re-adjudicated.",
        {
          coveragePosition: coverage.position,
          claimTransactionId: current.id,
        },
      );
    }

    let billedProductId: string;
    try {
      billedProductId = requireBillingNdcSelection({
        physicalSources,
        billingProductId: fill.billingProductId,
        billingNdcStrategy:
          coverage.payer.billingNdcStrategy as BillingNdcStrategy,
      });
    } catch (error) {
      throw new ClaimError(
        409,
        "BILLING_NDC_SELECTION_REQUIRED",
        error instanceof Error
          ? error.message
          : "A billing NDC must be selected before adjudication.",
        { coveragePosition: coverage.position, payerId: coverage.payerId },
      );
    }

    const billedProduct = productById.get(billedProductId);
    if (!billedProduct) {
      throw new ClaimError(
        409,
        "BILLING_PRODUCT_NOT_FOUND",
        "The selected billing product is not available in the physical fill sources.",
      );
    }

    const priorPayers = chain
      .filter(
        (item) =>
          item.operation === "SUBMIT" &&
          (item.outcome === "PAID" ||
            item.outcome === "REJECTED" ||
            item.outcome === "ERROR"),
      )
      .map(priorFromTransaction);

    const claimIdempotencyKey = `claim-${fill.id}-p${coverage.position}-${randomUUID()}`;
    const claimRequest: CanonicalClaimRequest = {
      claimIdempotencyKey,
      siteId: context.siteId,
      prescriptionId: fill.prescriptionId,
      fillId: fill.id,
      coveragePosition: coverage.position,
      payerId: coverage.payerId,
      memberId: coverage.memberId,
      personCode: coverage.personCode,
      groupId: coverage.groupId ?? coverage.payer.defaultGroupId,
      billedProductId,
      billedNdc: billedProduct.ndc,
      payerIntendedQuantity: payerIntendedQuantity.toString(),
      physicalPartQuantity: fill.quantity!.toString(),
      daysSupply: fill.daysSupply!,
      priorPayers,
    };

    let adapter;
    try {
      adapter = getClaimAdapter(coverage.payer.claimStandard);
    } catch (error) {
      throw new ClaimError(
        503,
        "CLAIM_ADAPTER_NOT_CONFIGURED",
        error instanceof Error
          ? error.message
          : "No claim adapter is configured for this payer.",
      );
    }

    const response = await adapter.submit(claimRequest, {
      standard: coverage.payer.claimStandard,
      billingNdcStrategy: coverage.payer.billingNdcStrategy,
    });

    const transaction = await persistClaimTransaction({
      fill,
      coverage,
      context,
      operation: "SUBMIT",
      request: claimRequest,
      response,
      adapterName: adapter.name,
      adapterVersion: adapter.version,
    });
    chain.push(transaction);
    upstreamChanged = true;

    if (response.status === "ERROR") break;
  }

  const hasPaid = chain.some((transaction) => transaction.outcome === "PAID");
  const hasError = chain.some((transaction) => transaction.outcome === "ERROR");

  if (hasError) {
    return {
      state: "ERROR" as const,
      transactions: chain,
      label: null,
      printJob: null,
    };
  }

  if (!hasPaid) {
    return {
      state: "REJECTED" as const,
      transactions: chain,
      label: null,
      printJob: null,
    };
  }

  const paidTransaction = [...chain]
    .reverse()
    .find((transaction) => transaction.outcome === "PAID")!;
  const generated = await createOrReuseLabel(
    fill,
    context,
    paidTransaction.id,
  );

  return {
    state: "PAID_LABEL_READY" as const,
    transactions: chain,
    ...generated,
  };
}

function claimRequestFromSnapshot(
  snapshot: Prisma.JsonValue,
  nextIdempotencyKey: string,
): CanonicalClaimRequest {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new ClaimError(
      409,
      "CLAIM_SNAPSHOT_INVALID",
      "The stored claim request snapshot is invalid.",
    );
  }
  const raw = snapshot as Record<string, unknown>;
  const prior = Array.isArray(raw.priorPayers) ? raw.priorPayers : [];
  return {
    claimIdempotencyKey: nextIdempotencyKey,
    siteId: String(raw.siteId),
    prescriptionId: String(raw.prescriptionId),
    fillId: String(raw.fillId),
    coveragePosition: Number(raw.coveragePosition),
    payerId: String(raw.payerId),
    memberId: String(raw.memberId),
    personCode:
      raw.personCode === null || raw.personCode === undefined
        ? null
        : String(raw.personCode),
    groupId:
      raw.groupId === null || raw.groupId === undefined
        ? null
        : String(raw.groupId),
    billedProductId: String(raw.billedProductId),
    billedNdc: String(raw.billedNdc),
    payerIntendedQuantity: String(raw.payerIntendedQuantity),
    physicalPartQuantity: String(raw.physicalPartQuantity),
    daysSupply: Number(raw.daysSupply),
    priorPayers: prior.map((item) => {
      const value = item as Record<string, unknown>;
      return {
        position: Number(value.position),
        payerId: String(value.payerId),
        responseStatus: value.responseStatus as "PAID" | "REJECTED" | "ERROR",
        amountPaid:
          value.amountPaid === null || value.amountPaid === undefined
            ? null
            : String(value.amountPaid),
        patientResponsibility:
          value.patientResponsibility === null ||
          value.patientResponsibility === undefined
            ? null
            : String(value.patientResponsibility),
        rejectCodes: Array.isArray(value.rejectCodes)
          ? value.rejectCodes.filter(
              (code): code is string => typeof code === "string",
            )
          : [],
        transactionReference:
          value.transactionReference === null ||
          value.transactionReference === undefined
            ? null
            : String(value.transactionReference),
        adjudicatedAt: new Date(String(value.adjudicatedAt)),
      };
    }),
  };
}

export async function reverseClaimTransaction(
  claimTransactionId: string,
  context: ClaimActorContext,
) {
  const original = await db.claimTransaction.findFirst({
    where: {
      id: claimTransactionId,
      siteId: context.siteId,
      operation: "SUBMIT",
    },
  });
  if (!original) {
    throw new ClaimError(404, "CLAIM_NOT_FOUND", "Claim transaction not found.");
  }
  if (original.outcome !== "PAID" || !original.transactionReference) {
    throw new ClaimError(
      409,
      "CLAIM_NOT_REVERSIBLE",
      "Only a paid claim with a transaction reference can be reversed.",
    );
  }

  const priorReversal = await db.claimTransaction.findFirst({
    where: {
      originalTransactionId: original.id,
      operation: "REVERSAL",
      outcome: "REVERSED",
    },
    orderBy: { createdAt: "desc" },
  });
  if (priorReversal) {
    return { transaction: priorReversal, replayed: true };
  }

  const fill = await loadFillForClaims(original.fillId, context.siteId);
  const coverage = fill.prescription.patient.coverages.find(
    (item) => item.id === original.coverageIdSnapshot,
  );
  if (!coverage) {
    throw new ClaimError(
      409,
      "COVERAGE_SNAPSHOT_UNAVAILABLE",
      "The original coverage is no longer available for reversal.",
    );
  }

  const adapter = getClaimAdapter(original.claimStandard);
  const nextIdempotencyKey = `reverse-${original.id}-${randomUUID()}`;
  const request = claimRequestFromSnapshot(
    original.requestSnapshot,
    nextIdempotencyKey,
  );
  const response = await adapter.reverse(
    {
      ...request,
      originalTransactionReference: original.transactionReference,
    },
    {
      standard: original.claimStandard,
      billingNdcStrategy: coverage.payer.billingNdcStrategy,
    },
  );

  const transaction = await persistClaimTransaction({
    fill,
    coverage,
    context,
    operation: "REVERSAL",
    originalTransactionId: original.id,
    request,
    response,
    adapterName: adapter.name,
    adapterVersion: adapter.version,
  });

  if (response.status === "REVERSED") {
    await db.$transaction(async (tx) => {
      const labels = await tx.prescriptionLabel.findMany({
        where: { fillId: original.fillId, status: "ACTIVE" },
        select: { id: true },
      });
      const labelIds = labels.map((label) => label.id);
      if (labelIds.length > 0) {
        await tx.prescriptionLabel.updateMany({
          where: { id: { in: labelIds } },
          data: {
            status: "VOID",
            voidedAt: new Date(),
            voidReason: `Claim ${original.id} reversed.`,
          },
        });
        await tx.labelPrintJob.updateMany({
          where: { labelId: { in: labelIds }, status: "QUEUED" },
          data: { status: "CANCELLED" },
        });
      }
      await writeAuditEvent(tx, {
        siteId: context.siteId,
        actorId: context.actorId,
        action: "CLAIM_REVERSAL_VOIDED_LABELS",
        entityType: "ClaimTransaction",
        entityId: transaction.id,
        requestId: context.requestId,
        metadata: {
          originalTransactionId: original.id,
          fillId: original.fillId,
          labelIds,
        },
      });
    });
  }

  return { transaction, replayed: false };
}

export async function reverseActivePaidClaimsForFill(
  fillId: string,
  context: ClaimActorContext,
  options?: { requireMajoritySource?: boolean },
) {
  const paidClaims = await db.claimTransaction.findMany({
    where: {
      fillId,
      siteId: context.siteId,
      operation: "SUBMIT",
      outcome: "PAID",
    },
    select: {
      id: true,
      coveragePosition: true,
      createdAt: true,
      payer: { select: { billingNdcStrategy: true } },
    },
  });
  if (paidClaims.length === 0) return [];

  const paidIds = paidClaims.map((claim) => claim.id);
  const reversals = await db.claimTransaction.findMany({
    where: {
      siteId: context.siteId,
      operation: "REVERSAL",
      outcome: "REVERSED",
      originalTransactionId: { in: paidIds },
    },
    select: { originalTransactionId: true },
  });
  const reversedIds = new Set(
    reversals
      .map((item) => item.originalTransactionId)
      .filter((id): id is string => Boolean(id)),
  );

  const activePaidClaims = paidClaims
    .filter((claim) => !reversedIds.has(claim.id))
    .sort(
      (a, b) =>
        b.coveragePosition - a.coveragePosition ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );

  if (
    options?.requireMajoritySource &&
    activePaidClaims.some(
      (claim) => claim.payer.billingNdcStrategy !== "MAJORITY_SOURCE",
    )
  ) {
    throw new ClaimError(
      409,
      "PAID_CLAIM_REVERSAL_REQUIRED",
      "Reverse the active paid claim before changing product-source details for a payer that does not use automatic majority-NDC billing.",
      {
        claimTransactionIds: activePaidClaims.map((claim) => claim.id),
      },
    );
  }

  const results = [];
  for (const claim of activePaidClaims) {
    results.push(await reverseClaimTransaction(claim.id, context));
  }
  return results;
}

export async function assertNoActivePaidClaimForMutation(
  fillId: string,
  siteId: string,
) {
  const paidClaims = await db.claimTransaction.findMany({
    where: {
      fillId,
      siteId,
      operation: "SUBMIT",
      outcome: "PAID",
    },
    select: { id: true },
  });
  if (paidClaims.length === 0) return;

  const paidIds = paidClaims.map((claim) => claim.id);
  const reversals = await db.claimTransaction.findMany({
    where: {
      siteId,
      operation: "REVERSAL",
      outcome: "REVERSED",
      originalTransactionId: { in: paidIds },
    },
    select: { originalTransactionId: true },
  });
  const reversedIds = new Set(
    reversals
      .map((item) => item.originalTransactionId)
      .filter((id): id is string => Boolean(id)),
  );
  const activePaid = paidIds.find((id) => !reversedIds.has(id));
  if (activePaid) {
    throw new ClaimError(
      409,
      "PAID_CLAIM_REVERSAL_REQUIRED",
      "Reverse the active paid claim before changing claim-sensitive billing or product-source details.",
      { claimTransactionId: activePaid },
    );
  }
}

export async function assertNoActivePaidClaimsForPatientCoverageMutation(
  patientId: string,
  siteId: string,
) {
  const paidClaims = await db.claimTransaction.findMany({
    where: {
      siteId,
      operation: "SUBMIT",
      outcome: "PAID",
      fill: {
        status: "IN_PROGRESS",
        prescription: { patientId, siteId },
      },
    },
    select: { id: true, fillId: true },
  });
  if (paidClaims.length === 0) return;

  const paidIds = paidClaims.map((claim) => claim.id);
  const reversals = await db.claimTransaction.findMany({
    where: {
      siteId,
      operation: "REVERSAL",
      outcome: "REVERSED",
      originalTransactionId: { in: paidIds },
    },
    select: { originalTransactionId: true },
  });
  const reversedIds = new Set(
    reversals
      .map((item) => item.originalTransactionId)
      .filter((id): id is string => Boolean(id)),
  );
  const activePaid = paidClaims.find((claim) => !reversedIds.has(claim.id));
  if (activePaid) {
    throw new ClaimError(
      409,
      "PAID_CLAIM_REVERSAL_REQUIRED",
      "Reverse the active paid claim before changing this patient's coverage while the fill is still in progress.",
      {
        claimTransactionId: activePaid.id,
        fillId: activePaid.fillId,
      },
    );
  }
}

export async function assertFillBillingReadyForReview(
  fillId: string,
  siteId: string,
) {
  const fill = await db.prescriptionFill.findFirst({
    where: { id: fillId, prescription: { siteId } },
    include: {
      prescription: {
        include: {
          patient: { include: { coverages: true } },
        },
      },
    },
  });
  if (!fill) {
    throw new ClaimError(404, "FILL_NOT_FOUND", "Fill not found.");
  }

  const now = new Date();
  const hasActiveThirdParty = fill.prescription.patient.coverages.some(
    (coverage) => activeOnDate(coverage, now),
  );
  if (!hasActiveThirdParty) return;

  const activeLabel = await db.prescriptionLabel.findFirst({
    where: {
      fillId,
      status: "ACTIVE",
      claimTransactionId: { not: null },
    },
  });
  if (!activeLabel) {
    throw new ClaimError(
      409,
      "CLAIM_PAYMENT_REQUIRED",
      "A paid third-party claim and active dispensing label are required before pharmacist review.",
    );
  }
}

export async function markLabelPrintJobPrinted(
  printJobId: string,
  context: ClaimActorContext,
  printerName?: string | null,
) {
  const job = await db.labelPrintJob.findFirst({
    where: { id: printJobId, siteId: context.siteId },
    include: { label: true },
  });
  if (!job) {
    throw new ClaimError(404, "PRINT_JOB_NOT_FOUND", "Label print job not found.");
  }
  if (job.label.status !== "ACTIVE") {
    throw new ClaimError(
      409,
      "LABEL_VOID",
      "A voided prescription label cannot be printed.",
    );
  }
  if (job.status === "PRINTED") return job;
  if (job.status === "CANCELLED") {
    throw new ClaimError(
      409,
      "PRINT_JOB_CANCELLED",
      "This label print job has been cancelled.",
    );
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.labelPrintJob.update({
      where: { id: job.id },
      data: {
        status: "PRINTED",
        printerName: printerName?.trim() || job.printerName,
        actorId: context.actorId,
        printedAt: new Date(),
        failedAt: null,
        failureReason: null,
      },
      include: { label: true },
    });
    await writeAuditEvent(tx, {
      siteId: context.siteId,
      actorId: context.actorId,
      action: "LABEL_PRINT_JOB_PRINTED",
      entityType: "LabelPrintJob",
      entityId: job.id,
      requestId: context.requestId,
      metadata: {
        labelId: job.labelId,
        fillId: job.label.fillId,
        printerName: updated.printerName,
      },
    });
    return updated;
  });
}
