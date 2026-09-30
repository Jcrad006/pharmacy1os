import type { PrescriptionStatus } from "@prisma/client";
import type { Permission } from "../security/roles.js";

const transitions: Record<PrescriptionStatus, readonly PrescriptionStatus[]> = {
  RECEIVED: ["DATA_ENTRY", "ON_HOLD", "CANCELLED", "TRANSFERRED"],
  DATA_ENTRY: ["DUR_REVIEW", "ON_HOLD", "CANCELLED", "TRANSFERRED"],
  DUR_REVIEW: ["PRODUCT_FILL", "ON_HOLD", "CANCELLED", "TRANSFERRED"],
  PRODUCT_FILL: ["PHARMACIST_REVIEW", "ON_HOLD", "CANCELLED"],
  PHARMACIST_REVIEW: ["READY", "PRODUCT_FILL", "ON_HOLD", "CANCELLED"],
  READY: ["SOLD", "ON_HOLD", "CANCELLED"],
  SOLD: [],
  ON_HOLD: ["DATA_ENTRY", "DUR_REVIEW", "PRODUCT_FILL", "PHARMACIST_REVIEW", "CANCELLED", "TRANSFERRED"],
  CANCELLED: [],
  TRANSFERRED: [],
};

export function canTransitionPrescription(
  from: PrescriptionStatus,
  to: PrescriptionStatus,
) {
  return transitions[from].includes(to);
}

export function permissionForTransition(
  from: PrescriptionStatus,
  to: PrescriptionStatus,
): Permission {
  if (from === "PHARMACIST_REVIEW" && to === "READY") {
    return "prescription:verify";
  }
  return "prescription:process";
}

export function allowedTransitions(from: PrescriptionStatus) {
  return transitions[from];
}
