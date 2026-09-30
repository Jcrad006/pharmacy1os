import type {
  DevUser,
  Patient,
  Prescriber,
  PrescriptionFill,
  PrescriptionStatus,
  UserRole,
} from "./types";

export const statusLabels: Record<PrescriptionStatus, string> = {
  RECEIVED: "Received",
  DATA_ENTRY: "Data Entry",
  DUR_REVIEW: "DUR Review",
  PRODUCT_FILL: "Product Fill",
  PHARMACIST_REVIEW: "Pharmacist Review",
  READY: "Ready",
  SOLD: "Sold",
  ON_HOLD: "On Hold",
  CANCELLED: "Cancelled",
  TRANSFERRED: "Transferred",
};

export function formatPatientName(patient: Patient) {
  return `${patient.lastName}, ${patient.firstName}`;
}

export function formatPrescriberName(prescriber: Prescriber) {
  return `${prescriber.lastName}, ${prescriber.firstName}`;
}

export function canProcess(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "TECHNICIAN", "INTERN"].includes(user.role),
  );
}

export function canEditPrescription(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "TECHNICIAN", "INTERN"].includes(user.role),
  );
}

export function canVerify(user?: DevUser) {
  return Boolean(user && ["ADMIN", "PHARMACIST"].includes(user.role));
}

export function canSell(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "TECHNICIAN", "CASHIER"].includes(user.role),
  );
}

export function canReadAudit(user?: DevUser) {
  return Boolean(user && ["ADMIN", "PHARMACIST", "AUDITOR"].includes(user.role));
}

export function canWritePatients(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "TECHNICIAN", "INTERN"].includes(user.role),
  );
}

export function roleLabel(role: UserRole) {
  return role
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function activeFill(fills: PrescriptionFill[]) {
  return fills.find((fill) =>
    ["SCHEDULED", "IN_PROGRESS", "READY"].includes(fill.status),
  );
}

export function readyFill(fills: PrescriptionFill[]) {
  return fills.find((fill) => fill.status === "READY");
}

export function remainingRefills(refillsAllowed: number, refillsUsed: number) {
  return Math.max(0, refillsAllowed - refillsUsed);
}

export function prescriptionCanBeEdited(status: PrescriptionStatus) {
  return ["RECEIVED", "DATA_ENTRY", "DUR_REVIEW", "ON_HOLD"].includes(status);
}

export function canDocumentClinical(user?: DevUser) {
  return Boolean(user && ["ADMIN", "PHARMACIST"].includes(user.role));
}

