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

export type PrescriberIdentifierType = "NPI" | "DEA" | "STATE_ID";
export type PrescriberContactType = "PHONE" | "FAX";

export type PrescriberIdentifier = {
  id: string;
  type: PrescriberIdentifierType;
  number: string;
  jurisdiction: string;
  isPrimary: boolean;
};

export type PrescriberContact = {
  id: string;
  type: PrescriberContactType;
  label: string | null;
  value: string;
  extension: string | null;
  isPrimary: boolean;
};

export type PrescriberAddress = {
  id: string;
  label: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  isPrimary: boolean;
};

export type Prescriber = {
  id: string;
  firstName: string;
  lastName: string;
  practiceLevel: string;
  dateOfBirth: string | null;
  identifiers: PrescriberIdentifier[];
  contacts: PrescriberContact[];
  addresses: PrescriberAddress[];
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
  eligibleAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  resolvedAutomatically: boolean;
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

export type ExceptionKind =
  | "CLINICAL_ISSUE"
  | "ON_HOLD"
  | "PHARMACIST_REVIEW"
  | "SCHEDULED_FILL";

export type ExceptionItem = {
  id: string;
  kind: ExceptionKind;
  prescriptionId: string;
  rxNumber: string | null;
  patientName: string;
  medicationName: string;
  title: string;
  detail: string | null;
  severity: DurSeverity;
  dueAt: string | null;
  createdAt: string;
};

export type ExceptionSummary = {
  total: number;
  clinical: number;
  onHold: number;
  pharmacistReview: number;
  scheduled: number;
};
