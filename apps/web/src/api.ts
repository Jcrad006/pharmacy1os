import type {
  AuditEvent,
  DevUser,
  DurIssue,
  DurSeverity,
  InterventionNote,
  Patient,
  Prescriber,
  PrescriptionFill,
  PrescriptionQueueItem,
  PrescriptionStatus,
} from "./types";

type ApiOptions = RequestInit & {
  devUser?: string;
};

async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");

  if (options.devUser) {
    headers.set("x-dev-user", options.devUser);
  }

  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  }

  return payload as T;
}

export async function getDevelopmentUsers() {
  const result = await request<{
    users: Array<DevUser & { externalAuthId: string | null }>;
  }>("/api/dev/users");

  return result.users.filter(
    (user): user is DevUser => typeof user.externalAuthId === "string",
  );
}

export async function getPrescriptionQueue(devUser: string) {
  const result = await request<{ prescriptions: PrescriptionQueueItem[] }>(
    "/api/prescriptions/queue",
    { devUser },
  );
  return result.prescriptions;
}

export async function getWillCall(devUser: string) {
  const result = await request<{ prescriptions: PrescriptionQueueItem[] }>(
    "/api/prescriptions/will-call",
    { devUser },
  );
  return result.prescriptions;
}

export async function getPrescription(devUser: string, id: string) {
  const result = await request<{ prescription: PrescriptionQueueItem }>(
    `/api/prescriptions/${id}`,
    { devUser },
  );
  return result.prescription;
}

export async function getPrescriptionAudit(devUser: string, id: string) {
  const result = await request<{ events: AuditEvent[] }>(
    `/api/prescriptions/${id}/audit`,
    { devUser },
  );
  return result.events;
}

export async function getPatients(devUser: string) {
  const result = await request<{ patients: Patient[] }>("/api/patients", { devUser });
  return result.patients;
}

export async function createPatient(
  devUser: string,
  input: {
    firstName: string;
    lastName: string;
    dateOfBirth?: string;
    phone?: string;
    email?: string;
  },
) {
  return request<{ patient: Patient }>("/api/patients", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function getPrescribers(devUser: string) {
  const result = await request<{ prescribers: Prescriber[] }>("/api/prescribers", {
    devUser,
  });
  return result.prescribers;
}

export async function createPrescriber(
  devUser: string,
  input: {
    firstName: string;
    lastName: string;
    npi?: string;
    deaNumber?: string;
    phone?: string;
    fax?: string;
  },
) {
  return request<{ prescriber: Prescriber }>("/api/prescribers", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function transitionPrescription(
  devUser: string,
  id: string,
  status: PrescriptionStatus,
) {
  return request<{ prescription: PrescriptionQueueItem }>(
    `/api/prescriptions/${id}/status`,
    {
      method: "PATCH",
      devUser,
      body: JSON.stringify({ status }),
    },
  );
}

export async function updatePrescription(
  devUser: string,
  id: string,
  input: {
    prescriberId?: string;
    medicationName?: string;
    strength?: string | null;
    dosageForm?: string | null;
    sig?: string;
    quantityWritten?: number;
    refillsAllowed?: number;
    writtenDate?: string | null;
    expirationDate?: string | null;
    doNotFillBefore?: string | null;
    minimumDaysBetweenFills?: number | null;
  },
) {
  return request<{ prescription: PrescriptionQueueItem }>(
    `/api/prescriptions/${id}`,
    {
      method: "PATCH",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function createPrescription(
  devUser: string,
  input: {
    patientId: string;
    prescriberId: string;
    rxNumber?: string;
    medicationName: string;
    strength?: string;
    dosageForm?: string;
    sig: string;
    quantityWritten?: number;
    refillsAllowed?: number;
    writtenDate?: string;
    doNotFillBefore?: string;
  },
) {
  return request<{ prescription: PrescriptionQueueItem }>("/api/prescriptions", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function createFill(
  devUser: string,
  prescriptionId: string,
  input: { quantity?: number; scheduledFor?: string },
) {
  return request<{
    fill: PrescriptionFill;
    prescription: PrescriptionQueueItem;
  }>(`/api/prescriptions/${prescriptionId}/fills`, {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}

export async function startFill(devUser: string, fillId: string) {
  return request<{
    fill: PrescriptionFill;
    prescription: PrescriptionQueueItem;
  }>(`/api/fills/${fillId}/start`, {
    method: "POST",
    devUser,
  });
}

export async function returnFillToStock(devUser: string, fillId: string) {
  return request<{
    fill: PrescriptionFill;
    prescription: PrescriptionQueueItem;
  }>(`/api/fills/${fillId}/return-to-stock`, {
    method: "POST",
    devUser,
  });
}

export async function getClinicalRecord(devUser: string, prescriptionId: string) {
  return request<{ issues: DurIssue[]; interventions: InterventionNote[] }>(
    `/api/prescriptions/${prescriptionId}/clinical`,
    { devUser },
  );
}

export async function createDurIssue(
  devUser: string,
  prescriptionId: string,
  input: {
    code: string;
    title: string;
    description?: string;
    severity?: DurSeverity;
  },
) {
  return request<{ issue: DurIssue }>(
    `/api/prescriptions/${prescriptionId}/dur/issues`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify(input),
    },
  );
}

export async function resolveDurIssue(devUser: string, issueId: string) {
  return request<{ issue: DurIssue }>(
    `/api/dur/issues/${issueId}/resolve`,
    {
      method: "PATCH",
      devUser,
    },
  );
}

export async function createIntervention(
  devUser: string,
  prescriptionId: string,
  note: string,
) {
  return request<{ intervention: InterventionNote }>(
    `/api/prescriptions/${prescriptionId}/interventions`,
    {
      method: "POST",
      devUser,
      body: JSON.stringify({ note }),
    },
  );
}
