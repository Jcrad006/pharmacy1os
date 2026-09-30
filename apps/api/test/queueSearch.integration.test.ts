import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe("server-backed prescription queue search", () => {
  it("searches Rx, medication, patient, and prescriber and combines search with status", async () => {
    const token = randomUUID().slice(0, 8);
    const patientLast = `QueuePatient-${token}`;
    const prescriberLast = `QueuePrescriber-${token}`;
    const medication = `QueueDrug-${token}`;
    const rxNumber = `QUEUE-${token}`;

    const patient = await app.inject({
      method: "POST",
      url: "/api/patients",
      headers: technicianHeaders,
      payload: {
        firstName: "Search",
        lastName: patientLast,
      },
    });
    expect(patient.statusCode).toBe(201);

    const prescriber = await app.inject({
      method: "POST",
      url: "/api/prescribers",
      headers: technicianHeaders,
      payload: {
        firstName: "Search",
        lastName: prescriberLast,
        npi: `7${Math.floor(Math.random() * 1_000_000_000)
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
        rxNumber,
        medicationName: medication,
        strength: "5 mg",
        dosageForm: "tablet",
        sig: "Synthetic queue search test",
        quantityWritten: 30,
        refillsAllowed: 0,
      },
    });
    expect(rx.statusCode).toBe(201);
    const id = rx.json().prescription.id as string;

    for (const query of [rxNumber, medication, patientLast, prescriberLast]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/prescriptions/queue?query=${encodeURIComponent(query)}`,
        headers: technicianHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(
        response.json().prescriptions.some(
          (item: { id: string }) => item.id === id,
        ),
      ).toBe(true);
    }

    const matchingStatus = await app.inject({
      method: "GET",
      url: `/api/prescriptions/queue?query=${encodeURIComponent(token)}&status=DATA_ENTRY`,
      headers: technicianHeaders,
    });
    expect(matchingStatus.statusCode).toBe(200);
    expect(
      matchingStatus.json().prescriptions.some(
        (item: { id: string }) => item.id === id,
      ),
    ).toBe(true);

    const wrongStatus = await app.inject({
      method: "GET",
      url: `/api/prescriptions/queue?query=${encodeURIComponent(token)}&status=READY`,
      headers: technicianHeaders,
    });
    expect(wrongStatus.statusCode).toBe(200);
    expect(
      wrongStatus.json().prescriptions.some(
        (item: { id: string }) => item.id === id,
      ),
    ).toBe(false);
  });

  it("validates queue status and caps the requested limit", async () => {
    const invalid = await app.inject({
      method: "GET",
      url: "/api/prescriptions/queue?status=NOT_A_STATUS",
      headers: technicianHeaders,
    });
    expect(invalid.statusCode).toBe(400);

    const capped = await app.inject({
      method: "GET",
      url: "/api/prescriptions/queue?limit=9999&sort=newest",
      headers: technicianHeaders,
    });
    expect(capped.statusCode).toBe(200);
    expect(capped.json().meta.limit).toBe(200);
    expect(capped.json().meta.sort).toBe("newest");
  });
});
