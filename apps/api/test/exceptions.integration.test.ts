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

async function createRx(label: string) {
  const token = randomUUID().slice(0, 8);

  const patient = await app.inject({
    method: "POST",
    url: "/api/patients",
    headers: technicianHeaders,
    payload: {
      firstName: "Exception",
      lastName: `${label}-Patient-${token}`,
      phone: `555-${token.slice(0, 4)}`,
    },
  });
  expect(patient.statusCode).toBe(201);

  const prescriber = await app.inject({
    method: "POST",
    url: "/api/prescribers",
    headers: technicianHeaders,
    payload: {
      firstName: "Exception",
      lastName: `${label}-Prescriber-${token}`,
      npi: `6${Math.floor(Math.random() * 1_000_000_000)
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
      rxNumber: `EX-${label}-${token}`,
      medicationName: `Synthetic ${label} Drug`,
      sig: "Synthetic exception test",
      quantityWritten: 30,
      refillsAllowed: 1,
    },
  });
  expect(rx.statusCode).toBe(201);

  return {
    id: rx.json().prescription.id as string,
    patientLast: `${label}-Patient-${token}`,
    prescriberLast: `${label}-Prescriber-${token}`,
  };
}

async function getExceptionItems(kind?: string) {
  const suffix = kind ? `?kind=${kind}` : "";
  const response = await app.inject({
    method: "GET",
    url: `/api/exceptions${suffix}`,
    headers: technicianHeaders,
  });
  expect(response.statusCode).toBe(200);
  return response.json().exceptions as Array<{
    kind: string;
    prescriptionId: string;
  }>;
}

describe("derived exception queue", () => {
  it("adds and removes an On Hold exception with the underlying workflow state", async () => {
    const rx = await createRx("HOLD");

    const hold = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${rx.id}/status`,
      headers: technicianHeaders,
      payload: { status: "ON_HOLD" },
    });
    expect(hold.statusCode).toBe(200);

    let items = await getExceptionItems("ON_HOLD");
    expect(
      items.some((item) => item.prescriptionId === rx.id),
    ).toBe(true);

    const resume = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${rx.id}/status`,
      headers: technicianHeaders,
      payload: { status: "DATA_ENTRY" },
    });
    expect(resume.statusCode).toBe(200);

    items = await getExceptionItems("ON_HOLD");
    expect(
      items.some((item) => item.prescriptionId === rx.id),
    ).toBe(false);
  });

  it("removes a clinical exception when its DUR issue is resolved", async () => {
    const rx = await createRx("DUR");

    const issue = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${rx.id}/dur/issues`,
      headers: pharmacistHeaders,
      payload: {
        code: "EXCEPTION_TEST",
        title: "Synthetic exception test",
        severity: "HIGH",
      },
    });
    expect(issue.statusCode).toBe(201);
    const issueId = issue.json().issue.id as string;

    let items = await getExceptionItems("CLINICAL_ISSUE");
    expect(
      items.some((item) => item.prescriptionId === rx.id),
    ).toBe(true);

    const resolve = await app.inject({
      method: "PATCH",
      url: `/api/dur/issues/${issueId}/resolve`,
      headers: pharmacistHeaders,
      payload: {
        note: "Synthetic clinical exception reviewed and resolved.",
      },
    });
    expect(resolve.statusCode).toBe(200);

    items = await getExceptionItems("CLINICAL_ISSUE");
    expect(
      items.some((item) => item.prescriptionId === rx.id),
    ).toBe(false);
  });

  it("tracks pharmacist-review work until pharmacist verification is complete", async () => {
    const rx = await createRx("VERIFY");

    const dur = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${rx.id}/status`,
      headers: technicianHeaders,
      payload: { status: "DUR_REVIEW" },
    });
    expect(dur.statusCode).toBe(200);

    const fill = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${rx.id}/fills`,
      headers: technicianHeaders,
      payload: { quantity: 30 },
    });
    expect(fill.statusCode).toBe(201);

    const review = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${rx.id}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(review.statusCode).toBe(200);

    let items = await getExceptionItems("PHARMACIST_REVIEW");
    expect(
      items.some((item) => item.prescriptionId === rx.id),
    ).toBe(true);

    const ready = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${rx.id}/status`,
      headers: pharmacistHeaders,
      payload: { status: "READY" },
    });
    expect(ready.statusCode).toBe(200);

    items = await getExceptionItems("PHARMACIST_REVIEW");
    expect(
      items.some((item) => item.prescriptionId === rx.id),
    ).toBe(false);
  });

  it("shows future scheduled fills and supports database-backed directory searches", async () => {
    const rx = await createRx("SCHEDULED");

    const dur = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${rx.id}/status`,
      headers: technicianHeaders,
      payload: { status: "DUR_REVIEW" },
    });
    expect(dur.statusCode).toBe(200);

    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const fill = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${rx.id}/fills`,
      headers: technicianHeaders,
      payload: {
        quantity: 30,
        scheduledFor: tomorrow.toISOString(),
      },
    });
    expect(fill.statusCode).toBe(201);
    expect(fill.json().fill.status).toBe("SCHEDULED");

    const items = await getExceptionItems("SCHEDULED_FILL");
    expect(
      items.some((item) => item.prescriptionId === rx.id),
    ).toBe(true);

    const patientSearch = await app.inject({
      method: "GET",
      url: `/api/patients?query=${encodeURIComponent(rx.patientLast)}`,
      headers: technicianHeaders,
    });
    expect(patientSearch.statusCode).toBe(200);
    expect(
      patientSearch.json().patients.some(
        (patient: { lastName: string }) => patient.lastName === rx.patientLast,
      ),
    ).toBe(true);

    const prescriberSearch = await app.inject({
      method: "GET",
      url: `/api/prescribers?query=${encodeURIComponent(rx.prescriberLast)}`,
      headers: technicianHeaders,
    });
    expect(prescriberSearch.statusCode).toBe(200);
    expect(
      prescriberSearch.json().prescribers.some(
        (prescriber: { lastName: string }) =>
          prescriber.lastName === rx.prescriberLast,
      ),
    ).toBe(true);
  });

  it("validates exception kinds", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/exceptions?kind=NOT_A_KIND",
      headers: technicianHeaders,
    });
    expect(response.statusCode).toBe(400);
  });
});
