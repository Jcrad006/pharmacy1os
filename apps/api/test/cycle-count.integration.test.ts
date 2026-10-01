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

describe("Phase 3H cycle counts", () => {
  it("requires pharmacist review, reconciles discrepancies, and blocks stale counts", async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 7);
    const gtin = `0055555${suffix}0`;
    const lotNumber = `COUNT-${suffix}`;
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
        quantity: 50,
        source: "Cycle count test",
        reference: suffix,
      },
    });
    expect(received.statusCode).toBe(201);
    const balanceId = received.json().balance.id as string;

    const created = await app.inject({
      method: "POST",
      url: "/api/inventory/cycle-counts",
      headers: technicianHeaders,
      payload: {
        balanceIds: [balanceId],
        note: "Targeted cycle count integration test",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().session.status).toBe("OPEN");
    expect(created.json().session.lines).toHaveLength(1);

    const cycleCountId = created.json().session.id as string;
    const lineId = created.json().session.lines[0].id as string;

    const counted = await app.inject({
      method: "PATCH",
      url: `/api/inventory/cycle-counts/${cycleCountId}/lines/${lineId}`,
      headers: technicianHeaders,
      payload: { countedQuantity: 47 },
    });
    expect(counted.statusCode).toBe(200);
    expect(Number(counted.json().session.lines[0].expectedOnHand)).toBe(50);
    expect(Number(counted.json().session.lines[0].countedQuantity)).toBe(47);
    expect(Number(counted.json().session.lines[0].discrepancy)).toBe(-3);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/inventory/cycle-counts/${cycleCountId}/submit`,
      headers: technicianHeaders,
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().session.status).toBe("SUBMITTED");

    const technicianReview = await app.inject({
      method: "POST",
      url: `/api/inventory/cycle-counts/${cycleCountId}/review`,
      headers: technicianHeaders,
      payload: {
        decision: "APPROVE",
        reviewNote: "Technician should not be permitted to approve.",
      },
    });
    expect(technicianReview.statusCode).toBe(403);

    const approved = await app.inject({
      method: "POST",
      url: `/api/inventory/cycle-counts/${cycleCountId}/review`,
      headers: pharmacistHeaders,
      payload: {
        decision: "APPROVE",
        reviewNote:
          "Physical count verified; reconcile three-tablet shortage.",
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().session.status).toBe("APPROVED");
    expect(
      approved.json().session.lines[0].reconciledTransactionId,
    ).toBeTruthy();

    let balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(47);
    expect(balance.reservedQuantity.toNumber()).toBe(0);

    const adjustment = await db.inventoryTransaction.findFirst({
      where: {
        inventoryBalanceId: balanceId,
        type: "ADJUSTMENT",
        source: "CYCLE_COUNT",
        reference: cycleCountId,
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(adjustment).toBeTruthy();
    expect(adjustment?.onHandDelta.toNumber()).toBe(-3);

    const second = await app.inject({
      method: "POST",
      url: "/api/inventory/cycle-counts",
      headers: technicianHeaders,
      payload: { balanceIds: [balanceId] },
    });
    expect(second.statusCode).toBe(201);

    const secondId = second.json().session.id as string;
    const secondLineId = second.json().session.lines[0].id as string;

    const secondCounted = await app.inject({
      method: "PATCH",
      url: `/api/inventory/cycle-counts/${secondId}/lines/${secondLineId}`,
      headers: technicianHeaders,
      payload: { countedQuantity: 47 },
    });
    expect(secondCounted.statusCode).toBe(200);

    const secondSubmitted = await app.inject({
      method: "POST",
      url: `/api/inventory/cycle-counts/${secondId}/submit`,
      headers: technicianHeaders,
    });
    expect(secondSubmitted.statusCode).toBe(200);

    const laterReceipt = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        quantity: 1,
        source: "Movement after count",
      },
    });
    expect(laterReceipt.statusCode).toBe(201);

    const staleApproval = await app.inject({
      method: "POST",
      url: `/api/inventory/cycle-counts/${secondId}/review`,
      headers: pharmacistHeaders,
      payload: {
        decision: "APPROVE",
        reviewNote: "Attempt approval after inventory movement.",
      },
    });
    expect(staleApproval.statusCode).toBe(409);
    expect(staleApproval.json().code).toBe("CYCLE_COUNT_STALE");

    const stillSubmitted = await db.cycleCountSession.findUniqueOrThrow({
      where: { id: secondId },
    });
    expect(stillSubmitted.status).toBe("SUBMITTED");

    balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(48);

    const rejected = await app.inject({
      method: "POST",
      url: `/api/inventory/cycle-counts/${secondId}/review`,
      headers: pharmacistHeaders,
      payload: {
        decision: "REJECT",
        reviewNote: "Inventory moved after count; reject and recount.",
      },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().session.status).toBe("REJECTED");

    const cycleAudit = await db.auditEvent.findMany({
      where: {
        entityType: { in: ["CycleCountSession", "CycleCountLine"] },
        OR: [
          { entityId: cycleCountId },
          { entityId: lineId },
          { entityId: secondId },
          { entityId: secondLineId },
        ],
      },
      orderBy: { occurredAt: "asc" },
    });

    const actions = cycleAudit.map((event) => event.action);
    expect(actions).toContain("INVENTORY_CYCLE_COUNT_CREATED");
    expect(actions).toContain("INVENTORY_CYCLE_COUNT_LINE_COUNTED");
    expect(actions).toContain("INVENTORY_CYCLE_COUNT_SUBMITTED");
    expect(actions).toContain("INVENTORY_CYCLE_COUNT_APPROVED");
    expect(actions).toContain("INVENTORY_CYCLE_COUNT_REJECTED");
  });
});
