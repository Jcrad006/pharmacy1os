import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";
process.env.ALLOW_LEGACY_DIRECT_SALE = "true";

const app = buildApp();
const tech = { "x-dev-user": "dev-technician" };
const pharmacist = { "x-dev-user": "dev-pharmacist" };

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
    const suffix = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    const gtin = gs1WithCheckDigit(`0022222${suffix}`);
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

    const readyFill = await createFill(5, `${suffix}-READY`);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/fills/${readyFill.fillId}/scan-barcode`,
          headers: tech,
          payload: { rawBarcode },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${readyFill.prescriptionId}/status`,
          headers: tech,
          payload: { status: "PHARMACIST_REVIEW" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${readyFill.prescriptionId}/status`,
          headers: pharmacist,
          payload: { status: "READY" },
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
    expect(recallCreated.json().summary.affectedReadyFillCount).toBe(1);
    expect(recallCreated.json().summary.affectedSoldFillCount).toBe(1);
    expect(recallCreated.json().summary.quarantinedHoldCount).toBe(1);
    const recallId = recallCreated.json().recall.id as string;

    const quote = await app.inject({
      method: "POST",
      url: "/api/pos/quote",
      headers: tech,
      payload: {
        fillIds: [readyFill.fillId],
        pickupFulfillmentMode: "IMMEDIATE",
      },
    });
    expect(quote.statusCode).toBe(200);
    const amountDue = Number(quote.json().quote.totalDue);
    const recalledCheckout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: tech,
      payload: {
        fillIds: [readyFill.fillId],
        pickupFulfillmentMode: "IMMEDIATE",
        pickupPackages: [],
        tenders:
          amountDue > 0 ? [{ method: "CASH", amount: amountDue }] : [],
        pickup: {
          recipientName: "Recall Ready Patient",
          relationship: "Self",
          identityMethod: "KNOWN_PATIENT",
          signatureMethod: "ELECTRONIC_TYPED",
          signatureName: "Recall Ready Patient",
        },
        idempotencyKey: `recall-ready-${randomUUID()}`,
      },
    });
    expect(recalledCheckout.statusCode).toBe(409);
    expect(recalledCheckout.json().code).toBe("READY_FILL_RECALLED");

    const returnedReady = await app.inject({
      method: "POST",
      url: `/api/fills/${readyFill.fillId}/return-to-stock`,
      headers: tech,
    });
    expect(returnedReady.statusCode).toBe(200);

    const recalledReceipt = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: tech,
      payload: {
        rawBarcode,
        quantity: 1,
        source: "Receipt after active recall",
      },
    });
    expect(recalledReceipt.statusCode).toBe(201);
    expect(Number(recalledReceipt.json().balance.quarantinedQuantity)).toBe(41);

    const balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.onHandQuantity.toNumber()).toBe(41);
    expect(balance.quarantinedQuantity.toNumber()).toBe(41);

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
    expect(recalled.affectedFills).toHaveLength(2);
    expect(
      recalled.affectedFills.every(
        (item: { fill: { prescription: { patient: { firstName: string } } } }) =>
          item.fill.prescription.patient.firstName === "Casey",
      ),
    ).toBe(true);
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
