import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";

const app = buildApp();
const primaryTech = { "x-dev-user": "dev-technician" };
const primaryPharmacist = { "x-dev-user": "dev-pharmacist" };
const northTech = { "x-dev-user": "dev-technician-002" };

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe("Phase 3H site inventory transfers", () => {
  it("ships, receives, and cancels inventory with source/destination ledger entries", async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
    const gtin = `0033333${suffix}0`;
    const lotNumber = `XFER-${suffix}`;
    const rawBarcode = `(01)${gtin}(17)291231(10)${lotNumber}`;

    const assigned = await app.inject({
      method: "POST",
      url: "/api/receiving/assign",
      headers: primaryTech,
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
      headers: primaryTech,
      payload: {
        rawBarcode,
        quantity: 60,
        source: "Transfer integration test",
      },
    });
    expect(received.statusCode).toBe(201);

    const sourceBalanceId = received.json().balance.id as string;

    const technicianShip = await app.inject({
      method: "POST",
      url: "/api/inventory/transfers",
      headers: primaryTech,
      payload: {
        destinationSiteId: "site-demo-002",
        sourceInventoryBalanceId: sourceBalanceId,
        quantity: 20,
      },
    });
    expect(technicianShip.statusCode).toBe(403);

    const shipped = await app.inject({
      method: "POST",
      url: "/api/inventory/transfers",
      headers: primaryPharmacist,
      payload: {
        destinationSiteId: "site-demo-002",
        sourceInventoryBalanceId: sourceBalanceId,
        quantity: 20,
        note: "Rebalance stock between demo pharmacies.",
      },
    });
    expect(shipped.statusCode).toBe(201);
    expect(shipped.json().transfer.status).toBe("IN_TRANSIT");
    const transferId = shipped.json().transfer.id as string;

    let sourceBalance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: sourceBalanceId },
    });
    expect(sourceBalance.onHandQuantity.toNumber()).toBe(40);

    const wrongSiteReceive = await app.inject({
      method: "POST",
      url: `/api/inventory/transfers/${transferId}/receive`,
      headers: primaryTech,
    });
    expect(wrongSiteReceive.statusCode).toBe(404);

    const destinationReceive = await app.inject({
      method: "POST",
      url: `/api/inventory/transfers/${transferId}/receive`,
      headers: northTech,
    });
    expect(destinationReceive.statusCode).toBe(200);
    expect(destinationReceive.json().transfer.status).toBe("RECEIVED");

    const completed = await db.inventoryTransfer.findUniqueOrThrow({
      where: { id: transferId },
    });
    expect(completed.destinationInventoryBalanceId).toBeTruthy();

    const destinationBalance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: completed.destinationInventoryBalanceId! },
    });
    expect(destinationBalance.siteId).toBe("site-demo-002");
    expect(destinationBalance.onHandQuantity.toNumber()).toBe(20);

    const transferTransactions = await db.inventoryTransaction.findMany({
      where: { inventoryTransferId: transferId },
      orderBy: { occurredAt: "asc" },
    });
    expect(transferTransactions.map((item) => item.type)).toEqual([
      "TRANSFER_OUT",
      "TRANSFER_IN",
    ]);
    expect(transferTransactions[0]?.onHandDelta.toNumber()).toBe(-20);
    expect(transferTransactions[1]?.onHandDelta.toNumber()).toBe(20);

    const second = await app.inject({
      method: "POST",
      url: "/api/inventory/transfers",
      headers: primaryPharmacist,
      payload: {
        destinationSiteId: "site-demo-002",
        sourceInventoryBalanceId: sourceBalanceId,
        quantity: 5,
      },
    });
    expect(second.statusCode).toBe(201);
    const secondId = second.json().transfer.id as string;

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/inventory/transfers/${secondId}/cancel`,
      headers: primaryPharmacist,
      payload: {
        reason: "Shipment cancelled before courier pickup.",
      },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().transfer.status).toBe("CANCELLED");

    sourceBalance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: sourceBalanceId },
    });
    expect(sourceBalance.onHandQuantity.toNumber()).toBe(40);

    const cancellation = await db.inventoryTransaction.findFirst({
      where: {
        inventoryTransferId: secondId,
        type: "TRANSFER_CANCEL_RETURN",
      },
    });
    expect(cancellation?.onHandDelta.toNumber()).toBe(5);
  });
});
