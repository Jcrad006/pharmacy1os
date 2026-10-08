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
  const credential = prescriber.practiceLevel?.trim();
  return `${prescriber.lastName}, ${prescriber.firstName}${credential ? `, ${credential}` : ""}`;
}

export function primaryProviderIdentifier(
  prescriber: Prescriber,
  type: "NPI" | "DEA" | "STATE_ID",
) {
  return (
    prescriber.identifiers.find((item) => item.type === type && item.isPrimary) ??
    prescriber.identifiers.find((item) => item.type === type)
  );
}

export function primaryProviderContact(
  prescriber: Prescriber,
  type: "PHONE" | "FAX",
) {
  return (
    prescriber.contacts.find((item) => item.type === type && item.isPrimary) ??
    prescriber.contacts.find((item) => item.type === type)
  );
}

export function canProcess(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE", "TECHNICIAN", "INTERN"].includes(user.role),
  );
}

export function canEditPrescription(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE", "TECHNICIAN", "INTERN"].includes(user.role),
  );
}

export function canManagePrescriptionDocuments(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE", "TECHNICIAN", "INTERN"].includes(user.role),
  );
}

export function canVerify(user?: DevUser) {
  return Boolean(user && ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE"].includes(user.role));
}

export function canAuthorizeEmergencySupply(user?: DevUser) {
  return Boolean(user && ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE"].includes(user.role));
}

export function canSell(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE", "TECHNICIAN", "CASHIER"].includes(user.role),
  );
}

export function canReadAudit(user?: DevUser) {
  return Boolean(user && ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE", "AUDITOR"].includes(user.role));
}

export function canWritePatients(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE", "TECHNICIAN", "INTERN"].includes(user.role),
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
  return (
    fills.find((fill) => fill.status === "IN_PROGRESS") ??
    fills.find((fill) => fill.status === "READY") ??
    fills.find((fill) => fill.status === "SCHEDULED")
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


export function prioritizeQueueByStatus<
  T extends { status: PrescriptionStatus },
>(
  items: readonly T[],
  priorityStatus: "" | PrescriptionStatus,
): T[] {
  if (!priorityStatus) return [...items];

  const priority: T[] = [];
  const remainder: T[] = [];

  for (const item of items) {
    if (item.status === priorityStatus) priority.push(item);
    else remainder.push(item);
  }

  return [...priority, ...remainder];
}


export function canWriteInventory(user?: DevUser) {
  return Boolean(
    user && ["ADMIN", "PHARMACIST", "TECHNICIAN", "INTERN"].includes(user.role),
  );
}


export function canCorrectInventory(user?: DevUser) {
  return Boolean(user && ["ADMIN", "PHARMACIST"].includes(user.role));
}
