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
});
