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

type FillMode = "REVIEW" | "READY" | "SOLD";

async function createScannedFill(input: {
  rawBarcode: string;
  suffix: string;
  label: string;
  quantity: number;
  mode: FillMode;
}) {
  const created = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId: "patient-demo-001",
      prescriberId: "prescriber-demo-001",
      medicationId: "medication-demo-lisinopril-10",
      rxNumber: `RECALL-${input.suffix}-${input.label}`,
      sig: "Take 1 tablet by mouth once daily",
      quantityWritten: input.quantity,
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

  const fillResponse = await app.inject({
    method: "POST",
    url: `/api/prescriptions/${prescriptionId}/fills`,
    headers: technicianHeaders,
    payload: { quantity: input.quantity },
  });
  expect(fillResponse.statusCode).toBe(201);
  const fillId = fillResponse.json().fill.id as string;

  const scanned = await app.inject({
    method: "POST",
    url: `/api/fills/${fillId}/scan-barcode`,
    headers: technicianHeaders,
    payload: { rawBarcode: input.rawBarcode },
  });
  expect(scanned.statusCode).toBe(200);

  const review = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: technicianHeaders,
    payload: { status: "PHARMACIST_REVIEW" },
  });
  expect(review.statusCode).toBe(200);

  if (input.mode === "READY" || input.mode === "SOLD") {
    const ready = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: pharmacistHeaders,
      payload: { status: "READY" },
    });
    expect(ready.statusCode).toBe(200);
  }

  if (input.mode === "SOLD") {
    const sold = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "SOLD" },
    });
    expect(sold.statusCode).toBe(200);
  }

  return { prescriptionId, fillId };
}

