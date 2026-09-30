import type {
  DevUser,
  Patient,
  Prescriber,
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
  const result = await request<{ users: Array<DevUser & { externalAuthId: string | null }> }>(
    "/api/dev/users",
  );

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

export async function getPatients(devUser: string) {
  const result = await request<{ patients: Patient[] }>("/api/patients", { devUser });
  return result.patients;
}

export async function getPrescribers(devUser: string) {
  const result = await request<{ prescribers: Prescriber[] }>("/api/prescribers", {
    devUser,
  });
  return result.prescribers;
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
    doNotFillBefore?: string;
  },
) {
  return request<{ prescription: PrescriptionQueueItem }>("/api/prescriptions", {
    method: "POST",
    devUser,
    body: JSON.stringify(input),
  });
}
