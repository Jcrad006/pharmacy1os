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

async function createLisinoprilFill(quantity: number, suffix: string) {
  const created = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId: "patient-demo-001",
      prescriberId: "prescriber-demo-001",
      medicationId: "medication-demo-lisinopril-10",
      rxNumber: `HOLD-${suffix}`,
      sig: "Take 1 tablet by mouth once daily",
      quantityWritten: quantity,
      refillsAllowed: 0,
    },
  });
  expect(created.statusCode).toBe(201);

  const prescriptionId = created.json().prescription.id as string;

  const dur = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: technicianHeaders,
    payload: { status: "DUR_REVIEW" },
  });
  expect(dur.statusCode).toBe(200);

  const fill = await app.inject({
    method: "POST",
    url: `/api/prescriptions/${prescriptionId}/fills`,
    headers: technicianHeaders,
    payload: { quantity },
  });
  expect(fill.statusCode).toBe(201);

  return {
    prescriptionId,
    fillId: fill.json().fill.id as string,
  };
}

function gs1WithCheckDigit(body: string) {
  if (!/^\d{13}$/.test(body)) {
    throw new Error("GTIN-14 body must contain exactly 13 digits.");
  }
  const digits = body.split("").map(Number);
  let sum = 0;
  let multiplyByThree = true;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += digits[index]! * (multiplyByThree ? 3 : 1);
    multiplyByThree = !multiplyByThree;
  }
  return body + String((10 - (sum % 10)) % 10);
}

