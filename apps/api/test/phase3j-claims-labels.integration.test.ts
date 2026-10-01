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
let secondaryProductId = "";
let secondaryNdc = "";
let secondaryLotNumber = "";
let secondaryExpirationDate!: Date;
let tertiaryProductId = "";
let tertiaryNdc = "";
let tertiaryLotNumber = "";
let tertiaryExpirationDate!: Date;

async function makePatient(
  memberIds: Array<{
    memberId: string;
    standard: "D0" | "F6";
    billingNdcStrategy?:
      | "MAJORITY_SOURCE"
      | "REQUIRE_MANUAL_SELECTION"
      | "SINGLE_SOURCE_ONLY"
      | "PAYER_CONFIGURED";
  }>,
) {
  const token = randomUUID().slice(0, 8);
  const patient = await db.patient.create({
    data: {
      id: `patient-3j-${randomUUID()}`,
      siteId,
      firstName: "Phase3J",
      lastName: `Regression-${token}`,
      dateOfBirth: new Date("1985-01-01T00:00:00.000Z"),
    },
  });

  for (const [index, item] of memberIds.entries()) {
    const payer = await db.payer.create({
      data: {
        id: `payer-3j-${randomUUID()}`,
        siteId,
        name: `Phase3J P${index + 1} ${token} ${randomUUID().slice(0, 6)}`,
        bin: `9${String(index + 1).padStart(5, "0")}`,
        pcn: "PHASE3J",
        claimStandard: item.standard,
        billingNdcStrategy:
          item.billingNdcStrategy ?? "REQUIRE_MANUAL_SELECTION",
      },
    });
    await db.patientCoverage.create({
      data: {
        siteId,
        patientId: patient.id,
        payerId: payer.id,
        position: index + 1,
        memberId: item.memberId,
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
      rxNumber: `3J-${randomUUID().slice(0, 12)}`,
      sig: "Take one tablet daily",
      quantityWritten: quantity,
      refillsAllowed: 0,
      productSelectionDirective: "SELECTION_PERMITTED",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().prescription.id as string;
}

async function createFill(
  prescriptionId: string,
  quantity: number,
  daysSupply?: number,
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
  return app.inject({
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
}

async function scanSecondary(fillId: string, quantity: number) {
  return app.inject({
    method: "POST",
    url: `/api/fills/${fillId}/scan-product`,
    headers: technicianHeaders,
    payload: {
      ndc: secondaryNdc,
      lotNumber: secondaryLotNumber,
      expirationDate: secondaryExpirationDate.toISOString(),
      sourceQuantity: quantity,
    },
  });
}

async function scanTertiary(fillId: string, quantity: number) {
  return app.inject({
    method: "POST",
    url: `/api/fills/${fillId}/scan-product`,
    headers: technicianHeaders,
    payload: {
      ndc: tertiaryNdc,
      lotNumber: tertiaryLotNumber,
      expirationDate: tertiaryExpirationDate.toISOString(),
      sourceQuantity: quantity,
    },
  });
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
      id: `mfr-3j-${randomUUID()}`,
      name: `Phase3J Manufacturer ${randomUUID().slice(0, 8)}`,
      labelerCode: "88123",
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

  medicationId = `med-3j-${randomUUID()}`;
  await db.medication.create({
    data: {
      id: medicationId,
      genericName: `Phase3J Drug ${token}`,
      strength: "10 mg",
      dosageForm: "tablet",
      route: "oral",
    },
  });

  productId = `product-3j-${randomUUID()}`;
  ndc = `88123-${token}-01`;
  await db.product.create({
    data: {
      id: productId,
      medicationId,
      manufacturerId: manufacturer.id,
      ndc,
      ndcSearch: ndc.replace(/\D/g, ""),
      descriptor: "Phase3J claim regression product",
      packageDescription: "100 count bottle",
      packageType: "bottle",
      unitsPerPackage: 100,
      dispensingUnit: "EACH",
      therapeuticEquivalenceCode: "AB",
    },
  });

  lotNumber = `3JLOT${token}`;
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
      quantity: 1000,
      source: "PHASE3J_TEST",
      reference: randomUUID(),
    }),
  );

  const secondaryManufacturer = await db.manufacturer.create({
    data: {
      id: `mfr-3j-secondary-${randomUUID()}`,
      name: `Phase3J Secondary Manufacturer ${randomUUID().slice(0, 8)}`,
      labelerCode: "88124",
    },
  });

  secondaryProductId = `product-3j-secondary-${randomUUID()}`;
  secondaryNdc = `88124-${token}-02`;
  await db.product.create({
    data: {
      id: secondaryProductId,
      medicationId,
      manufacturerId: secondaryManufacturer.id,
      ndc: secondaryNdc,
      ndcSearch: secondaryNdc.replace(/\D/g, ""),
      descriptor: "Phase3J secondary claim regression product",
      packageDescription: "100 count bottle",
      packageType: "bottle",
      unitsPerPackage: 100,
      dispensingUnit: "EACH",
      therapeuticEquivalenceCode: "AB",
    },
  });

  secondaryLotNumber = `3JLOTB${token}`;
  const secondaryLot = await db.productLot.create({
    data: {
      siteId,
      productId: secondaryProductId,
      lotNumber: secondaryLotNumber,
      lotNumberSearch: secondaryLotNumber.toUpperCase(),
    },
  });
  secondaryExpirationDate = new Date(Date.now() + 540 * 86_400_000);
  secondaryExpirationDate.setUTCHours(0, 0, 0, 0);
  const secondaryExpiration = await db.productExpiration.create({
    data: {
      siteId,
      productId: secondaryProductId,
      expirationDate: secondaryExpirationDate,
    },
  });

  await db.$transaction((tx) =>
    receiveInventory(tx, {
      siteId,
      actorId: technicianId,
      productId: secondaryProductId,
      productLotId: secondaryLot.id,
      productExpirationId: secondaryExpiration.id,
      quantity: 1000,
      source: "PHASE3J_TEST_SECONDARY",
      reference: randomUUID(),
    }),
  );

  const tertiaryManufacturer = await db.manufacturer.create({
    data: {
      id: `mfr-3j-tertiary-${randomUUID()}`,
      name: `Phase3J Tertiary Manufacturer ${randomUUID().slice(0, 8)}`,
      labelerCode: "88125",
    },
  });

  tertiaryProductId = `product-3j-tertiary-${randomUUID()}`;
  tertiaryNdc = `88125-${token}-03`;
  await db.product.create({
    data: {
      id: tertiaryProductId,
      medicationId,
      manufacturerId: tertiaryManufacturer.id,
      ndc: tertiaryNdc,
      ndcSearch: tertiaryNdc.replace(/\D/g, ""),
      descriptor: "Phase3J tertiary claim regression product",
      packageDescription: "100 count bottle",
      packageType: "bottle",
      unitsPerPackage: 100,
      dispensingUnit: "EACH",
      therapeuticEquivalenceCode: "AB",
    },
  });

  tertiaryLotNumber = `3JLOTC${token}`;
  const tertiaryLot = await db.productLot.create({
    data: {
      siteId,
      productId: tertiaryProductId,
      lotNumber: tertiaryLotNumber,
      lotNumberSearch: tertiaryLotNumber.toUpperCase(),
    },
  });
  tertiaryExpirationDate = new Date(Date.now() + 720 * 86_400_000);
  tertiaryExpirationDate.setUTCHours(0, 0, 0, 0);
  const tertiaryExpiration = await db.productExpiration.create({
    data: {
      siteId,
      productId: tertiaryProductId,
      expirationDate: tertiaryExpirationDate,
    },
  });

  await db.$transaction((tx) =>
    receiveInventory(tx, {
      siteId,
      actorId: technicianId,
      productId: tertiaryProductId,
      productLotId: tertiaryLot.id,
      productExpirationId: tertiaryExpiration.id,
      quantity: 1000,
      source: "PHASE3J_TEST_TERTIARY",
      reference: randomUUID(),
    }),
  );
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe("Phase 3J billing, adjudication, and prescription labeling", () => {
  it("requires explicit days supply, then auto-adjudicates a completed Product Fill and queues a label", async () => {
    const patient = await makePatient([{ memberId: "PAID-3J-001", standard: "D0" }]);
    const prescriptionId = await createPrescription(patient.id, 30);
    const fillId = await createFill(prescriptionId, 30);

    const scanned = await scan(fillId, 30);
    expect(scanned.statusCode).toBe(200);
    expect(scanned.json().adjudication.state).toBe("BLOCKED");
    expect(scanned.json().adjudication.code).toBe("DAYS_SUPPLY_REQUIRED");

    const beforeBilling = await db.claimTransaction.count({ where: { fillId } });
    expect(beforeBilling).toBe(0);

    const billing = await app.inject({
      method: "PUT",
      url: `/api/fills/${fillId}/billing-details`,
      headers: technicianHeaders,
      payload: { daysSupply: 30 },
    });
    expect(billing.statusCode).toBe(200);
    expect(billing.json().adjudication.state).toBe("PAID_LABEL_READY");

    const transactions = await db.claimTransaction.findMany({ where: { fillId } });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.operation).toBe("SUBMIT");
    expect(transactions[0]!.outcome).toBe("PAID");
    expect(transactions[0]!.claimStandard).toBe("D0");
    expect(transactions[0]!.payerIntendedQuantity.toNumber()).toBe(30);
    expect(transactions[0]!.physicalPartQuantity.toNumber()).toBe(30);
    expect(transactions[0]!.daysSupply).toBe(30);

    const label = await db.prescriptionLabel.findFirstOrThrow({
      where: { fillId, status: "ACTIVE" },
      include: { printJobs: true },
    });
    expect(label.physicalQuantity.toNumber()).toBe(30);
    expect(label.payerIntendedQuantity?.toNumber()).toBe(30);
    expect(label.printJobs).toHaveLength(1);
    expect(label.printJobs[0]!.status).toBe("QUEUED");

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/adjudicate`,
      headers: technicianHeaders,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(
      await db.claimTransaction.count({
        where: { fillId, operation: "SUBMIT" },
      }),
    ).toBe(1);

    const review = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(review.statusCode).toBe(200);
  });

  it("passes the primary reject to a secondary F6 payer through COB and prints only after a paid response", async () => {
    const patient = await makePatient([
      { memberId: "REJECT-PRIMARY-3J", standard: "D0" },
      { memberId: "PAID-SECONDARY-3J", standard: "F6" },
    ]);
    const prescriptionId = await createPrescription(patient.id, 20);
    const fillId = await createFill(prescriptionId, 20, 10);

    const scanned = await scan(fillId, 20);
    expect(scanned.statusCode).toBe(200);
    expect(scanned.json().adjudication.state).toBe("PAID_LABEL_READY");

    const claims = await db.claimTransaction.findMany({
      where: { fillId, operation: "SUBMIT" },
      orderBy: { coveragePosition: "asc" },
    });
    expect(claims).toHaveLength(2);
    expect(claims.map((claim) => claim.outcome)).toEqual(["REJECTED", "PAID"]);
    expect(claims.map((claim) => claim.claimStandard)).toEqual(["D0", "F6"]);

    const request = claims[1]!.requestSnapshot as {
      priorPayers?: Array<{
        position: number;
        responseStatus: string;
        rejectCodes: string[];
      }>;
    };
    expect(request.priorPayers).toHaveLength(1);
    expect(request.priorPayers?.[0]).toMatchObject({
      position: 1,
      responseStatus: "REJECTED",
      rejectCodes: ["70"],
    });

    expect(
      await db.prescriptionLabel.count({ where: { fillId, status: "ACTIVE" } }),
    ).toBe(1);
  });

  it("routes an unresolved rejection to Third Party and blocks pharmacist review without a paid claim", async () => {
    const patient = await makePatient([
      { memberId: "REJECT-ONLY-3J", standard: "D0" },
    ]);
    const prescriptionId = await createPrescription(patient.id, 15);
    const fillId = await createFill(prescriptionId, 15, 15);

    const scanned = await scan(fillId, 15);
    expect(scanned.statusCode).toBe(200);
    expect(scanned.json().adjudication.state).toBe("REJECTED");
    expect(
      await db.prescriptionLabel.count({ where: { fillId, status: "ACTIVE" } }),
    ).toBe(0);

    const review = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(review.statusCode).toBe(409);
    expect(review.json().code).toBe("CLAIM_PAYMENT_REQUIRED");

    const workspace = await app.inject({
      method: "GET",
      url: "/api/third-party/workspace",
      headers: technicianHeaders,
    });
    expect(workspace.statusCode).toBe(200);
    expect(
      workspace
        .json()
        .claimIssues.some((claim: { fillId: string; outcome: string }) =>
          claim.fillId === fillId && claim.outcome === "REJECTED"),
    ).toBe(true);
  });

  it("preserves one full-quantity payer claim when a scanned fill becomes a physical partial and replaces only the label", async () => {
    const patient = await makePatient([{ memberId: "PAID-PARTIAL-3J", standard: "D0" }]);
    const prescriptionId = await createPrescription(patient.id, 100);
    const fillId = await createFill(prescriptionId, 100, 30);

    const scanned = await scan(fillId, 100);
    expect(scanned.statusCode).toBe(200);
    expect(scanned.json().adjudication.state).toBe("PAID_LABEL_READY");

    const firstClaim = await db.claimTransaction.findFirstOrThrow({
      where: { fillId, operation: "SUBMIT" },
    });
    expect(firstClaim.payerIntendedQuantity.toNumber()).toBe(100);

    const initialLabel = await db.prescriptionLabel.findFirstOrThrow({
      where: { fillId, status: "ACTIVE" },
    });
    expect(initialLabel.physicalQuantity.toNumber()).toBe(100);

    const partial = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/partial`,
      headers: technicianHeaders,
      payload: {
        dispenseQuantity: 40,
        completionScheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        interruptionReason: "INSUFFICIENT_PHYSICAL_STOCK",
        reason: "Physical count changed after scanning.",
      },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json().adjudication.state).toBe("PAID_LABEL_READY");
    expect(Number(partial.json().partialFill.payerIntendedQuantity)).toBe(100);
    expect(Number(partial.json().partialFill.quantity)).toBe(40);
    expect(Number(partial.json().completionFill.quantity)).toBe(60);
    expect(Number(partial.json().completionFill.payerIntendedQuantity)).toBe(100);

    expect(
      await db.claimTransaction.count({
        where: { fillId, operation: "SUBMIT" },
      }),
    ).toBe(1);

    const labels = await db.prescriptionLabel.findMany({
      where: { fillId },
      include: { printJobs: true },
      orderBy: { version: "asc" },
    });
    expect(labels).toHaveLength(2);
    expect(labels[0]!.status).toBe("VOID");
    expect(labels[0]!.physicalQuantity.toNumber()).toBe(100);
    expect(labels[0]!.printJobs[0]!.status).toBe("CANCELLED");
    expect(labels[1]!.status).toBe("ACTIVE");
    expect(labels[1]!.physicalQuantity.toNumber()).toBe(40);
    expect(labels[1]!.payerIntendedQuantity?.toNumber()).toBe(100);
    expect(labels[1]!.printJobs[0]!.status).toBe("QUEUED");
  });

  it("bills the full intended quantity once when the partial is known before scanning and does not rebill the completion", async () => {
    const patient = await makePatient([
      { memberId: "PAID-PRESCAN-PARTIAL-3J", standard: "D0" },
    ]);
    const prescriptionId = await createPrescription(patient.id, 100);
    const fillId = await createFill(prescriptionId, 100, 30);

    const partial = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/partial`,
      headers: technicianHeaders,
      payload: {
        dispenseQuantity: 40,
        completionScheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
        interruptionReason: "INSUFFICIENT_PHYSICAL_STOCK",
        reason: "Only forty tablets are physically available.",
      },
    });
    expect(partial.statusCode).toBe(200);
    const completionId = partial.json().completionFill.id as string;
    expect(Number(partial.json().partialFill.payerIntendedQuantity)).toBe(100);
    expect(Number(partial.json().partialFill.quantity)).toBe(40);
    expect(Number(partial.json().completionFill.quantity)).toBe(60);

    const primaryScan = await scan(fillId, 40);
    expect(primaryScan.statusCode).toBe(200);
    expect(primaryScan.json().adjudication.state).toBe("PAID_LABEL_READY");

    const primaryClaim = await db.claimTransaction.findFirstOrThrow({
      where: { fillId, operation: "SUBMIT", outcome: "PAID" },
    });
    expect(primaryClaim.payerIntendedQuantity.toNumber()).toBe(100);
    expect(primaryClaim.physicalPartQuantity.toNumber()).toBe(40);

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
    const sold = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "SOLD" },
    });
    expect(sold.statusCode).toBe(200);

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
    expect(completionScan.statusCode).toBe(200);
    expect(completionScan.json().adjudication.state).toBe(
      "COMPLETION_LABEL_READY",
    );

    expect(
      await db.claimTransaction.count({
        where: {
          OR: [{ fillId }, { fillId: completionId }],
          operation: "SUBMIT",
        },
      }),
    ).toBe(1);
    expect(
      await db.claimTransaction.count({
        where: { fillId: completionId, operation: "SUBMIT" },
      }),
    ).toBe(0);

    const completionLabel = await db.prescriptionLabel.findFirstOrThrow({
      where: { fillId: completionId, status: "ACTIVE" },
    });
    expect(completionLabel.claimTransactionId).toBe(primaryClaim.id);
    expect(completionLabel.physicalQuantity.toNumber()).toBe(60);
    expect(completionLabel.payerIntendedQuantity?.toNumber()).toBe(100);
  });

  it("records a reversal separately and voids the active dispensing label", async () => {
    const patient = await makePatient([{ memberId: "PAID-REVERSE-3J", standard: "D0" }]);
    const prescriptionId = await createPrescription(patient.id, 10);
    const fillId = await createFill(prescriptionId, 10, 10);

    const scanned = await scan(fillId, 10);
    expect(scanned.statusCode).toBe(200);

    const original = await db.claimTransaction.findFirstOrThrow({
      where: { fillId, operation: "SUBMIT", outcome: "PAID" },
    });

    const billingMutation = await app.inject({
      method: "PUT",
      url: `/api/fills/${fillId}/billing-details`,
      headers: technicianHeaders,
      payload: { daysSupply: 9 },
    });
    expect(billingMutation.statusCode).toBe(409);
    expect(billingMutation.json().code).toBe("PAID_CLAIM_REVERSAL_REQUIRED");

    const source = await db.fillProductSource.findFirstOrThrow({
      where: { fillId },
    });
    const sourceMutation = await app.inject({
      method: "DELETE",
      url: `/api/fills/${fillId}/product-sources/${source.id}`,
      headers: technicianHeaders,
    });
    expect(sourceMutation.statusCode).toBe(409);
    expect(sourceMutation.json().code).toBe("PAID_CLAIM_REVERSAL_REQUIRED");

    const coverageMutation = await app.inject({
      method: "DELETE",
      url: `/api/patients/${patient.id}/coverages/1`,
      headers: technicianHeaders,
    });
    expect(coverageMutation.statusCode).toBe(409);
    expect(coverageMutation.json().code).toBe("PAID_CLAIM_REVERSAL_REQUIRED");

    const reversal = await app.inject({
      method: "POST",
      url: `/api/third-party/claims/${original.id}/reverse`,
      headers: pharmacistHeaders,
    });
    expect(reversal.statusCode).toBe(200);
    expect(reversal.json().transaction.operation).toBe("REVERSAL");
    expect(reversal.json().transaction.outcome).toBe("REVERSED");
    expect(reversal.json().transaction.originalTransactionId).toBe(original.id);

    const label = await db.prescriptionLabel.findFirstOrThrow({
      where: { fillId },
      include: { printJobs: true },
      orderBy: { version: "desc" },
    });
    expect(label.status).toBe("VOID");
    expect(label.printJobs[0]!.status).toBe("CANCELLED");

    const coverageAfterReversal = await app.inject({
      method: "DELETE",
      url: `/api/patients/${patient.id}/coverages/1`,
      headers: technicianHeaders,
    });
    expect(coverageAfterReversal.statusCode).toBe(204);

    const replay = await app.inject({
      method: "POST",
      url: `/api/third-party/claims/${original.id}/reverse`,
      headers: pharmacistHeaders,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect(
      await db.claimTransaction.count({
        where: { originalTransactionId: original.id, outcome: "REVERSED" },
      }),
    ).toBe(1);
  });

  it("automatically bills the majority NDC and re-adjudicates after a Product Fill source correction changes the majority", async () => {
    const patient = await makePatient([
      {
        memberId: "PAID-MAJORITY-3J",
        standard: "D0",
        billingNdcStrategy: "MAJORITY_SOURCE",
      },
    ]);
    const prescriptionId = await createPrescription(patient.id, 90);
    const fillId = await createFill(prescriptionId, 90, 30);

    const firstSource = await scan(fillId, 30);
    expect(firstSource.statusCode).toBe(200);
    expect(firstSource.json().adjudication).toBeNull();

    const completed = await scanSecondary(fillId, 60);
    expect(completed.statusCode).toBe(200);
    expect(completed.json().adjudication.state).toBe("PAID_LABEL_READY");
    expect(completed.json().adjudication.labels).toHaveLength(2);

    const initialLabelSet = await db.prescriptionLabel.findMany({
      where: { fillId, status: "ACTIVE" },
      include: { printJobs: true },
      orderBy: { bottleNumber: "asc" },
    });
    expect(initialLabelSet).toHaveLength(2);
    expect(initialLabelSet[0]!.bottleNumber).toBe(1);
    expect(initialLabelSet[0]!.bottleCount).toBe(2);
    expect(initialLabelSet[0]!.physicalNdcSnapshot).toBe(secondaryNdc);
    expect(initialLabelSet[0]!.containerQuantity.toNumber()).toBe(60);
    expect(initialLabelSet[0]!.physicalQuantity.toNumber()).toBe(90);
    expect(initialLabelSet[0]!.productDescriptionSnapshot).toContain(
      "secondary",
    );
    expect(initialLabelSet[0]!.printJobs).toHaveLength(1);
    expect(initialLabelSet[1]!.bottleNumber).toBe(2);
    expect(initialLabelSet[1]!.bottleCount).toBe(2);
    expect(initialLabelSet[1]!.physicalNdcSnapshot).toBe(ndc);
    expect(initialLabelSet[1]!.containerQuantity.toNumber()).toBe(30);
    expect(initialLabelSet[1]!.physicalQuantity.toNumber()).toBe(90);
    expect(initialLabelSet[1]!.printJobs).toHaveLength(1);

    const firstPaid = await db.claimTransaction.findFirstOrThrow({
      where: {
        fillId,
        operation: "SUBMIT",
        outcome: "PAID",
      },
      orderBy: { createdAt: "asc" },
    });
    expect(firstPaid.billedProductId).toBe(secondaryProductId);
    expect(firstPaid.billedNdc).toBe(secondaryNdc);

    const initialSources = await db.fillProductSource.findMany({
      where: { fillId },
      orderBy: { sequence: "asc" },
    });
    expect(initialSources).toHaveLength(2);

    const removePrimary = await app.inject({
      method: "DELETE",
      url: `/api/fills/${fillId}/product-sources/${initialSources[0]!.id}`,
      headers: technicianHeaders,
    });
    expect(removePrimary.statusCode).toBe(200);

    const reversal = await db.claimTransaction.findFirstOrThrow({
      where: {
        originalTransactionId: firstPaid.id,
        operation: "REVERSAL",
        outcome: "REVERSED",
      },
    });
    expect(reversal.originalTransactionId).toBe(firstPaid.id);

    const remainingSources = await db.fillProductSource.findMany({
      where: { fillId },
      orderBy: { sequence: "asc" },
    });
    expect(remainingSources).toHaveLength(1);

    const removeSecondary = await app.inject({
      method: "DELETE",
      url: `/api/fills/${fillId}/product-sources/${remainingSources[0]!.id}`,
      headers: technicianHeaders,
    });
    expect(removeSecondary.statusCode).toBe(200);

    const correctedMajority = await scan(fillId, 60);
    expect(correctedMajority.statusCode).toBe(200);
    expect(correctedMajority.json().adjudication).toBeNull();

    const correctedComplete = await scanSecondary(fillId, 30);
    expect(correctedComplete.statusCode).toBe(200);
    expect(correctedComplete.json().adjudication.state).toBe("PAID_LABEL_READY");

    const submissions = await db.claimTransaction.findMany({
      where: {
        fillId,
        operation: "SUBMIT",
        outcome: "PAID",
      },
      orderBy: { createdAt: "asc" },
    });
    expect(submissions).toHaveLength(2);
    expect(submissions[0]!.billedProductId).toBe(secondaryProductId);
    expect(submissions[1]!.billedProductId).toBe(productId);
    expect(submissions[1]!.billedNdc).toBe(ndc);
    expect(submissions[1]!.payerIntendedQuantity.toString()).toBe("90");
    expect(submissions[1]!.physicalPartQuantity.toString()).toBe("90");

    const labels = await db.prescriptionLabel.findMany({
      where: { fillId },
      include: { printJobs: true },
      orderBy: [{ version: "asc" }, { bottleNumber: "asc" }],
    });
    expect(labels).toHaveLength(4);
    expect(labels.slice(0, 2).every((label) => label.status === "VOID")).toBe(
      true,
    );
    expect(
      labels
        .slice(0, 2)
        .every((label) => label.printJobs[0]!.status === "CANCELLED"),
    ).toBe(true);

    const replacementLabels = labels.slice(2);
    expect(replacementLabels.every((label) => label.status === "ACTIVE")).toBe(
      true,
    );
    expect(replacementLabels[0]!.version).toBe(replacementLabels[1]!.version);
    expect(replacementLabels[0]!.bottleNumber).toBe(1);
    expect(replacementLabels[0]!.bottleCount).toBe(2);
    expect(replacementLabels[0]!.physicalNdcSnapshot).toBe(ndc);
    expect(replacementLabels[0]!.containerQuantity.toNumber()).toBe(60);
    expect(replacementLabels[0]!.physicalQuantity.toNumber()).toBe(90);
    expect(replacementLabels[0]!.billedNdcSnapshot).toBe(ndc);
    expect(replacementLabels[1]!.bottleNumber).toBe(2);
    expect(replacementLabels[1]!.bottleCount).toBe(2);
    expect(replacementLabels[1]!.physicalNdcSnapshot).toBe(secondaryNdc);
    expect(replacementLabels[1]!.containerQuantity.toNumber()).toBe(30);
    expect(replacementLabels[1]!.physicalQuantity.toNumber()).toBe(90);
    expect(replacementLabels[1]!.billedNdcSnapshot).toBe(ndc);
  });

  it("creates one separately queued bottle label for each of three physical NDCs", async () => {
    const patient = await makePatient([
      {
        memberId: "PAID-THREE-BOTTLES-3J",
        standard: "D0",
        billingNdcStrategy: "MAJORITY_SOURCE",
      },
    ]);
    const prescriptionId = await createPrescription(patient.id, 90);
    const fillId = await createFill(prescriptionId, 90, 30);

    expect((await scan(fillId, 45)).statusCode).toBe(200);
    expect((await scanSecondary(fillId, 30)).statusCode).toBe(200);
    const completed = await scanTertiary(fillId, 15);
    expect(completed.statusCode).toBe(200);
    expect(completed.json().adjudication.state).toBe("PAID_LABEL_READY");
    expect(completed.json().adjudication.labels).toHaveLength(3);
    expect(completed.json().adjudication.printJobs).toHaveLength(3);

    const claim = await db.claimTransaction.findFirstOrThrow({
      where: { fillId, operation: "SUBMIT", outcome: "PAID" },
    });
    expect(claim.billedNdc).toBe(ndc);

    const labelSet = await db.prescriptionLabel.findMany({
      where: { fillId, status: "ACTIVE" },
      include: { printJobs: true },
      orderBy: { bottleNumber: "asc" },
    });
    expect(labelSet).toHaveLength(3);
    expect(labelSet.map((label) => label.bottleNumber)).toEqual([1, 2, 3]);
    expect(labelSet.map((label) => label.bottleCount)).toEqual([3, 3, 3]);
    expect(labelSet.map((label) => label.physicalNdcSnapshot)).toEqual([
      ndc,
      secondaryNdc,
      tertiaryNdc,
    ]);
    expect(labelSet.map((label) => label.containerQuantity.toNumber())).toEqual([
      45,
      30,
      15,
    ]);
    expect(labelSet.map((label) => label.physicalQuantity.toNumber())).toEqual([
      90,
      90,
      90,
    ]);
    expect(
      labelSet.every(
        (label) =>
          label.productDescriptionSnapshot &&
          label.manufacturerSnapshot &&
          label.printJobs.length === 1 &&
          label.printJobs[0]!.status === "QUEUED",
      ),
    ).toBe(true);

    const review = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(review.statusCode).toBe(200);
  });

});
