import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";

const app = buildApp();
const tech = { "x-dev-user": "dev-technician" };
const pharmacist = { "x-dev-user": "dev-pharmacist" };

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe("Phase 3H purchase orders", () => {
  it("reconciles partial receipts, prevents over-receipt, and preserves receipt traceability", async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 7);
    const orderNumber = `PO-${suffix}`;

    const created = await app.inject({
      method: "POST",
      url: "/api/inventory/purchase-orders",
      headers: tech,
      payload: {
        orderNumber,
        supplierName: "Synthetic Wholesaler",
        note: "Integration test order",
        lines: [
          {
            productId: "product-demo-lisinopril-a",
            quantityOrdered: 50,
            unitCost: 0.025,
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().purchaseOrder.status).toBe("OPEN");
    const orderId = created.json().purchaseOrder.id as string;
    const lineId = created.json().purchaseOrder.lines[0].id as string;

    const firstReceipt = await app.inject({
      method: "POST",
      url: `/api/inventory/purchase-orders/${orderId}/lines/${lineId}/receive`,
      headers: tech,
      payload: {
        quantity: 20,
        lotNumber: `POLOT-${suffix}`,
        expirationDate: "2029-12-31T00:00:00.000Z",
        invoiceReference: `INV-${suffix}-1`,
      },
    });
    expect(firstReceipt.statusCode).toBe(200);
    expect(firstReceipt.json().purchaseOrder.status).toBe(
      "PARTIALLY_RECEIVED",
    );
    expect(
      Number(firstReceipt.json().purchaseOrder.lines[0].quantityReceived),
    ).toBe(20);

    const overReceipt = await app.inject({
      method: "POST",
      url: `/api/inventory/purchase-orders/${orderId}/lines/${lineId}/receive`,
      headers: tech,
      payload: {
        quantity: 31,
        lotNumber: `POLOT-${suffix}`,
        expirationDate: "2029-12-31T00:00:00.000Z",
      },
    });
    expect(overReceipt.statusCode).toBe(409);
    expect(overReceipt.json().code).toBe("PURCHASE_ORDER_OVER_RECEIPT");

    const finalReceipt = await app.inject({
      method: "POST",
      url: `/api/inventory/purchase-orders/${orderId}/lines/${lineId}/receive`,
      headers: tech,
      payload: {
        quantity: 30,
        lotNumber: `POLOT-${suffix}`,
        expirationDate: "2029-12-31T00:00:00.000Z",
        invoiceReference: `INV-${suffix}-2`,
      },
    });
    expect(finalReceipt.statusCode).toBe(200);
    expect(finalReceipt.json().purchaseOrder.status).toBe("RECEIVED");
    expect(
      Number(finalReceipt.json().purchaseOrder.lines[0].quantityReceived),
    ).toBe(50);

    const receipts = await db.purchaseOrderReceipt.findMany({
      where: { purchaseOrderLineId: lineId },
      include: { inventoryTransaction: true },
      orderBy: { receivedAt: "asc" },
    });
    expect(receipts).toHaveLength(2);
    expect(receipts.map((item) => item.quantity.toNumber())).toEqual([20, 30]);
    expect(
      receipts.every(
        (item) =>
          item.inventoryTransaction.type === "RECEIVE" &&
          item.inventoryTransaction.source === "PURCHASE_ORDER" &&
          item.inventoryTransaction.reference === orderNumber,
      ),
    ).toBe(true);

    const cannotCancel = await app.inject({
      method: "POST",
      url: `/api/inventory/purchase-orders/${orderId}/cancel`,
      headers: pharmacist,
    });
    expect(cannotCancel.statusCode).toBe(409);
    expect(cannotCancel.json().code).toBe(
      "PURCHASE_ORDER_ALREADY_RECEIVED",
    );

    const second = await app.inject({
      method: "POST",
      url: "/api/inventory/purchase-orders",
      headers: tech,
      payload: {
        orderNumber: `${orderNumber}-C`,
        supplierName: "Synthetic Wholesaler",
        lines: [
          {
            productId: "product-demo-atorvastatin-a",
            quantityOrdered: 10,
          },
        ],
      },
    });
    expect(second.statusCode).toBe(201);
    const secondId = second.json().purchaseOrder.id as string;

    const techCancel = await app.inject({
      method: "POST",
      url: `/api/inventory/purchase-orders/${secondId}/cancel`,
      headers: tech,
    });
    expect(techCancel.statusCode).toBe(403);

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/inventory/purchase-orders/${secondId}/cancel`,
      headers: pharmacist,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().purchaseOrder.status).toBe("CANCELLED");
  });
});
