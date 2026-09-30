import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };
const pharmacistHeaders = { "x-dev-user": "dev-pharmacist" };

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

async function makeRx(options?: {
  expirationDate?: string;
  minimumDaysBetweenFills?: number;
  refillsAllowed?: number;
}) {
  const suffix = randomUUID().slice(0, 8);

  const patient = await app.inject({
    method: "POST",
    url: "/api/patients",
    headers: technicianHeaders,
    payload: {
      firstName: "Clinical",
      lastName: `Patient-${suffix}`,
    },
  });
  expect(patient.statusCode).toBe(201);

  const prescriber = await app.inject({
    method: "POST",
    url: "/api/prescribers",
    headers: technicianHeaders,
    payload: {
      firstName: "Clinical",
      lastName: `Prescriber-${suffix}`,
      npi: `8${Math.floor(Math.random() * 1_000_000_000)
        .toString()
        .padStart(9, "0")}`,
    },
  });
  expect(prescriber.statusCode).toBe(201);

  const rx = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId: patient.json().patient.id,
      prescriberId: prescriber.json().prescriber.id,
      rxNumber: `CLIN-${suffix}`,
      medicationName: "Synthetic Clinical Test Drug",
      strength: "1 unit",
      dosageForm: "tablet",
      sig: "Use as directed for synthetic testing",
      quantityWritten: 30,
      refillsAllowed: options?.refillsAllowed ?? 1,
      expirationDate: options?.expirationDate,
      minimumDaysBetweenFills: options?.minimumDaysBetweenFills,
    },
  });
  expect(rx.statusCode).toBe(201);

  const prescriptionId = rx.json().prescription.id as string;

  const dur = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: technicianHeaders,
    payload: { status: "DUR_REVIEW" },
  });
  expect(dur.statusCode).toBe(200);

  return prescriptionId;
}

async function dispenseAndSell(prescriptionId: string) {
  const fill = await app.inject({
    method: "POST",
    url: `/api/prescriptions/${prescriptionId}/fills`,
    headers: technicianHeaders,
    payload: { quantity: 30 },
  });
  expect(fill.statusCode).toBe(201);

  const review = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: technicianHeaders,
    payload: { status: "PHARMACIST_REVIEW" },
  });
  expect(review.statusCode).toBe(200);

  const ready = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: pharmacistHeaders,
    payload: { status: "READY" },
  });
  expect(ready.statusCode).toBe(200);

  const sold = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: technicianHeaders,
    payload: { status: "SOLD" },
  });
  expect(sold.statusCode).toBe(200);
}

describe("synthetic clinical date rules", () => {
  it("blocks an expired prescription and opens a structured DUR issue", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const prescriptionId = await makeRx({
      expirationDate: yesterday.toISOString(),
    });

    const fill = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/fills`,
      headers: technicianHeaders,
      payload: { quantity: 30 },
    });

    expect(fill.statusCode).toBe(409);
    expect(fill.json().code).toBe("RX_EXPIRED");

    const clinical = await app.inject({
      method: "GET",
      url: `/api/prescriptions/${prescriptionId}/clinical`,
      headers: technicianHeaders,
    });

    expect(clinical.statusCode).toBe(200);
    const issue = clinical
      .json()
      .issues.find((item: { code: string }) => item.code === "RX_EXPIRED");

    expect(issue).toBeTruthy();
    expect(issue.status).toBe("OPEN");
    expect(issue.severity).toBe("HIGH");

    const resolved = await app.inject({
      method: "PATCH",
      url: `/api/dur/issues/${issue.id}/resolve`,
      headers: pharmacistHeaders,
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().issue.status).toBe("RESOLVED");
  });

  it("enforces a minimum-days-between-fills rule and reports eligibility", async () => {
    const prescriptionId = await makeRx({
      minimumDaysBetweenFills: 30,
      refillsAllowed: 1,
    });

    await dispenseAndSell(prescriptionId);

    const refillReview = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "DUR_REVIEW" },
    });
    expect(refillReview.statusCode).toBe(200);

    const refill = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/fills`,
      headers: technicianHeaders,
      payload: { quantity: 30 },
    });

    expect(refill.statusCode).toBe(409);
    expect(refill.json().code).toBe("REFILL_TOO_SOON");
    expect(typeof refill.json().eligibleAt).toBe("string");
  });

  it("limits intervention documentation to pharmacist-level clinical roles", async () => {
    const prescriptionId = await makeRx();

    const technicianAttempt = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/interventions`,
      headers: technicianHeaders,
      payload: { note: "Technician should not be able to create this note." },
    });
    expect(technicianAttempt.statusCode).toBe(403);

    const pharmacistNote = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/interventions`,
      headers: pharmacistHeaders,
      payload: {
        note: "Synthetic pharmacist intervention documented for integration testing.",
      },
    });
    expect(pharmacistNote.statusCode).toBe(201);
    expect(pharmacistNote.json().intervention.author.role).toBe("PHARMACIST");

    const manualIssue = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/dur/issues`,
      headers: pharmacistHeaders,
      payload: {
        code: "SYNTHETIC_REVIEW",
        title: "Synthetic review issue",
        description: "Development-only DUR issue.",
        severity: "INFO",
      },
    });
    expect(manualIssue.statusCode).toBe(201);

    const clinical = await app.inject({
      method: "GET",
      url: `/api/prescriptions/${prescriptionId}/clinical`,
      headers: technicianHeaders,
    });
    expect(clinical.statusCode).toBe(200);
    expect(clinical.json().interventions).toHaveLength(1);
    expect(
      clinical
        .json()
        .issues.some((item: { code: string }) => item.code === "SYNTHETIC_REVIEW"),
    ).toBe(true);
  });
});
