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

async function createLisinoprilFill(quantity: number, suffix: string) {
  const created = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId: "patient-demo-001",
      prescriberId: "prescriber-demo-001",
      medicationId: "medication-demo-lisinopril-10",
      rxNumber: `INV-${suffix}-${randomUUID().slice(0, 5)}`,
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

describe("Phase 3H inventory ledger", () => {
  it("receives, reserves, dispenses, returns, and adjusts isolated stock", async () => {
    const suffix = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    const gtin = `0066666${suffix}0`;
    const lotNumber = `INV-${suffix}`;
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

    const idempotencyKey = `receipt-${randomUUID()}`;
    const received = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        quantity: 40,
        source: "Test Wholesaler",
        reference: `INV-${suffix}`,
        unitCost: 0.125,
        idempotencyKey,
      },
    });
    expect(received.statusCode).toBe(201);
    expect(received.json().status).toBe("RECEIVED");
    expect(Number(received.json().balance.onHandQuantity)).toBe(40);
    expect(Number(received.json().balance.availableQuantity)).toBe(40);

    const balanceId = received.json().balance.id as string;

    const replay = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        quantity: 40,
        source: "Test Wholesaler",
        reference: `INV-${suffix}`,
        unitCost: 0.125,
        idempotencyKey,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().status).toBe("REPLAYED");
    expect(Number(replay.json().balance.onHandQuantity)).toBe(40);

    const receivingLocation = await db.inventoryLocation.findFirstOrThrow({
      where: {
        siteId: "site-demo-001",
        isDefaultReceiving: true,
      },
    });
    const initialPosition = await db.inventoryStockPosition.findFirstOrThrow({
      where: {
        inventoryBalanceId: balanceId,
        locationId: receivingLocation.id,
        state: "AVAILABLE",
      },
    });
    expect(initialPosition.quantity.toNumber()).toBe(40);

    const binCode = `BIN-${suffix}`;
    const createdLocation = await app.inject({
      method: "POST",
      url: "/api/inventory/locations",
      headers: pharmacistHeaders,
      payload: {
        code: binCode,
        name: `Test Bin ${suffix}`,
        type: "BIN",
      },
    });
    expect(createdLocation.statusCode).toBe(201);
    const binId = createdLocation.json().location.id as string;

    const moved = await app.inject({
      method: "POST",
      url: "/api/inventory/locations/move",
      headers: technicianHeaders,
      payload: {
        inventoryBalanceId: balanceId,
        fromLocationId: receivingLocation.id,
        toLocationId: binId,
        state: "AVAILABLE",
        quantity: 5,
        reason: "Move stock to dispensing bin.",
      },
    });
    expect(moved.statusCode).toBe(200);

    const positionsAfterMove = await db.inventoryStockPosition.findMany({
      where: { inventoryBalanceId: balanceId },
    });
    expect(
      positionsAfterMove.reduce(
        (sum, position) => sum + position.quantity.toNumber(),
        0,
      ),
    ).toBe(40);

    const projection = await app.inject({
      method: "GET",
      url: `/api/inventory/balances/${balanceId}/as-of`,
      headers: pharmacistHeaders,
    });
    expect(projection.statusCode).toBe(200);
    expect(Number(projection.json().onHandQuantity)).toBe(40);
    expect(Number(projection.json().recordedAcquisitionCost)).toBe(5);

    const first = await createLisinoprilFill(30, suffix);
    const reserved = await app.inject({
      method: "POST",
      url: `/api/fills/${first.fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(reserved.statusCode).toBe(200);

    const activeAllocation = await db.inventoryAllocation.findFirst({
      where: { fillId: first.fillId, status: "ACTIVE" },
    });
    expect(activeAllocation?.quantity.toNumber()).toBe(30);

    let balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(40);
    expect(balance.reservedQuantity.toNumber()).toBe(30);

    const second = await createLisinoprilFill(20, suffix);
    const insufficient = await app.inject({
      method: "POST",
      url: `/api/fills/${second.fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(insufficient.statusCode).toBe(409);
    expect(insufficient.json().code).toBe("INSUFFICIENT_INVENTORY");
    expect(Number(insufficient.json().details.availableQuantity)).toBe(10);

    const toReview = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${first.prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(toReview.statusCode).toBe(200);

    const ready = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${first.prescriptionId}/status`,
      headers: pharmacistHeaders,
      payload: { status: "READY" },
    });
    expect(ready.statusCode).toBe(200);

    const committedAllocation = await db.inventoryAllocation.findFirst({
      where: { fillId: first.fillId, status: "COMMITTED" },
    });
    expect(committedAllocation?.quantity.toNumber()).toBe(30);

    balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(10);
    expect(balance.reservedQuantity.toNumber()).toBe(0);

    const dispensed = await db.inventoryTransaction.findFirst({
      where: {
        inventoryBalanceId: balanceId,
        fillId: first.fillId,
        type: "DISPENSE",
      },
    });
    expect(dispensed).toBeTruthy();
    expect(dispensed?.onHandDelta.toNumber()).toBe(-30);
    expect(dispensed?.reservedDelta.toNumber()).toBe(-30);

    const returned = await app.inject({
      method: "POST",
      url: `/api/fills/${first.fillId}/return-to-stock`,
      headers: technicianHeaders,
    });
    expect(returned.statusCode).toBe(200);

    balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(40);
    expect(balance.reservedQuantity.toNumber()).toBe(0);

    const technicianAdjust = await app.inject({
      method: "POST",
      url: `/api/inventory/balances/${balanceId}/adjust`,
      headers: technicianHeaders,
      payload: {
        delta: -5,
        reason: "Cycle count correction",
      },
    });
    expect(technicianAdjust.statusCode).toBe(403);

    const pharmacistAdjust = await app.inject({
      method: "POST",
      url: `/api/inventory/balances/${balanceId}/adjust`,
      headers: pharmacistHeaders,
      payload: {
        delta: -5,
        reason: "Cycle count found five fewer tablets.",
      },
    });
    expect(pharmacistAdjust.statusCode).toBe(200);
    expect(Number(pharmacistAdjust.json().balance.onHandQuantity)).toBe(35);

    const unsafeAdjust = await app.inject({
      method: "POST",
      url: `/api/inventory/balances/${balanceId}/adjust`,
      headers: pharmacistHeaders,
      payload: {
        delta: -36,
        reason: "Should be rejected.",
      },
    });
    expect(unsafeAdjust.statusCode).toBe(409);
    expect(unsafeAdjust.json().code).toBe("INVENTORY_ADJUSTMENT_CONFLICT");

    const ledger = await app.inject({
      method: "GET",
      url: "/api/inventory/balances",
      headers: pharmacistHeaders,
    });
    expect(ledger.statusCode).toBe(200);
    const isolated = ledger
      .json()
      .balances.find((item: { id: string }) => item.id === balanceId);

    expect(isolated).toBeTruthy();
    expect(Number(isolated.onHandQuantity)).toBe(35);
    expect(Number(isolated.reservedQuantity)).toBe(0);
    expect(Number(isolated.availableQuantity)).toBe(35);

    const types = (isolated.transactions as Array<{ type: string }>).map(
      (transaction) => transaction.type,
    );
    expect(types).toContain("RECEIVE");
    expect(types).toContain("RESERVE");
    expect(types).toContain("DISPENSE");
    expect(types).toContain("RETURN_TO_STOCK");
    expect(types).toContain("ADJUSTMENT");
  });
});
