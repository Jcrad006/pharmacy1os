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
};

export type Prescriber = {
  id: string;
  firstName: string;
  lastName: string;
  npi: string | null;
};

export type PrescriptionFill = {
  id: string;
  fillNumber: number;
  scheduledFor: string | null;
  status: string;
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
  status: PrescriptionStatus;
  doNotFillBefore: string | null;
  updatedAt: string;
  patient: Patient;
  prescriber: Prescriber;
  fills: PrescriptionFill[];
  allowedTransitions: PrescriptionStatus[];
};
