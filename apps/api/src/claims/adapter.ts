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

export function requireBillingNdcSelection(input: {
  physicalProductIds: string[];
  billingProductId?: string | null;
  billingNdcStrategy: BillingNdcStrategy;
}) {
  const uniqueProducts = new Set(input.physicalProductIds);
  if (uniqueProducts.size === 0) {
    throw new Error("At least one physical product source is required before claim construction.");
  }
  if (uniqueProducts.size === 1) {
    return input.billingProductId ?? input.physicalProductIds[0]!;
  }
  if (
    input.billingNdcStrategy === "SINGLE_SOURCE_ONLY" &&
    uniqueProducts.size > 1
  ) {
    throw new Error("This payer does not permit a split-product billing workflow.");
  }
  if (!input.billingProductId) {
    throw new Error("A billed NDC/product must be explicitly selected for a split-product fill.");
  }
  if (!uniqueProducts.has(input.billingProductId)) {
    throw new Error("The billed product must be one of the physical products used for this fill.");
  }
  return input.billingProductId;
}
