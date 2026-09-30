import type { PrescriptionStatus } from "@prisma/client";
import type { Permission } from "../security/roles.js";

const transitions: Record<
  Exclude<PrescriptionStatus, "ON_HOLD">,
  readonly PrescriptionStatus[]
> = {
  RECEIVED: ["DATA_ENTRY", "ON_HOLD", "CANCELLED", "TRANSFERRED"],
  DATA_ENTRY: ["DUR_REVIEW", "ON_HOLD", "CANCELLED", "TRANSFERRED"],
  DUR_REVIEW: ["ON_HOLD", "CANCELLED", "TRANSFERRED"],
  PRODUCT_FILL: ["PHARMACIST_REVIEW", "ON_HOLD", "CANCELLED"],
  PHARMACIST_REVIEW: ["READY", "PRODUCT_FILL", "ON_HOLD", "CANCELLED"],
  READY: ["SOLD", "ON_HOLD", "CANCELLED"],
  SOLD: ["DUR_REVIEW", "ON_HOLD", "CANCELLED", "TRANSFERRED"],
  CANCELLED: [],
  TRANSFERRED: [],
};

export function allowedTransitions(
  from: PrescriptionStatus,
  heldFromStatus?: PrescriptionStatus | null,
): readonly PrescriptionStatus[] {
  if (from === "ON_HOLD") {
    return heldFromStatus
      ? [heldFromStatus, "CANCELLED", "TRANSFERRED"]
      : ["CANCELLED", "TRANSFERRED"];
  }

  return transitions[from];
}

export function canTransitionPrescription(
  from: PrescriptionStatus,
  to: PrescriptionStatus,
  heldFromStatus?: PrescriptionStatus | null,
) {
  return allowedTransitions(from, heldFromStatus).includes(to);
}

export function permissionForTransition(
  from: PrescriptionStatus,
  to: PrescriptionStatus,
): Permission {
  if (from === "PHARMACIST_REVIEW" && to === "READY") {
    return "prescription:verify";
  }

  if (from === "READY" && to === "SOLD") {
    return "prescription:sell";
  }

  return "prescription:process";
}