describe("Phase 3H quarantine and disposition", () => {
  it("removes quarantined stock from availability and restricts resolution to pharmacists", async () => {
    const suffix = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    const gtin = gs1WithCheckDigit(`0044444${suffix}`);
    const lotNumber = `HOLD-${suffix}`;
    const rawBarcode = `(01)${gtin}(17)291231(10)${lotNumber}`;

    const assigned = await app.inject({
      method: "POST",
      url: "/api/receiving/assign",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        productId: "product-demo-lisinopril-a",
        isPrimary: false,
      },
    });
    expect(assigned.statusCode).toBe(201);

    const received = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        quantity: 100,
        source: "Quarantine integration test",
      },
    });
    expect(received.statusCode).toBe(201);

    const balanceId = received.json().balance.id as string;

    const quarantine = await app.inject({
      method: "POST",
      url: `/api/inventory/balances/${balanceId}/quarantine`,
      headers: technicianHeaders,
      payload: {
        quantity: 30,
        reasonCode: "DAMAGED",
        note: "Bottle damaged during receiving.",
      },
    });
    expect(quarantine.statusCode).toBe(201);
    expect(quarantine.json().hold.status).toBe("ACTIVE");
    expect(Number(quarantine.json().balance.onHandQuantity)).toBe(100);
    expect(Number(quarantine.json().balance.quarantinedQuantity)).toBe(30);
    expect(Number(quarantine.json().balance.availableQuantity)).toBe(70);

    const firstHoldId = quarantine.json().hold.id as string;

    const tooMuchQuarantine = await app.inject({
      method: "POST",
      url: `/api/inventory/balances/${balanceId}/quarantine`,
      headers: technicianHeaders,
      payload: {
        quantity: 71,
        reasonCode: "SUSPECT_PRODUCT",
      },
    });
    expect(tooMuchQuarantine.statusCode).toBe(409);
    expect(tooMuchQuarantine.json().code).toBe(
      "INSUFFICIENT_AVAILABLE_INVENTORY",
    );

    const fill = await createLisinoprilFill(80, suffix);
    const blockedFill = await app.inject({
      method: "POST",
      url: `/api/fills/${fill.fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(blockedFill.statusCode).toBe(409);
    expect(blockedFill.json().code).toBe("INSUFFICIENT_INVENTORY");
    expect(Number(blockedFill.json().details.availableQuantity)).toBe(70);

    const technicianRelease = await app.inject({
      method: "POST",
      url: `/api/inventory/holds/${firstHoldId}/release`,
      headers: technicianHeaders,
      payload: {
        resolutionNote: "Technician should not be able to release this hold.",
      },
    });
    expect(technicianRelease.statusCode).toBe(403);

    const released = await app.inject({
      method: "POST",
      url: `/api/inventory/holds/${firstHoldId}/release`,
      headers: pharmacistHeaders,
      payload: {
        resolutionNote:
          "Package inspected by pharmacist; contents intact and usable.",
      },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().hold.status).toBe("RELEASED");
    expect(Number(released.json().balance.quarantinedQuantity)).toBe(0);
    expect(Number(released.json().balance.availableQuantity)).toBe(100);

    const secondHold = await app.inject({
      method: "POST",
      url: `/api/inventory/balances/${balanceId}/quarantine`,
      headers: technicianHeaders,
      payload: {
        quantity: 25,
        reasonCode: "EXPIRED",
        note: "Segregated for reverse distribution.",
      },
    });
    expect(secondHold.statusCode).toBe(201);
    const secondHoldId = secondHold.json().hold.id as string;

    const unsafeAdjustment = await app.inject({
      method: "POST",
      url: `/api/inventory/balances/${balanceId}/adjust`,
      headers: pharmacistHeaders,
      payload: {
        delta: -80,
        reason: "Would reduce on-hand below quarantined stock.",
      },
    });
    expect(unsafeAdjustment.statusCode).toBe(409);
    expect(unsafeAdjustment.json().code).toBe("INVENTORY_ADJUSTMENT_CONFLICT");

    const technicianDispose = await app.inject({
      method: "POST",
      url: `/api/inventory/holds/${secondHoldId}/dispose`,
      headers: technicianHeaders,
      payload: {
        dispositionType: "REVERSE_DISTRIBUTOR",
        resolutionNote: "Technician should not be able to dispose stock.",
      },
    });
    expect(technicianDispose.statusCode).toBe(403);

    const disposed = await app.inject({
      method: "POST",
      url: `/api/inventory/holds/${secondHoldId}/dispose`,
      headers: pharmacistHeaders,
      payload: {
        dispositionType: "REVERSE_DISTRIBUTOR",
        resolutionNote:
          "Expired stock packaged for licensed reverse distributor.",
      },
    });
    expect(disposed.statusCode).toBe(200);
    expect(disposed.json().hold.status).toBe("DISPOSED");
    expect(disposed.json().hold.dispositionType).toBe("REVERSE_DISTRIBUTOR");
    expect(Number(disposed.json().balance.onHandQuantity)).toBe(75);
    expect(Number(disposed.json().balance.quarantinedQuantity)).toBe(0);
    expect(Number(disposed.json().balance.availableQuantity)).toBe(75);

    const dispositionTransaction = await db.inventoryTransaction.findFirst({
      where: {
        inventoryHoldId: secondHoldId,
        type: "DISPOSE",
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(dispositionTransaction).toBeTruthy();
    expect(dispositionTransaction?.onHandDelta.toNumber()).toBe(-25);
    expect(dispositionTransaction?.quarantinedDelta.toNumber()).toBe(-25);

    const holdsResponse = await app.inject({
      method: "GET",
      url: "/api/inventory/holds",
      headers: pharmacistHeaders,
    });
    expect(holdsResponse.statusCode).toBe(200);

    const returnedHolds = holdsResponse.json().holds as Array<{
      id: string;
      status: string;
    }>;
    expect(
      returnedHolds.some(
        (hold) => hold.id === firstHoldId && hold.status === "RELEASED",
      ),
    ).toBe(true);
    expect(
      returnedHolds.some(
        (hold) => hold.id === secondHoldId && hold.status === "DISPOSED",
      ),
    ).toBe(true);

    const auditEvents = await db.auditEvent.findMany({
      where: {
        entityType: "InventoryHold",
        entityId: { in: [firstHoldId, secondHoldId] },
      },
      orderBy: { occurredAt: "asc" },
    });
    const actions = auditEvents.map((event) => event.action);
    expect(actions).toContain("INVENTORY_QUARANTINED");
    expect(actions).toContain("INVENTORY_QUARANTINE_RELEASED");
    expect(actions).toContain("INVENTORY_QUARANTINE_DISPOSED");
  });
});
