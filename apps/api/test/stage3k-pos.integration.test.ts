import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { receiveInventory } from "../src/inventory.js";

process.env.ALLOW_DEV_IDENTITY = "true";
process.env.CLAIM_SANDBOX_ENABLED = "true";

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };
const pharmacistHeaders = { "x-dev-user": "dev-pharmacist" };
const siteId = "site-demo-001";
const prescriberId = "prescriber-demo-001";

let technicianId = "";
let medicationId = "";
let productId = "";
let ndc = "";
let lotNumber = "";
let expirationDate!: Date;

async function makePatient(memberId?: string) {
  const token = randomUUID().slice(0, 8);
  const patient = await db.patient.create({
    data: {
      id: `patient-3k-${randomUUID()}`,
      siteId,
      firstName: "Phase3K",
      lastName: `Pickup-${token}`,
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    },
  });

  if (memberId) {
    const payer = await db.payer.create({
      data: {
        id: `payer-3k-${randomUUID()}`,
        siteId,
        name: `Phase3K Payer ${token} ${randomUUID().slice(0, 6)}`,
        bin: "019901",
        pcn: "PHASE3K",
        claimStandard: "D0",
        billingNdcStrategy: "MAJORITY_SOURCE",
        billingProfile: {
          create: {
            siteId,
            billingNdcStrategy: "MAJORITY_SOURCE",
            autoReversePaidClaimOnSourceCorrection: true,
            notes: "Phase 3K POS regression profile",
          },
        },
      },
    });
    await db.patientCoverage.create({
      data: {
        siteId,
        patientId: patient.id,
        payerId: payer.id,
        position: 1,
        memberId,
        relationship: "SELF",
        active: true,
      },
    });
  }

  return patient;
}

async function createPrescription(patientId: string, quantity: number) {
  const response = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId,
      prescriberId,
      medicationId,
      rxNumber: `3K-${randomUUID().slice(0, 12)}`,
      sig: "Take one tablet daily",
      quantityWritten: quantity,
      refillsAllowed: 2,
      productSelectionDirective: "SELECTION_PERMITTED",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().prescription.id as string;
}

async function createFill(
  prescriptionId: string,
  quantity: number,
  daysSupply = 30,
) {
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
    payload: { quantity, daysSupply },
  });
  expect(fill.statusCode).toBe(201);
  return fill.json().fill.id as string;
}

async function scan(fillId: string, quantity: number) {
  const response = await app.inject({
    method: "POST",
    url: `/api/fills/${fillId}/scan-product`,
    headers: technicianHeaders,
    payload: {
      ndc,
      lotNumber,
      expirationDate: expirationDate.toISOString(),
      sourceQuantity: quantity,
    },
  });
  expect(response.statusCode).toBe(200);
  return response;
}

async function makeReady(prescriptionId: string) {
  const review = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: technicianHeaders,
    payload: { status: "PHARMACIST_REVIEW" },
  });
  expect(review.statusCode).toBe(200);

  const ready = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: pharmacistHeaders,
    payload: { status: "READY" },
  });
  expect(ready.statusCode).toBe(200);
}