describe("Phase 3H lot recall workflow", () => {
  it("quarantines stock, snapshots exposure, unwinds active fills, and blocks dispensing until closure", async () => {
    const suffix = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    const gtin = `0033333${suffix}0`;
    const lotNumber = `RCL-${suffix}`;
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
        quantity: 300,
        source: "Recall integration test",
        reference: `SHIP-${suffix}`,
      },
    });
    expect(received.statusCode).toBe(201);

    const balanceId = received.json().balance.id as string;
    const productLotId = received.json().traceability.lot.id as string;

    const soldFill = await createScannedFill({
      rawBarcode,
      suffix,
      label: "SOLD",
      quantity: 20,
      mode: "SOLD",
    });
    const readyFill = await createScannedFill({
      rawBarcode,
      suffix,
      label: "READY",
      quantity: 30,
      mode: "READY",
    });
    const reviewFill = await createScannedFill({
      rawBarcode,
      suffix,
      label: "REVIEW",
      quantity: 40,
      mode: "REVIEW",
    });

    let balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(250);
    expect(balance.reservedQuantity.toNumber()).toBe(40);
    expect(balance.quarantinedQuantity.toNumber()).toBe(0);

    const technicianRecall = await app.inject({
      method: "POST",
      url: "/api/inventory/recalls",
      headers: technicianHeaders,
      payload: {
        productLotId,
        source: "Manufacturer",
        referenceNumber: `MFR-${suffix}`,
        reason: "Synthetic lot recall for integration testing.",
      },
    });
    expect(technicianRecall.statusCode).toBe(403);

    const opened = await app.inject({
      method: "POST",
      url: "/api/inventory/recalls",
      headers: pharmacistHeaders,
      payload: {
        productLotId,
        source: "Manufacturer",
        referenceNumber: `MFR-${suffix}`,
        reason:
          "Synthetic recall: affected lot must be removed from dispensing.",
      },
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.json().recall.status).toBe("OPEN");
    expect(opened.json().recall.summary.affectedFillCount).toBe(3);
    expect(opened.json().recall.summary.soldFillCount).toBe(1);
    expect(opened.json().recall.summary.readyFillCount).toBe(1);
    expect(opened.json().recall.summary.activeFillCount).toBe(1);
    expect(Number(opened.json().recall.summary.quarantinedQuantity)).toBe(250);

    const recallId = opened.json().recall.id as string;
    const initialRecallHoldId = opened.json().recall.holds[0].id as string;

    balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(250);
    expect(balance.reservedQuantity.toNumber()).toBe(0);
    expect(balance.quarantinedQuantity.toNumber()).toBe(250);

    const invalidatedFill = await db.prescriptionFill.findUniqueOrThrow({
      where: { id: reviewFill.fillId },
      include: { prescription: true },
    });
    expect(invalidatedFill.status).toBe("IN_PROGRESS");
    expect(invalidatedFill.productId).toBeNull();
    expect(invalidatedFill.productLotId).toBeNull();
    expect(invalidatedFill.productVerifiedAt).toBeNull();
    expect(invalidatedFill.inventoryBalanceId).toBeNull();
    expect(invalidatedFill.inventoryReservedAt).toBeNull();
    expect(invalidatedFill.prescription.status).toBe("PRODUCT_FILL");

    const duplicateRecall = await app.inject({
      method: "POST",
      url: "/api/inventory/recalls",
      headers: pharmacistHeaders,
      payload: {
        productLotId,
        reason: "Duplicate should be blocked.",
      },
    });
    expect(duplicateRecall.statusCode).toBe(409);
    expect(duplicateRecall.json().code).toBe("RECALL_ALREADY_OPEN");

    const blockedRescan = await app.inject({
      method: "POST",
      url: `/api/fills/${reviewFill.fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(blockedRescan.statusCode).toBe(409);
    expect(blockedRescan.json().code).toBe("PRODUCT_RECALLED");

    const blockedSale = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${readyFill.prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "SOLD" },
    });
    expect(blockedSale.statusCode).toBe(409);
    expect(blockedSale.json().code).toBe("PRODUCT_RECALLED");

    const receivedDuringRecall = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        quantity: 10,
        source: "Late shipment",
        reference: `LATE-${suffix}`,
      },
    });
    expect(receivedDuringRecall.statusCode).toBe(201);
    expect(receivedDuringRecall.json().recallHold).toBeTruthy();
    expect(receivedDuringRecall.json().recallHold.recallId).toBe(recallId);

    balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(260);
    expect(balance.quarantinedQuantity.toNumber()).toBe(260);

    const blockedRelease = await app.inject({
      method: "POST",
      url: `/api/inventory/holds/${initialRecallHoldId}/release`,
      headers: pharmacistHeaders,
      payload: {
        resolutionNote: "Attempted release while recall is still open.",
      },
    });
    expect(blockedRelease.statusCode).toBe(409);
    expect(blockedRelease.json().code).toBe("ACTIVE_RECALL");

    const returnedReady = await app.inject({
      method: "POST",
      url: `/api/fills/${readyFill.fillId}/return-to-stock`,
      headers: technicianHeaders,
    });
    expect(returnedReady.statusCode).toBe(200);
    expect(returnedReady.json().fill.status).toBe("RETURNED_TO_STOCK");

    balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(290);
    expect(balance.quarantinedQuantity.toNumber()).toBe(290);

    const soldSnapshot = await db.inventoryRecallAffectedFill.findFirst({
      where: {
        recallId,
        fillId: soldFill.fillId,
      },
    });
    expect(soldSnapshot).toBeTruthy();
    expect(soldSnapshot?.fillStatusAtIdentification).toBe("SOLD");

    const refreshedRecall = await app.inject({
      method: "GET",
      url: `/api/inventory/recalls/${recallId}`,
      headers: pharmacistHeaders,
    });
    expect(refreshedRecall.statusCode).toBe(200);
    expect(refreshedRecall.json().recall.holds.length).toBeGreaterThanOrEqual(3);
    expect(
      Number(refreshedRecall.json().recall.summary.quarantinedQuantity),
    ).toBe(290);

    const closed = await app.inject({
      method: "POST",
      url: `/api/inventory/recalls/${recallId}/close`,
      headers: pharmacistHeaders,
      payload: {
        closureNote:
          "Synthetic manufacturer notice resolved; held stock remains segregated pending separate disposition decision.",
      },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().recall.status).toBe("CLOSED");

    balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.quarantinedQuantity.toNumber()).toBe(290);

    const releasedAfterClosure = await app.inject({
      method: "POST",
      url: `/api/inventory/holds/${initialRecallHoldId}/release`,
      headers: pharmacistHeaders,
      payload: {
        resolutionNote:
          "Recall closed; initial quarantined quantity cleared for use.",
      },
    });
    expect(releasedAfterClosure.statusCode).toBe(200);

    balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.quarantinedQuantity.toNumber()).toBe(40);
    expect(
      balance.onHandQuantity
        .minus(balance.reservedQuantity)
        .minus(balance.quarantinedQuantity)
        .toNumber(),
    ).toBe(250);

    const allowedAfterClosure = await app.inject({
      method: "POST",
      url: `/api/fills/${reviewFill.fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(allowedAfterClosure.statusCode).toBe(200);

    const recallAudit = await db.auditEvent.findMany({
      where: {
        OR: [
          { entityType: "InventoryRecall", entityId: recallId },
          {
            action: "INVENTORY_RECALLED_STOCK_RECEIVED_QUARANTINED",
          },
        ],
      },
      orderBy: { occurredAt: "asc" },
    });

    const actions = recallAudit.map((event) => event.action);
    expect(actions).toContain("INVENTORY_RECALL_OPENED");
    expect(actions).toContain(
      "INVENTORY_RECALLED_STOCK_RECEIVED_QUARANTINED",
    );
    expect(actions).toContain("INVENTORY_RECALL_CLOSED");
  });
});
