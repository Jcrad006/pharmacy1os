import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";
const app = buildApp();
const staff = { "x-dev-user": "dev-technician" };

beforeAll(async () => { await app.ready(); });
afterAll(async () => { await app.close(); await db.$disconnect(); });

describe("Stage 3L.3 adversarial workflow concurrency", () => {
  it("does not apply concurrent identical state changes twice", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/prescriptions",
      headers: staff,
      payload: {
        patientId: "patient-demo-001",
        prescriberId: "prescriber-demo-001",
        medicationId: "medication-demo-lisinopril-10",
        rxNumber: "CONCURRENT-" + randomUUID(),
        sig: "Take 1 tablet by mouth daily",
        quantityWritten: 30,
        refillsAllowed: 1,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().prescription.id as string;

    // Both requests target the same existing prescription; exactly one may win.
    const results = await Promise.all(Array.from({ length: 2 }, () =>
      app.inject({
        method: "PATCH",
        url: `/api/prescriptions/${id}/status`,
        headers: staff,
        payload: { status: "DUR_REVIEW" },
      }),
    ));
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const updated = await db.prescription.findUniqueOrThrow({
      where: { id },
      select: { status: true, version: true },
    });
    expect(updated.status).toBe("DUR_REVIEW");
    expect(updated.version).toBe(1);

    const auditCount = await db.auditEvent.count({
      where: { entityType: "Prescription", entityId: id, action: "PRESCRIPTION_STATUS_CHANGED" },
    });
    expect(auditCount).toBe(1);
  });
  it("serializes simultaneous attempts to create the same authorized fill number", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/prescriptions", headers: staff,
      payload: {
        patientId: "patient-demo-001", prescriberId: "prescriber-demo-001",
        medicationId: "medication-demo-lisinopril-10",
        rxNumber: "FILL-RACE-" + randomUUID(),
        sig: "Take once daily", quantityWritten: 30, refillsAllowed: 2,
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().prescription.id as string;
    const reviewed = await app.inject({
      method: "PATCH", url: `/api/prescriptions/${id}/status`,
      headers: staff, payload: { status: "DUR_REVIEW" },
    });
    expect(reviewed.statusCode).toBe(200);

    const responses = await Promise.all(Array.from({ length: 3 }, () => app.inject({
      method: "POST", url: `/api/prescriptions/${id}/fills`,
      headers: staff, payload: { quantity: 30, daysSupply: 30 },
    })));
    expect(responses.filter(x => x.statusCode === 201)).toHaveLength(1);
    expect(responses.filter(x => x.statusCode === 409)).toHaveLength(2);
    const fills = await db.prescriptionFill.findMany({ where: { prescriptionId: id } });
    expect(fills).toHaveLength(1);
    expect(fills[0]?.fillNumber).toBe(0);
    expect(fills[0]?.partNumber).toBe(1);
    expect((await db.prescription.findUniqueOrThrow({ where: { id } })).status).toBe("PRODUCT_FILL");
    expect(await db.auditEvent.count({
      where: { entityType: "PrescriptionFill", action: "PRESCRIPTION_FILL_CREATED", entityId: fills[0]!.id },
    })).toBe(1);
  });

});
