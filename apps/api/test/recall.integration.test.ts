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

async function createFill(quantity: number, suffix: string) {
  const created = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: tech,
    payload: {
      patientId: "patient-demo-001",
      prescriberId: "prescriber-demo-001",
      medicationId: "medication-demo-lisinopril-10",
      rxNumber: `RECALL-${suffix}-${randomUUID().slice(0, 4)}`,
      sig: "Take 1 tablet by mouth once daily",
      quantityWritten: quantity,
      refillsAllowed: 0,
    },
  });
  expect(created.statusCode).toBe(201);
  const prescriptionId = created.json().prescription.id as string;

  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/prescriptions/${prescriptionId}/status`,
        headers: tech,
        payload: { status: "DUR_REVIEW" },
      })
    ).statusCode,
  ).toBe(200);

  const fill = await app.inject({
    method: "POST",
    url: `/api/prescriptions/${prescriptionId}/fills`,
    headers: tech,
    payload: { quantity },
  });
  expect(fill.statusCode).toBe(201);

  return { prescriptionId, fillId: fill.json().fill.id as string };
}

describe("Phase 3H recall workflow", () => {
  it("quarantines matching stock, links sold fills/patients, and blocks recalled dispensing", async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
    const gtin = `0022222${suffix}0`;
    const lotNumber = `RCL-${suffix}`;
    const rawBarcode = `(01)${gtin}(17)291231(10)${lotNumber}`;

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/receiving/assign",
          headers: tech,
          payload: {
            rawBarcode,
            productId: "product-demo-lisinopril-a",
            isPrimary: false,
          },
        })
      ).statusCode,
    ).toBe(201);

    const stock = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: tech,
      payload: { rawBarcode, quantity: 50, source: "Recall test" },
    });
    expect(stock.statusCode).toBe(201);
    const balanceId = stock.json().balance.id as string;

    const soldFill = await createFill(10, suffix);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/fills/${soldFill.fillId}/scan-barcode`,
          headers: tech,
          payload: { rawBarcode },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${soldFill.prescriptionId}/status`,
          headers: tech,
          payload: { status: "PHARMACIST_REVIEW" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${soldFill.prescriptionId}/status`,
          headers: pharmacist,
          payload: { status: "READY" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${soldFill.prescriptionId}/status`,
          headers: tech,
          payload: { status: "SOLD" },
        })
      ).statusCode,
    ).toBe(200);

    const techRecall = await app.inject({
      method: "POST",
      url: "/api/inventory/recalls",
      headers: tech,
      payload: {
        productId: "product-demo-lisinopril-a",
        lotNumber,
        reference: `FDA-${suffix}`,
        reason: "Synthetic recall test",
      },
    });
    expect(techRecall.statusCode).toBe(403);

    const recallCreated = await app.inject({
      method: "POST",
      url: "/api/inventory/recalls",
      headers: pharmacist,
      payload: {
        productId: "product-demo-lisinopril-a",
        lotNumber,
        reference: `FDA-${suffix}`,
        reason: "Synthetic recall test",
      },
    });
    expect(recallCreated.statusCode).toBe(201);
    expect(recallCreated.json().recall.status).toBe("ACTIVE");
    expect(recallCreated.json().summary.affectedSoldFillCount).toBe(1);
    expect(recallCreated.json().summary.quarantinedHoldCount).toBe(1);
    const recallId = recallCreated.json().recall.id as string;

    const balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(40);
    expect(balance.quarantinedQuantity.toNumber()).toBe(40);

    const newFill = await createFill(5, `${suffix}B`);
    const recalledScan = await app.inject({
      method: "POST",
      url: `/api/fills/${newFill.fillId}/scan-barcode`,
      headers: tech,
      payload: { rawBarcode },
    });
    expect(recalledScan.statusCode).toBe(409);
    expect(recalledScan.json().code).toBe("INVENTORY_RECALLED");

    const recalls = await app.inject({
      method: "GET",
      url: "/api/inventory/recalls",
      headers: pharmacist,
    });
    expect(recalls.statusCode).toBe(200);
    const recalled = recalls
      .json()
      .recalls.find((item: { id: string }) => item.id === recallId);
    expect(recalled.affectedFills).toHaveLength(1);
    expect(recalled.affectedFills[0].fill.prescription.patient.firstName).toBe(
      "Casey",
    );
    expect(recalled.holds[0].recallCaseId).toBe(recallId);

    const closed = await app.inject({
      method: "POST",
      url: `/api/inventory/recalls/${recallId}/close`,
      headers: pharmacist,
      payload: {
        closureNote:
          "Recall response documented; quarantine hold remains pending disposition.",
      },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().recall.status).toBe("CLOSED");

    const hold = await db.inventoryHold.findFirst({
      where: { recallCaseId: recallId, status: "ACTIVE" },
    });
    expect(hold).toBeTruthy();
  });
});
