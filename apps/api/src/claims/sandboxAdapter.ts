import { createHash } from "node:crypto";
import type { ClaimStandard } from "@prisma/client";
import type {
  CanonicalClaimRequest,
  CanonicalClaimResponse,
  ClaimAdapter,
  ClaimAdapterContext,
} from "./adapter.js";

function reference(prefix: string, key: string) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 18).toUpperCase();
  return `${prefix}-${digest}`;
}

class SandboxClaimAdapter implements ClaimAdapter {
  readonly name: string;
  readonly version = "1";

  constructor(readonly standard: ClaimStandard) {
    this.name = `pharmacy1os-sandbox-${standard.toLowerCase()}`;
  }

  async submit(
    request: CanonicalClaimRequest,
    context: ClaimAdapterContext,
  ): Promise<CanonicalClaimResponse> {
    const member = request.memberId.toUpperCase();

    if (member.includes("ERROR")) {
      return {
        status: "ERROR",
        transactionReference: null,
        authorizationNumber: null,
        amountPaid: null,
        patientResponsibility: null,
        rejectCodes: [],
        messages: ["Synthetic transport failure from the Pharmacy1OS claim sandbox."],
        rawStandard: context.standard,
      };
    }

    if (member.includes("REJECT")) {
      return {
        status: "REJECTED",
        transactionReference: reference("SBX-RJ", request.claimIdempotencyKey),
        authorizationNumber: null,
        amountPaid: "0.00",
        patientResponsibility: null,
        rejectCodes: ["70"],
        messages: ["Synthetic reject: product/service not covered."],
        rawStandard: context.standard,
      };
    }

    const copayMatch = member.match(/COPAY(\d{1,6})/);
    const patientResponsibility = copayMatch
      ? (Number.parseInt(copayMatch[1]!, 10) / 100).toFixed(2)
      : "0.00";

    return {
      status: "PAID",
      transactionReference: reference("SBX-PD", request.claimIdempotencyKey),
      authorizationNumber: reference("AUTH", request.claimIdempotencyKey).slice(0, 20),
      amountPaid: "0.00",
      patientResponsibility,
      rejectCodes: [],
      messages: [
        `Synthetic ${context.standard} paid response. Payer-intended quantity ${request.payerIntendedQuantity}; physical dispense quantity ${request.physicalPartQuantity}; patient responsibility ${patientResponsibility}.`,
      ],
      rawStandard: context.standard,
    };
  }

  async reverse(
    request: CanonicalClaimRequest & { originalTransactionReference: string },
    context: ClaimAdapterContext,
  ): Promise<CanonicalClaimResponse> {
    if (request.memberId.toUpperCase().includes("REVERROR")) {
      return {
        status: "ERROR",
        transactionReference: null,
        authorizationNumber: null,
        amountPaid: null,
        patientResponsibility: null,
        rejectCodes: [],
        messages: ["Synthetic reversal transport failure from the Pharmacy1OS claim sandbox."],
        rawStandard: context.standard,
      };
    }

    return {
      status: "REVERSED",
      transactionReference: reference("SBX-RV", request.claimIdempotencyKey),
      authorizationNumber: null,
      amountPaid: "0.00",
      patientResponsibility: "0.00",
      rejectCodes: [],
      messages: [
        `Synthetic reversal accepted for ${request.originalTransactionReference}.`,
      ],
      rawStandard: context.standard,
    };
  }
}

const adapters: Record<ClaimStandard, ClaimAdapter> = {
  D0: new SandboxClaimAdapter("D0"),
  F6: new SandboxClaimAdapter("F6"),
};

export function getClaimAdapter(standard: ClaimStandard) {
  if (
    process.env.CLAIM_SANDBOX_ENABLED !== "true" &&
    process.env.ALLOW_DEV_IDENTITY !== "true"
  ) {
    throw new Error(
      "No production claim transport is configured. Enable the explicit sandbox only in development/test.",
    );
  }
  return adapters[standard];
}
