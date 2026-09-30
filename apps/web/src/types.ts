export type UserRole =
  | "ADMIN"
  | "PHARMACIST"
  | "TECHNICIAN"
  | "INTERN"
  | "CASHIER"
  | "AUDITOR";

export type PrescriptionStatus =
  | "RECEIVED"
  | "DATA_ENTRY"
  | "DUR_REVIEW"
  | "PRODUCT_FILL"
  | "PHARMACIST_REVIEW"
  | "READY"
  | "SOLD"
  | "ON_HOLD"
  | "CANCELLED"
  | "TRANSFERRED";

export type FillStatus =
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "READY"
  | "SOLD"
  | "RETURNED_TO_STOCK"
  | "CANCELLED";

export type DurSeverity = "INFO" | "WARNING" | "HIGH";
export type DurIssueStatus = "OPEN" | "RESOLVED";

export type DevUser = {
  externalAuthId: string;
  displayName: string;
  role: UserRole;
};

export type Patient = {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  phone: string | null;
  email?: string | null;
};

export type Prescriber = {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  npi: string | null;
  deaNumber?: string | null;
  phone?: string | null;
  fax?: string | null;
};

export type PrescriptionFill = {
  id: string;
  fillNumber: number;
  scheduledFor: string | null;
  quantity: string | number | null;
  status: FillStatus;
  filledAt: string | null;
  soldAt: string | null;
  createdAt: string;
};

export type PrescriptionQueueItem = {
  id: string;
  rxNumber: string | null;
  medicationName: string;
  strength: string | null;
  dosageForm: string | null;
  sig: string;
  quantityWritten: string | number | null;
  refillsAllowed: number;
  refillsUsed: number;
  writtenDate: string | null;
  expirationDate: string | null;
  minimumDaysBetweenFills: number | null;
  status: PrescriptionStatus;
  heldFromStatus: PrescriptionStatus | null;
  doNotFillBefore: string | null;
  createdAt: string;
  updatedAt: string;
  patient: Patient;
  prescriber: Prescriber;
  fills: PrescriptionFill[];
  allowedTransitions: PrescriptionStatus[];
};

export type AuditEvent = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  occurredAt: string;
  actor: {
    displayName: string;
    role: UserRole;
  } | null;
};

export type DurIssue = {
  id: string;
  prescriptionId: string;
  code: string;
  title: string;
  description: string | null;
  severity: DurSeverity;
  status: DurIssueStatus;
  source: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: {
    displayName: string;
    role: UserRole;
  } | null;
};

export type InterventionNote = {
  id: string;
  prescriptionId: string;
  note: string;
  createdAt: string;
  author: {
    displayName: string;
    role: UserRole;
  };
};
