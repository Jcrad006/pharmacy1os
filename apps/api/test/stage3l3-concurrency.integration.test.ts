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
});
