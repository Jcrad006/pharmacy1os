import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { receiveInventory } from "../src/inventory.js";

process.env.ALLOW_DEV_IDENTITY = "true";
process.env.ALLOW_LEGACY_DIRECT_SALE = "false";
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

async function stage(
  fillId: string,
  bagBarcode?: string,
  locationBarcode?: string,
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/fills/${fillId}/will-call/stage`,
    headers: technicianHeaders,
    payload: {
      ...(bagBarcode ? { bagBarcode } : {}),
      ...(locationBarcode ? { locationBarcode } : {}),
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json().package as {
    id: string;
    bagBarcode: string;
    status: string;
    location: {
      id: string;
      code: string;
      barcode: string | null;
    };
  };
}

function pickup(fillId: string, bagBarcode: string) {
  return {
    pickupPackages: [{ fillId, bagBarcode }],
    pickup: {
      recipientName: "Phase3K Pickup",
      relationship: "Self",
      identityMethod: "DATE_OF_BIRTH",
      identityValue: "1990-01-01",
      signatureMethod: "ELECTRONIC_TYPED",
      signatureName: "Phase3K Pickup",
    },
  };
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
  it("stages a bag, quotes cash, verifies pickup, records tender/change, and prevents duplicate sale", async () => {
    const patient = await makePatient();
    const prescriptionId = await createPrescription(patient.id, 30);
    const fillId = await createFill(prescriptionId, 30, 30);

    const scanned = await scan(fillId, 30);
    expect(scanned.json().adjudication.state).toBe("CASH_LABEL_READY");
    await makeReady(prescriptionId);

    const bypass = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "SOLD" },
    });
    expect(bypass.statusCode).toBe(409);
    expect(bypass.json().code).toBe("POS_CHECKOUT_REQUIRED");

    const beforeStage = await app.inject({
      method: "POST",
      url: "/api/pos/quote",
      headers: technicianHeaders,
      payload: { fillIds: [fillId] },
    });
    expect(beforeStage.statusCode).toBe(409);
    expect(beforeStage.json().code).toBe("WILL_CALL_STAGING_REQUIRED");

    const locationBarcode =
      `WC-BIN-3K-${randomUUID().slice(0, 8)}`.toUpperCase();
    const locationCode =
      `WC3K${randomUUID().replace(/-/g, "").slice(0, 7)}`.toUpperCase();
    const createdLocation = await app.inject({
      method: "POST",
      url: "/api/inventory/locations",
      headers: pharmacistHeaders,
      payload: {
        code: locationCode,
        name: "Phase 3K Pickup Bin",
        type: "WILL_CALL",
        barcode: locationBarcode,
      },
    });
    expect(createdLocation.statusCode).toBe(201);

    const cashBagBarcode =
      `WC-BAG-CASH-3K-${randomUUID().slice(0, 8)}`.toUpperCase();
    const staged = await stage(fillId, cashBagBarcode, locationBarcode);
    expect(staged.status).toBe("STAGED");
    expect(staged.bagBarcode).toBe(cashBagBarcode);
    expect(staged.location.code).toBe(locationCode);
    expect(staged.location.barcode).toBe(locationBarcode);

    const locationScan = await app.inject({
      method: "GET",
      url: `/api/will-call/packages/scan/${encodeURIComponent(locationBarcode)}`,
      headers: technicianHeaders,
    });
    expect(locationScan.statusCode).toBe(200);
    expect(locationScan.json().scanType).toBe("LOCATION");
    expect(
      locationScan.json().packages.some(
        (item: { fillId: string }) => item.fillId === fillId,
      ),
    ).toBe(true);

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
      bagBarcode: cashBagBarcode,
      willCallLocationCode: locationCode,
    });
    expect(Number(quote.json().quote.lines[0].cashUnitPriceSnapshot)).toBe(0.25);

    const wrongBag = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 7.5 }],
        ...pickup(fillId, "WRONG-BAG"),
        idempotencyKey: `3k-wrong-bag-${randomUUID()}`,
      },
    });
    expect(wrongBag.statusCode).toBe(409);
    expect(wrongBag.json().code).toBe("WILL_CALL_BAG_MISMATCH");

    const wrongDob = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 7.5 }],
        pickupPackages: [{ fillId, bagBarcode: staged.bagBarcode }],
        pickup: {
          ...pickup(fillId, staged.bagBarcode).pickup,
          identityValue: "1991-01-01",
        },
        idempotencyKey: `3k-wrong-dob-${randomUUID()}`,
      },
    });
    expect(wrongDob.statusCode).toBe(409);
    expect(wrongDob.json().code).toBe("PICKUP_IDENTITY_MISMATCH");

    const key = `3k-cash-${randomUUID()}`;
    const checkout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 10 }],
        ...pickup(fillId, staged.bagBarcode),
        idempotencyKey: key,
      },
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json().replayed).toBe(false);
    expect(Number(checkout.json().transaction.totalDue)).toBe(7.5);
    expect(Number(checkout.json().transaction.totalTendered)).toBe(10);
    expect(Number(checkout.json().transaction.changeDue)).toBe(2.5);
    expect(checkout.json().transaction.lines[0].priceBasis).toBe("CASH");
    expect(checkout.json().transaction.pickupIdentityMethod).toBe("DATE_OF_BIRTH");
    expect(checkout.json().transaction.pickupSignatureName).toBe("Phase3K Pickup");

    const pickedPackage = await db.willCallPackage.findUniqueOrThrow({
      where: { fillId },
    });
    expect(pickedPackage.status).toBe("PICKED_UP");
    expect(pickedPackage.pickedUpAt).not.toBeNull();

    const replay = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 10 }],
        ...pickup(fillId, staged.bagBarcode),
        idempotencyKey: key,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().transaction.id).toBe(checkout.json().transaction.id);

    const conflictingReplay = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 9 }],
        ...pickup(fillId, staged.bagBarcode),
        idempotencyKey: key,
      },
    });
    expect(conflictingReplay.statusCode).toBe(409);
    expect(conflictingReplay.json().code).toBe("IDEMPOTENCY_KEY_CONFLICT");

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 7.5 }],
        ...pickup(fillId, staged.bagBarcode),
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
    expect(await db.pointOfSaleLine.count({ where: { fillId } })).toBe(1);
  });

  it("tracks relocate/rebag history, retires old bag barcodes, and closes the active barcode at pickup", async () => {
    const patient = await makePatient();
    const prescriptionId = await createPrescription(patient.id, 12);
    const fillId = await createFill(prescriptionId, 12, 12);

    const scanned = await scan(fillId, 12);
    expect(scanned.json().adjudication.state).toBe("CASH_LABEL_READY");
    await makeReady(prescriptionId);

    const firstLocationBarcode =
      `WC-HIST-A-${randomUUID().slice(0, 8)}`.toUpperCase();
    const secondLocationBarcode =
      `WC-HIST-B-${randomUUID().slice(0, 8)}`.toUpperCase();

    for (const [barcode, suffix] of [
      [firstLocationBarcode, "A"],
      [secondLocationBarcode, "B"],
    ] as const) {
      const created = await app.inject({
        method: "POST",
        url: "/api/inventory/locations",
        headers: pharmacistHeaders,
        payload: {
          code: `WCH${suffix}${randomUUID().replace(/-/g, "").slice(0, 6)}`.toUpperCase(),
          name: `Phase 3K History Bin ${suffix}`,
          type: "WILL_CALL",
          barcode,
        },
      });
      expect(created.statusCode).toBe(201);
    }

    const firstBag =
      `WC-HISTORY-OLD-${randomUUID().slice(0, 8)}`.toUpperCase();
    const nextBag =
      `WC-HISTORY-NEW-${randomUUID().slice(0, 8)}`.toUpperCase();

    const staged = await stage(fillId, firstBag, firstLocationBarcode);
    expect(staged.bagBarcode).toBe(firstBag);

    const relocated = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/will-call/relocate`,
      headers: technicianHeaders,
      payload: { locationBarcode: secondLocationBarcode },
    });
    expect(relocated.statusCode).toBe(200);
    expect(relocated.json().package.location.barcode).toBe(
      secondLocationBarcode,
    );

    const rebagged = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/will-call/rebag`,
      headers: technicianHeaders,
      payload: { bagBarcode: nextBag },
    });
    expect(rebagged.statusCode).toBe(200);
    expect(rebagged.json().package.bagBarcode).toBe(nextBag);

    const oldScan = await app.inject({
      method: "GET",
      url: `/api/will-call/packages/scan/${encodeURIComponent(firstBag)}`,
      headers: technicianHeaders,
    });
    expect(oldScan.statusCode).toBe(409);
    expect(oldScan.json().code).toBe("VOID_BAG_BARCODE");
    expect(oldScan.json().details.currentBagBarcode).toBe(nextBag);

    const reuseOld = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/will-call/rebag`,
      headers: technicianHeaders,
      payload: { bagBarcode: firstBag },
    });
    expect(reuseOld.statusCode).toBe(409);
    expect(reuseOld.json().code).toBe("BAG_BARCODE_RETIRED");

    const activeBeforePickup = await db.willCallBagBarcode.findMany({
      where: { packageId: staged.id },
      orderBy: { assignedAt: "asc" },
    });
    expect(activeBeforePickup.map((item) => [item.barcode, item.status])).toEqual([
      [firstBag, "VOIDED"],
      [nextBag, "ACTIVE"],
    ]);

    const history = await app.inject({
      method: "GET",
      url: `/api/fills/${fillId}/will-call/history`,
      headers: technicianHeaders,
    });
    expect(history.statusCode).toBe(200);
    expect(
      history.json().events.map((event: { eventType: string }) => event.eventType),
    ).toEqual(["REBAGGED", "RELOCATED", "STAGED"]);

    const quote = await app.inject({
      method: "POST",
      url: "/api/pos/quote",
      headers: technicianHeaders,
      payload: { fillIds: [fillId] },
    });
    expect(quote.statusCode).toBe(200);
    expect(Number(quote.json().quote.totalDue)).toBe(3);

    const checkout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 3 }],
        ...pickup(fillId, nextBag),
        idempotencyKey: `3k-history-pickup-${randomUUID()}`,
      },
    });
    expect(checkout.statusCode).toBe(200);

    const activeAfterPickup = await db.willCallBagBarcode.findUniqueOrThrow({
      where: { barcode: nextBag },
    });
    expect(activeAfterPickup.status).toBe("VOIDED");
    expect(activeAfterPickup.voidedAt).not.toBeNull();

    const finalHistory = await app.inject({
      method: "GET",
      url: `/api/fills/${fillId}/will-call/history`,
      headers: technicianHeaders,
    });
    expect(finalHistory.statusCode).toBe(200);
    expect(finalHistory.json().events[0].eventType).toBe("PICKED_UP");
  });

  it("supports immediate pickup for a waiting patient without creating a Will Call package", async () => {
    const patient = await makePatient();
    const prescriptionId = await createPrescription(patient.id, 10);
    const fillId = await createFill(prescriptionId, 10, 10);

    const scanned = await scan(fillId, 10);
    expect(scanned.json().adjudication.state).toBe("CASH_LABEL_READY");
    await makeReady(prescriptionId);

    const quote = await app.inject({
      method: "POST",
      url: "/api/pos/quote",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        pickupFulfillmentMode: "IMMEDIATE",
      },
    });
    expect(quote.statusCode).toBe(200);
    expect(quote.json().quote.pickupFulfillmentMode).toBe("IMMEDIATE");
    expect(quote.json().quote.lines[0]).toMatchObject({
      pickupFulfillmentMode: "IMMEDIATE",
      willCallPackageId: null,
      bagBarcode: null,
      willCallLocationId: null,
    });
    expect(Number(quote.json().quote.totalDue)).toBe(2.5);

    const checkout = await app.inject({
      method: "POST",
      url: "/api/pos/checkout",
      headers: technicianHeaders,
      payload: {
        fillIds: [fillId],
        tenders: [{ method: "CASH", amount: 2.5 }],
        pickupPackages: [],
        pickupFulfillmentMode: "IMMEDIATE",
        pickup: {
          recipientName: "Phase3K Waiting Patient",
          relationship: "Self",
          identityMethod: "DATE_OF_BIRTH",
          identityValue: "1990-01-01",
          signatureMethod: "ELECTRONIC_TYPED",
          signatureName: "Phase3K Waiting Patient",
        },
        idempotencyKey: `3k-immediate-${randomUUID()}`,
      },
    });
    expect(checkout.statusCode).toBe(200);
    expect(checkout.json().transaction.pickupFulfillmentMode).toBe("IMMEDIATE");
    expect(
      await db.willCallPackage.findUnique({ where: { fillId } }),
    ).toBeNull();

    const soldFill = await db.prescriptionFill.findUniqueOrThrow({
      where: { id: fillId },
    });
    expect(soldFill.status).toBe("SOLD");

    const stagedPrescriptionId = await createPrescription(patient.id, 8);
    const stagedFillId = await createFill(stagedPrescriptionId, 8, 8);
    const stagedScan = await scan(stagedFillId, 8);
    expect(stagedScan.json().adjudication.state).toBe("CASH_LABEL_READY");
    await makeReady(stagedPrescriptionId);
    await stage(stagedFillId);

    const stagedImmediateQuote = await app.inject({
      method: "POST",
      url: "/api/pos/quote",
      headers: technicianHeaders,
      payload: {
        fillIds: [stagedFillId],
        pickupFulfillmentMode: "IMMEDIATE",
      },
    });
    expect(stagedImmediateQuote.statusCode).toBe(409);
    expect(stagedImmediateQuote.json().code).toBe(
      "IMMEDIATE_PICKUP_REQUIRES_UNSTAGED_FILL",
    );
  });

  it("uses the final active paid claim patient responsibility and rejects non-cash overpayment", async () => {
    const patient = await makePatient("PAID-COPAY1234-3K");
    const prescriptionId = await createPrescription(patient.id, 20);
    const fillId = await createFill(prescriptionId, 20, 20);

    const scanned = await scan(fillId, 20);
    expect(scanned.json().adjudication.state).toBe("PAID_LABEL_READY");
    await makeReady(prescriptionId);
    const staged = await stage(fillId);

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
        ...pickup(fillId, staged.bagBarcode),
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
        ...pickup(fillId, staged.bagBarcode),
        idempotencyKey: `3k-insured-${randomUUID()}`,
      },
    });
    expect(checkout.statusCode).toBe(200);
    expect(Number(checkout.json().transaction.totalDue)).toBe(12.34);
    expect(checkout.json().transaction.lines[0].claimTransactionId).toBe(claim.id);
    expect(
      Number(
        checkout.json().transaction.lines[0].patientResponsibilitySnapshot,
      ),
    ).toBe(12.34);

    const reverse = await app.inject({
      method: "POST",
      url: `/api/third-party/claims/${claim.id}/reverse`,
      headers: pharmacistHeaders,
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
    const stagedPrimary = await stage(fillId);

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
        ...pickup(fillId, stagedPrimary.bagBarcode),
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
    const stagedCompletion = await stage(completionId);

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
        ...pickup(completionId, stagedCompletion.bagBarcode),
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

  it("reverses a paid claim before an abandoned Ready fill is returned to stock", async () => {
    const patient = await makePatient("PAID-COPAY0400-ABANDON-3K");
    const prescriptionId = await createPrescription(patient.id, 12);
    const fillId = await createFill(prescriptionId, 12, 12);

    const scanned = await scan(fillId, 12);
    expect(scanned.json().adjudication.state).toBe("PAID_LABEL_READY");
    await makeReady(prescriptionId);
    await stage(
      fillId,
      `WC-BAG-ABANDON-3K-${randomUUID().slice(0, 8)}`.toUpperCase(),
    );

    const original = await db.claimTransaction.findFirstOrThrow({
      where: { fillId, operation: "SUBMIT", outcome: "PAID" },
    });

    const returned = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/return-to-stock`,
      headers: technicianHeaders,
    });
    expect(returned.statusCode).toBe(200);

    const reversal = await db.claimTransaction.findFirstOrThrow({
      where: {
        originalTransactionId: original.id,
        operation: "REVERSAL",
        outcome: "REVERSED",
      },
    });
    expect(reversal.originalTransactionId).toBe(original.id);

    const fill = await db.prescriptionFill.findUniqueOrThrow({
      where: { id: fillId },
    });
    expect(fill.status).toBe("RETURNED_TO_STOCK");

    const stagedPackage = await db.willCallPackage.findUniqueOrThrow({
      where: { fillId },
    });
    expect(stagedPackage.status).toBe("RETURNED_TO_STOCK");
    expect(stagedPackage.returnedAt).not.toBeNull();

    expect(
      await db.prescriptionLabel.count({
        where: { fillId, status: "ACTIVE" },
      }),
    ).toBe(0);
  });
});
