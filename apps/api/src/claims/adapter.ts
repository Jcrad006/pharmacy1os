import type {
  BillingNdcStrategy,
  ClaimOutcome,
  ClaimStandard,
} from "@prisma/client";

export type CanonicalCobPriorPayer = {
  position: number;
  payerId: string;
  responseStatus: "PAID" | "REJECTED" | "ERROR";
  amountPaid?: string | null;
  patientResponsibility?: string | null;
  rejectCodes?: string[];
  transactionReference?: string | null;
  adjudicatedAt: Date;
};

export type CanonicalClaimRequest = {
  claimIdempotencyKey: string;
  siteId: string;
  prescriptionId: string;
  fillId: string;
  coveragePosition: number;
  payerId: string;
  memberId: string;
  personCode?: string | null;
  groupId?: string | null;
  billedProductId: string;
  billedNdc: string;
  payerIntendedQuantity: string;
  physicalPartQuantity: string;
  daysSupply: number;
  priorPayers: CanonicalCobPriorPayer[];
};

export type CanonicalClaimResponse = {
  status: ClaimOutcome;
  transactionReference?: string | null;
  authorizationNumber?: string | null;
  amountPaid?: string | null;
  patientResponsibility?: string | null;
  rejectCodes: string[];
  messages: string[];
  rawStandard: ClaimStandard;
};

export type ClaimAdapterContext = {
  standard: ClaimStandard;
  billingNdcStrategy: BillingNdcStrategy;
};

export interface ClaimAdapter {
  readonly standard: ClaimStandard;
  readonly name: string;
  readonly version: string;
  submit(
    request: CanonicalClaimRequest,
    context: ClaimAdapterContext,
  ): Promise<CanonicalClaimResponse>;
  reverse(
    request: CanonicalClaimRequest & { originalTransactionReference: string },
    context: ClaimAdapterContext,
  ): Promise<CanonicalClaimResponse>;
}

export type PhysicalClaimSource = {
  productId: string;
  quantity: number;
};

export function requireBillingNdcSelection(input: {
  physicalSources: PhysicalClaimSource[];
  billingProductId?: string | null;
  billingNdcStrategy: BillingNdcStrategy;
}) {
  const quantities = new Map<string, number>();
  for (const source of input.physicalSources) {
    if (!Number.isFinite(source.quantity) || source.quantity <= 0) continue;
    quantities.set(
      source.productId,
      (quantities.get(source.productId) ?? 0) + source.quantity,
    );
  }

  const uniqueProducts = new Set(quantities.keys());
  if (uniqueProducts.size === 0) {
    throw new Error("At least one positive physical product source is required before claim construction.");
  }
  if (uniqueProducts.size === 1) {
    return [...uniqueProducts][0]!;
  }
  if (input.billingNdcStrategy === "SINGLE_SOURCE_ONLY") {
    throw new Error("This payer does not permit a split-product billing workflow.");
  }

  const selectedIsPhysical =
    Boolean(input.billingProductId) &&
    uniqueProducts.has(input.billingProductId!);

  if (
    input.billingNdcStrategy === "REQUIRE_MANUAL_SELECTION" ||
    input.billingNdcStrategy === "PAYER_CONFIGURED"
  ) {
    if (!selectedIsPhysical) {
      throw new Error("A billed NDC/product must be explicitly selected from the physical products used for this split fill.");
    }
    return input.billingProductId!;
  }

  const maximumQuantity = Math.max(...quantities.values());
  const majorityProducts = [...quantities.entries()]
    .filter(([, quantity]) => quantity === maximumQuantity)
    .map(([productId]) => productId);

  if (majorityProducts.length === 1) {
    return majorityProducts[0]!;
  }

  if (
    input.billingNdcStrategy === "MAJORITY_SOURCE" &&
    input.billingProductId &&
    majorityProducts.includes(input.billingProductId)
  ) {
    return input.billingProductId;
  }

  throw new Error(
    "The split fill has an exact quantity tie between NDCs. Explicitly select one of the tied physical products before adjudication.",
  );
}
