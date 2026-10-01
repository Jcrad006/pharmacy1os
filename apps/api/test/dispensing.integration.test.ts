import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";
process.env.ALLOW_LEGACY_DIRECT_SALE = "true";

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };
const pharmacistHeaders = { "x-dev-user": "dev-pharmacist" };

let prescriptionId = "";

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

async function createSyntheticPrescription(options?: { refillsAllowed?: number }) {
  const suffix = randomUUID().slice(0, 8);

  const patientResponse = await app.inject({
    method: "POST",
    url: "/api/patients",
    headers: technicianHeaders,
    payload: {
      firstName: "Integration",
      lastName: `Patient-${suffix}`,
      dateOfBirth: "1980-01-02T00:00:00.000Z",
      phone: "555-0300",
    },
  });
  expect(patientResponse.statusCode).toBe(201);
  const patientId = patientResponse.json().patient.id as string;

  const prescriberResponse = await app.inject({
    method: "POST",
    url: "/api/prescribers",
    headers: technicianHeaders,
    payload: {
      firstName: "Integration",
      lastName: `Prescriber-${suffix}`,
      npi: `9${Math.floor(Math.random() * 1_000_000_000)
        .toString()
        .padStart(9, "0")}`,
    },
  });
  expect(prescriberResponse.statusCode).toBe(201);
  const prescriberId = prescriberResponse.json().prescriber.id as string;

  const prescriptionResponse = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId,
      prescriberId,
      rxNumber: `E2E-${suffix}`,
      medicationName: "Synthetic Test Drug",
      strength: "10 mg",
      dosageForm: "tablet",
      sig: "Take 1 tablet by mouth once daily",
      quantityWritten: 30,
      refillsAllowed: options?.refillsAllowed ?? 1,
    },
  });
  expect(prescriptionResponse.statusCode).toBe(201);

  return {
    prescriptionId: prescriptionResponse.json().prescription.id as string,
    patientId,
    prescriberId,
  };
}

