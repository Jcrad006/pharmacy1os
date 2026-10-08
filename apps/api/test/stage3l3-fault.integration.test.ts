import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { receiveInventory } from "../src/inventory.js";

process.env.ALLOW_DEV_IDENTITY = "true";
const app = buildApp();
const staff = { "x-dev-user": "dev-technician" };

beforeAll(async () => { await app.ready(); });
afterAll(async () => { await app.close(); await db.$disconnect(); });

describe("Stage 3L.3 injected failures and duplicate request protection", () => {
  it("rolls back balance and ledger atomically when a receipt transaction is interrupted", async () => {
    const balanceId = "inventory-demo-lisinopril-a1";
    const actor = await db.user.findFirstOrThrow({
      where: { siteId: "site-demo-001", externalAuthId: "dev-technician" },
    });
    const before = await db.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const tag = "FAULT-" + randomUUID();
    const beforeLedger = await db.inventoryTransaction.count({ where: { reference: tag } });

    await expect(db.$transaction(async (tx) => {
      await receiveInventory(tx, {
        siteId: "site-demo-001", actorId: actor.id,
        productId: "product-demo-lisinopril-a",
        productLotId: "lot-demo-lisinopril-a1",
        productExpirationId: "expiration-demo-lisinopril-a1",
        quantity: 9, source: "3L3_FAULT_INJECTION", reference: tag,
      });
      throw new Error("SIMULATED_WRITE_INTERRUPTION");
    })).rejects.toThrow("SIMULATED_WRITE_INTERRUPTION");

    const after = await db.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    expect(after.onHandQuantity.toString()).toBe(before.onHandQuantity.toString());
    expect(after.reservedQuantity.toString()).toBe(before.reservedQuantity.toString());
    expect(await db.inventoryTransaction.count({ where: { reference: tag } })).toBe(beforeLedger);
  });

  it("same idempotency key under simultaneous receiving requests produces one inventory movement", async () => {
    const balanceId = "inventory-demo-lisinopril-a1";
    const before = await db.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    const key = "3l3-receive-" + randomUUID();
    const payload = {
      rawBarcode: "(01)00999990001015(17)270630(10)LIS-A1001",
      quantity: 9,
      source: "Stage3L3 concurrent synthetic receipt",
      reference: key,
      idempotencyKey: key,
    };
    const replies = await Promise.all([0, 1].map(() => app.inject({
      method: "POST", url: "/api/receiving/stock", headers: staff, payload,
    })));
    // A replay may respond 200/201 or conflict, but never create a second receipt.
    expect(replies.some((response) => response.statusCode === 201)).toBe(true);
    const after = await db.inventoryBalance.findUniqueOrThrow({ where: { id: balanceId } });
    expect(after.onHandQuantity.sub(before.onHandQuantity).toNumber()).toBe(9);
    expect(await db.inventoryTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
  });
  it("concurrent duplicate scans cannot reserve more than the requested dispense quantity", async () => {
    const rx = await app.inject({
      method: "POST", url: "/api/prescriptions", headers: staff,
      payload: {
        patientId: "patient-demo-001", prescriberId: "prescriber-demo-001",
        medicationId: "medication-demo-lisinopril-10",
        rxNumber: "3L3-SCAN-" + randomUUID(),
        sig: "Once daily", quantityWritten: 3, refillsAllowed: 0,
      },
    });
    expect(rx.statusCode).toBe(201);
    const prescriptionId = rx.json().prescription.id as string;
    const reviewed = await app.inject({
      method: "PATCH", url: `/api/prescriptions/${prescriptionId}/status`,
      headers: staff, payload: { status: "DUR_REVIEW" },
    });
    expect(reviewed.statusCode).toBe(200);
    const fillCreated = await app.inject({
      method: "POST", url: `/api/prescriptions/${prescriptionId}/fills`,
      headers: staff, payload: { quantity: 3, daysSupply: 3 },
    });
    expect(fillCreated.statusCode).toBe(201);
    const fillId = fillCreated.json().fill.id as string;
    const payload = { rawBarcode: "(01)00999990001015(17)270630(10)LIS-A1001" };
    const before = await db.inventoryBalance.findUniqueOrThrow({ where: { id: "inventory-demo-lisinopril-a1" } });
    const replies = await Promise.all([0, 1].map(() => app.inject({
      method: "POST", url: `/api/fills/${fillId}/scan-barcode`, headers: staff, payload,
    })));
    expect(replies.some((reply) => reply.statusCode === 200)).toBe(true);
    const after = await db.inventoryBalance.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.reservedQuantity.sub(before.reservedQuantity).toNumber()).toBe(3);
    const allocations = await db.inventoryAllocation.findMany({ where: { fillId, status: "ACTIVE" } });
    expect(allocations).toHaveLength(1);
    expect(allocations[0]?.quantity.toNumber()).toBe(3);
    expect(await db.fillProductSource.count({ where: { fillId } })).toBe(1);
  });

  it("concurrent identical POS requests never create a second sale or receipt", async () => {
    const rx = await app.inject({
      method: "POST", url: "/api/prescriptions", headers: staff,
      payload: {
        patientId: "patient-demo-001", prescriberId: "prescriber-demo-001",
        medicationId: "medication-demo-lisinopril-10",
        rxNumber: "3L3-POS-" + randomUUID(),
        sig: "Once daily", quantityWritten: 2, refillsAllowed: 0,
      },
    });
    expect(rx.statusCode).toBe(201);
    const id = rx.json().prescription.id as string;
    expect((await app.inject({ method: "PATCH", url: `/api/prescriptions/${id}/status`, headers: staff, payload: { status: "DUR_REVIEW" } })).statusCode).toBe(200);
    const fill = await app.inject({ method: "POST", url: `/api/prescriptions/${id}/fills`, headers: staff, payload: { quantity: 2, daysSupply: 2 } });
    expect(fill.statusCode).toBe(201);
    const fillId = fill.json().fill.id as string;
    const scan = await app.inject({ method: "POST", url: `/api/fills/${fillId}/scan-barcode`, headers: staff, payload: { rawBarcode: "(01)00999990001015(17)270630(10)LIS-A1001" } });
    expect(scan.statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/prescriptions/${id}/status`, headers: staff, payload: { status: "PHARMACIST_REVIEW" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `/api/prescriptions/${id}/status`, headers: { "x-dev-user": "dev-pharmacist" }, payload: { status: "READY" } })).statusCode).toBe(200);
    const bagBarcode = "3L3-POS-BAG-" + randomUUID();
    const stage = await app.inject({ method: "POST", url: `/api/fills/${fillId}/will-call/stage`, headers: staff, payload: { bagBarcode } });
    expect(stage.statusCode).toBe(200);
    const quote = await app.inject({ method: "POST", url: "/api/pos/quote", headers: staff, payload: { fillIds: [fillId] } });
    expect(quote.statusCode).toBe(200);
    const due = Number(quote.json().quote.totalDue);
    const key = "3l3-pos-" + randomUUID();
    const payload = {
      fillIds: [fillId],
      tenders: [{ method: "CASH", amount: due }],
      pickupPackages: [{ fillId, bagBarcode }],
      pickup: {
        recipientName: "Synthetic Concurrent Pickup", relationship: "Self",
        identityMethod: "DATE_OF_BIRTH", identityValue: "1978-04-12",
        signatureMethod: "ELECTRONIC_TYPED", signatureName: "Synthetic Concurrent Pickup",
      },
      idempotencyKey: key,
    };
    const results = await Promise.all([0, 1].map(() => app.inject({
      method: "POST", url: "/api/pos/checkout", headers: staff, payload,
    })));
    expect(results.some(r => r.statusCode === 200)).toBe(true);
    expect(await db.pointOfSaleLine.count({ where: { fillId } })).toBe(1);
    expect(await db.pointOfSaleTransaction.count({ where: { idempotencyKey: key } })).toBe(1);
    expect((await db.prescription.findUniqueOrThrow({ where: { id } })).status).toBe("SOLD");
  });

});
