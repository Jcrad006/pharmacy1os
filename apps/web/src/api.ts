import type {
  AuditEvent,
  DevUser,
  DurIssue,
  DurSeverity,
  ExceptionItem,
  ExceptionKind,
  ExceptionSummary,
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

export async function getPrescriptionQueue(
  devUser: string,
  options?: {
    query?: string;
    status?: PrescriptionStatus | "";
    sort?: "oldest" | "newest";
    limit?: number;
  },
) {
  const params = new URLSearchParams();
  if (options?.query?.trim()) params.set("query", options.query.trim());
  if (options?.status) params.set("status", options.status);
  if (options?.sort) params.set("sort", options.sort);
  if (options?.limit) params.set("limit", String(options.limit));

  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await request<{ prescriptions: PrescriptionQueueItem[] }>(
    `/api/prescriptions/queue${suffix}`,
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

export type DirectoryFilters = {
  lastName?: string;
  firstName?: string;
  dateOfBirth?: string;
  phone?: string;
  query?: string;
};

function addDirectoryFilters(params: URLSearchParams, filters?: string | DirectoryFilters) {
  if (typeof filters === "string") {
    if (filters.trim()) params.set("query", filters.trim());
    return;
  }

  if (!filters) return;
  for (const [key, value] of Object.entries(filters)) {
    if (value?.trim()) params.set(key, value.trim());
  }
}

export async function getPatients(
  devUser: string,
  filters?: string | DirectoryFilters,
) {
  const params = new URLSearchParams();
  addDirectoryFilters(params, filters);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await request<{ patients: Patient[] }>(
    `/api/patients${suffix}`,
    { devUser },
  );
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

export async function getPrescribers(
  devUser: string,
  filters?: string | DirectoryFilters,
) {
  const params = new URLSearchParams();
  addDirectoryFilters(params, filters);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const result = await request<{ prescribers: Prescriber[] }>(
    `/api/prescribers${suffix}`,
    { devUser },
  );
  return result.prescribers;
}

export async function createPrescriber(
  devUser: string,
  input: {
    firstName: string;
    lastName: string;
    practiceLevel: string;
    dateOfBirth?: string;
    identifiers?: Array<{
      type: "NPI" | "DEA" | "STATE_ID";
      number: string;
      jurisdiction?: string;
      isPrimary?: boolean;
    }>;
    contacts?: Array<{
      type: "PHONE" | "FAX";
      label?: string;
      value: string;
      extension?: string;
      isPrimary?: boolean;
    }>;
    addresses?: Array<{
      label?: string;
      addressLine1: string;
      addressLine2?: string;
      city: string;
      state: string;
      postalCode: string;
      isPrimary?: boolean;
    }>;
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

export async function resolveDurIssue(
  devUser: string,
  issueId: string,
  note: string,
) {
  return request<{ issue: DurIssue }>(
    `/api/dur/issues/${issueId}/resolve`,
    {
      method: "PATCH",
      devUser,
      body: JSON.stringify({ note }),
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

export async function getExceptions(
  devUser: string,
  options?: { query?: string; kind?: ExceptionKind | ""; limit?: number },
) {
  const params = new URLSearchParams();
  if (options?.query?.trim()) params.set("query", options.query.trim());
  if (options?.kind) params.set("kind", options.kind);
  if (options?.limit) params.set("limit", String(options.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";

  return request<{ exceptions: ExceptionItem[]; summary: ExceptionSummary }>(
    `/api/exceptions${suffix}`,
    { devUser },
  );
}