beforeAll(async () => {
  await app.ready();

  technicianId = (
    await db.user.findFirstOrThrow({
      where: { siteId, externalAuthId: "dev-technician" },
    })
  ).id;

  const manufacturer = await db.manufacturer.create({
    data: {
      id: `mfr-3k-${randomUUID()}`,
      name: `Phase3K Manufacturer ${randomUUID().slice(0, 8)}`,
      labelerCode: "77123",
    },
  });

  const token = String(
    Array.from(randomUUID().slice(0, 8)).reduce(
      (sum, char) => sum + char.charCodeAt(0),
      0,
    ),
  )
    .padStart(4, "0")
    .slice(-4);

  medicationId = `med-3k-${randomUUID()}`;
  await db.medication.create({
    data: {
      id: medicationId,
      genericName: `Phase3K Drug ${token}`,
      strength: "10 mg",
      dosageForm: "tablet",
      route: "oral",
    },
  });

  productId = `product-3k-${randomUUID()}`;
  ndc = `77123-${token}-01`;
  await db.product.create({
    data: {
      id: productId,
      medicationId,
      manufacturerId: manufacturer.id,
      ndc,
      ndcSearch: ndc.replace(/\D/g, ""),
      descriptor: "Phase3K POS regression product",
      packageDescription: "100 count bottle",
      packageType: "bottle",
      unitsPerPackage: 100,
      dispensingUnit: "EACH",
      unitPrice: 0.25,
      packagePrice: 25,
      therapeuticEquivalenceCode: "AB",
    },
  });

  lotNumber = `3KLOT${token}`;
  const lot = await db.productLot.create({
    data: {
      siteId,
      productId,
      lotNumber,
      lotNumberSearch: lotNumber.toUpperCase(),
    },
  });
  expirationDate = new Date(Date.now() + 365 * 86_400_000);
  expirationDate.setUTCHours(0, 0, 0, 0);
  const expiration = await db.productExpiration.create({
    data: { siteId, productId, expirationDate },
  });

  await db.$transaction((tx) =>
    receiveInventory(tx, {
      siteId,
      actorId: technicianId,
      productId,
      productLotId: lot.id,
      productExpirationId: expiration.id,
      quantity: 2000,
      source: "PHASE3K_TEST",
      reference: randomUUID(),
    }),
  );
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe("Stage 3K Will Call / POS hardening", () => {
  it("quotes cash from physical NDC pricing, records tender/change, and prevents duplicate sale", async () => {
    const patient = await makePatient();
    const prescriptionId = await createPrescription(patient.id, 30);
    const fillId = await createFill(prescriptionId, 30, 30);

    const scanned = await scan(fillId, 30);
    expect(scanned.json().adjudication.state).toBe("CASH_LABEL_READY");
    await makeReady(prescriptionId);

    const quote = await app.inject({
      method: "POST",
      url: "/api/pos/quote",
      headers: technicianHeaders,
      payload: { fillIds: [fillId] },
    });
    expect(quote.statusCode).toBe(200);
    expect(Number(quote.json().quote.totalDue)).toBe(7.5);
    expect(quote.json().quote.lines[0]).toMatchObject({
      fillId,
      priceBasis: "CASH",
    });
    expect(Number(quote.json().quote.lines[0].cashUnitPriceSnapshot)).toBe(0.25);

    const key = `3k-cash-${randomUUID()}`;
    const checkout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 10 }],
        idempotencyKey: key,
      },
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json().replayed).toBe(false);
    expect(Number(checkout.json().transaction.totalDue)).toBe(7.5);
    expect(Number(checkout.json().transaction.totalTendered)).toBe(10);
    expect(Number(checkout.json().transaction.changeDue)).toBe(2.5);
    expect(checkout.json().transaction.lines[0].priceBasis).toBe("CASH");

    const replay = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 10 }],
        idempotencyKey: key,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().transaction.id).toBe(checkout.json().transaction.id);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 7.5 }],
        idempotencyKey: `3k-cash-duplicate-${randomUUID()}`,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("FILL_NOT_READY");

    const fill = await db.prescriptionFill.findUniqueOrThrow({
      where: { id: fillId },
    });
    expect(fill.status).toBe("SOLD");
    expect(fill.soldAt).not.toBeNull();

    expect(
      await db.pointOfSaleLine.count({ where: { fillId } }),
    ).toBe(1);
  });

  it("uses the final active paid claim patient responsibility and rejects non-cash overpayment", async () => {
    const patient = await makePatient("PAID-COPAY1234-3K");
    const prescriptionId = await createPrescription(patient.id, 20);
    const fillId = await createFill(prescriptionId, 20, 20);

    const scanned = await scan(fillId, 20);
    expect(scanned.json().adjudication.state).toBe("PAID_LABEL_READY");
    await makeReady(prescriptionId);

    const claim = await db.claimTransaction.findFirstOrThrow({
      where: { fillId, operation: "SUBMIT", outcome: "PAID" },
    });
    expect(claim.patientResponsibility?.toNumber()).toBe(12.34);

    const quote = await app.inject({
      method: "POST",
      url: "/api/pos/quote",
      headers: technicianHeaders,
      payload: { fillIds: [fillId] },
    });
    expect(quote.statusCode).toBe(200);
    expect(Number(quote.json().quote.totalDue)).toBe(12.34);
    expect(quote.json().quote.lines[0]).toMatchObject({
      priceBasis: "THIRD_PARTY",
      claimTransactionId: claim.id,
    });

    const overpay = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CARD", amount: 15 }],
        idempotencyKey: `3k-overpay-${randomUUID()}`,
      },
    });
    expect(overpay.statusCode).toBe(400);
    expect(overpay.json().code).toBe("NONCASH_OVERPAYMENT");

    const checkout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CARD", amount: 12.34, reference: "TEST-AUTH" }],
        idempotencyKey: `3k-insured-${randomUUID()}`,
      },
    });
    expect(checkout.statusCode).toBe(200);
    expect(Number(checkout.json().transaction.totalDue)).toBe(12.34);
    expect(checkout.json().transaction.lines[0].claimTransactionId).toBe(claim.id);
    expect(Number(checkout.json().transaction.lines[0].patientResponsibilitySnapshot)).toBe(12.34);

    const reverse = await app.inject({
      method: "POST",
      url: `/api/third-party/claims/${claim.id}/reverse`,
      headers: technicianHeaders,
    });
    expect(reverse.statusCode).toBe(409);
    expect(reverse.json().code).toBe("POS_SALE_LOCKS_CLAIM");
  });

  it("charges the copay once for a partial/completion chain and records the completion pickup at zero due", async () => {
    const patient = await makePatient("PAID-COPAY0750-3K");
    const prescriptionId = await createPrescription(patient.id, 100);
    const fillId = await createFill(prescriptionId, 100, 30);

    const partial = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/partial`,
      headers: technicianHeaders,
      payload: {
        dispenseQuantity: 40,
        completionScheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        reason: "Synthetic split fill for POS regression.",
      },
    });
    expect(partial.statusCode).toBe(200);
    const completionId = partial.json().completionFill.id as string;

    const primaryScan = await scan(fillId, 40);
    expect(primaryScan.json().adjudication.state).toBe("PAID_LABEL_READY");
    await makeReady(prescriptionId);

    const primaryQuote = await app.inject({
      method: "POST",
      url: "/api/pos/quote",
      headers: technicianHeaders,
      payload: { fillIds: [fillId] },
    });
    expect(primaryQuote.statusCode).toBe(200);
    expect(Number(primaryQuote.json().quote.totalDue)).toBe(7.5);

    const primaryCheckout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CARD", amount: 7.5 }],
        idempotencyKey: `3k-partial-${randomUUID()}`,
      },
    });
    expect(primaryCheckout.statusCode).toBe(200);

    await db.prescriptionFill.update({
      where: { id: completionId },
      data: { scheduledFor: new Date(Date.now() - 1000) },
    });
    const started = await app.inject({
      method: "POST",
      url: `/api/fills/${completionId}/start`,
      headers: technicianHeaders,
    });
    expect(started.statusCode).toBe(200);

    const completionScan = await scan(completionId, 60);
    expect(completionScan.json().adjudication.state).toBe(
      "COMPLETION_LABEL_READY",
    );
    await makeReady(prescriptionId);

    const completionQuote = await app.inject({
      method: "POST",
      url: "/api/pos/quote",
      headers: technicianHeaders,
      payload: { fillIds: [completionId] },
    });
    expect(completionQuote.statusCode).toBe(200);
    expect(Number(completionQuote.json().quote.totalDue)).toBe(0);
    expect(completionQuote.json().quote.lines[0].priceBasis).toBe(
      "COMPLETION_ALREADY_BILLED",
    );

    const completionCheckout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [completionId],
        tenders: [],
        idempotencyKey: `3k-completion-${randomUUID()}`,
      },
    });
    expect(completionCheckout.statusCode).toBe(200);
    expect(Number(completionCheckout.json().transaction.totalDue)).toBe(0);

    const anchor = await db.prescriptionFill.findUniqueOrThrow({
      where: { id: fillId },
    });
    expect(anchor.remainingOwedQuantity.toNumber()).toBe(0);

    expect(
      await db.claimTransaction.count({
        where: {
          OR: [{ fillId }, { fillId: completionId }],
          operation: "SUBMIT",
        },
      }),
    ).toBe(1);
  });
});