async function moveToReady(id: string) {
  const dur = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${id}/status`,
    headers: technicianHeaders,
    payload: { status: "DUR_REVIEW" },
  });
  expect(dur.statusCode).toBe(200);

  const fill = await app.inject({
    method: "POST",
    url: `/api/prescriptions/${id}/fills`,
    headers: technicianHeaders,
    payload: { quantity: 30 },
  });
  expect(fill.statusCode).toBe(201);

  const review = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${id}/status`,
    headers: technicianHeaders,
    payload: { status: "PHARMACIST_REVIEW" },
  });
  expect(review.statusCode).toBe(200);

  const ready = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${id}/status`,
    headers: pharmacistHeaders,
    payload: { status: "READY" },
  });
  expect(ready.statusCode).toBe(200);

  return ready.json().prescription;
}

describe("database-backed dispensing workflow", () => {
  it("processes an original fill, blocks technician verification, records sale, and processes one refill", async () => {
    const created = await createSyntheticPrescription({ refillsAllowed: 1 });
    prescriptionId = created.prescriptionId;

    const hold = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "ON_HOLD" },
    });
    expect(hold.statusCode).toBe(200);
    expect(hold.json().prescription.heldFromStatus).toBe("DATA_ENTRY");

    const resume = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "DATA_ENTRY" },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().prescription.heldFromStatus).toBeNull();

    const dur = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "DUR_REVIEW" },
    });
    expect(dur.statusCode).toBe(200);

    const originalFill = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/fills`,
      headers: technicianHeaders,
      payload: { quantity: 30 },
    });
    expect(originalFill.statusCode).toBe(201);
    expect(originalFill.json().fill.fillNumber).toBe(0);
    expect(originalFill.json().prescription.status).toBe("PRODUCT_FILL");

    const review = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(review.statusCode).toBe(200);

    const technicianVerify = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "READY" },
    });
    expect(technicianVerify.statusCode).toBe(403);

    const pharmacistVerify = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: pharmacistHeaders,
      payload: { status: "READY" },
    });
    expect(pharmacistVerify.statusCode).toBe(200);
    expect(pharmacistVerify.json().prescription.fills[0].status).toBe("READY");

    const sold = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "SOLD" },
    });
    expect(sold.statusCode).toBe(200);
    expect(sold.json().prescription.refillsUsed).toBe(0);
    expect(sold.json().prescription.fills[0].status).toBe("SOLD");

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
    expect(refill.statusCode).toBe(201);
    expect(refill.json().fill.fillNumber).toBe(1);

    const refillToReview = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(refillToReview.statusCode).toBe(200);

    const refillReady = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: pharmacistHeaders,
      payload: { status: "READY" },
    });
    expect(refillReady.statusCode).toBe(200);

    const refillSold = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "SOLD" },
    });
    expect(refillSold.statusCode).toBe(200);
    expect(refillSold.json().prescription.refillsUsed).toBe(1);

    const noRefills = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "DUR_REVIEW" },
    });
    expect(noRefills.statusCode).toBe(409);
  });

  it("audits prescription edits and resets a DUR-reviewed prescription to data entry", async () => {
    const created = await createSyntheticPrescription({ refillsAllowed: 2 });

    const dur = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${created.prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "DUR_REVIEW" },
    });
    expect(dur.statusCode).toBe(200);

    const edit = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${created.prescriptionId}`,
      headers: technicianHeaders,
      payload: {
        strength: "20 mg",
        sig: "Take 2 tablets by mouth once daily",
        quantityWritten: 60,
      },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().prescription.strength).toBe("20 mg");
    expect(edit.json().prescription.status).toBe("DATA_ENTRY");

    const audit = await app.inject({
      method: "GET",
      url: `/api/prescriptions/${created.prescriptionId}/audit`,
      headers: pharmacistHeaders,
    });
    expect(audit.statusCode).toBe(200);

    const edited = audit
      .json()
      .events.find((event: { action: string }) => event.action === "PRESCRIPTION_EDITED");

    expect(edited).toBeTruthy();
    expect(edited.metadata.changes.strength).toEqual({
      before: "10 mg",
      after: "20 mg",
    });
    expect(edited.metadata.workflowReset).toEqual({
      from: "DUR_REVIEW",
      to: "DATA_ENTRY",
    });
  });

  it("returns a Ready fill to stock without consuming a refill and reuses the same fill number", async () => {
    const created = await createSyntheticPrescription({ refillsAllowed: 1 });
    const ready = await moveToReady(created.prescriptionId);
    const readyFillId = ready.fills[0].id as string;

    const willCallBefore = await app.inject({
      method: "GET",
      url: "/api/prescriptions/will-call",
      headers: technicianHeaders,
    });
    expect(willCallBefore.statusCode).toBe(200);
    expect(
      willCallBefore
        .json()
        .prescriptions.some(
          (rx: { id: string }) => rx.id === created.prescriptionId,
        ),
    ).toBe(true);

    const returned = await app.inject({
      method: "POST",
      url: `/api/fills/${readyFillId}/return-to-stock`,
      headers: technicianHeaders,
    });
    expect(returned.statusCode).toBe(200);
    expect(returned.json().fill.status).toBe("RETURNED_TO_STOCK");
    expect(returned.json().prescription.status).toBe("DUR_REVIEW");
    expect(returned.json().prescription.refillsUsed).toBe(0);

    const willCallAfter = await app.inject({
      method: "GET",
      url: "/api/prescriptions/will-call",
      headers: technicianHeaders,
    });
    expect(
      willCallAfter
        .json()
        .prescriptions.some(
          (rx: { id: string }) => rx.id === created.prescriptionId,
        ),
    ).toBe(false);

    const reprocessed = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${created.prescriptionId}/fills`,
      headers: technicianHeaders,
      payload: { quantity: 30 },
    });
    expect(reprocessed.statusCode).toBe(201);
    expect(reprocessed.json().fill.id).toBe(readyFillId);
    expect(reprocessed.json().fill.fillNumber).toBe(0);
    expect(reprocessed.json().fill.status).toBe("IN_PROGRESS");
    expect(reprocessed.json().prescription.status).toBe("PRODUCT_FILL");
  });

  it("returns an audit history containing the dispensing events", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/prescriptions/${prescriptionId}/audit`,
      headers: pharmacistHeaders,
    });

    expect(response.statusCode).toBe(200);
    const actions = response.json().events.map(
      (event: { action: string }) => event.action,
    );

    expect(actions).toContain("PRESCRIPTION_CREATED");
    expect(actions).toContain("PRESCRIPTION_FILL_CREATED");
    expect(actions).toContain("PRESCRIPTION_STATUS_CHANGED");
  });
});
