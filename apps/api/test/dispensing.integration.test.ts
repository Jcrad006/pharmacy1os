import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";

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

describe("database-backed dispensing workflow", () => {
  it("processes an original fill, blocks technician verification, records sale, and processes one refill", async () => {
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
        npi: `9${Date.now().toString().slice(-9)}`,
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
        refillsAllowed: 1,
      },
    });
    expect(prescriptionResponse.statusCode).toBe(201);
    prescriptionId = prescriptionResponse.json().prescription.id as string;

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
