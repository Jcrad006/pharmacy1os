import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { receiveInventory } from "../src/inventory.js";
import { requireBillingNdcSelection } from "../src/claims/adapter.js";

process.env.ALLOW_DEV_IDENTITY = "true";

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };
const pharmacistHeaders = { "x-dev-user": "dev-pharmacist" };
const siteId = "site-demo-001";
const prescriberId = "prescriber-demo-001";

type ProductFixture = {
  id: string;
  ndc: string;
  manufacturerId: string;
};

type SourceFixture = {
  product: ProductFixture;
  lotNumber: string;
  expirationDate: Date;
  balanceId: string;
};

const ids = {
  patientId: `patient-pre3j-${randomUUID()}`,
  multiMedicationId: `med-pre3j-multi-${randomUUID()}`,
  ntiMedicationId: `med-pre3j-nti-${randomUUID()}`,
  bioMedicationId: `med-pre3j-bio-${randomUUID()}`,
  manufacturerAId: `mfr-pre3j-a-${randomUUID()}`,
  manufacturerBId: `mfr-pre3j-b-${randomUUID()}`,
};

let technicianId = "";
let multiA!: ProductFixture;
let multiB!: ProductFixture;
let ntiA!: ProductFixture;
let ntiB!: ProductFixture;
let bioA!: ProductFixture;
let multiSources: SourceFixture[] = [];
let ntiSources: SourceFixture[] = [];
let bioSource!: SourceFixture;

beforeAll(async () => {
  await app.ready();

  const technician = await db.user.findFirstOrThrow({
    where: { externalAuthId: "dev-technician", siteId },
  });
  technicianId = technician.id;

  const token = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const digits = String(
    Array.from(token).reduce((sum, char) => sum + char.charCodeAt(0), 0),
  )
    .padStart(4, "0")
    .slice(-4);

  await db.patient.create({
    data: {
      id: ids.patientId,
      siteId,
      firstName: "Pre3J",
      lastName: `Regression-${token}`,
      dateOfBirth: new Date("1980-01-01T00:00:00.000Z"),
      phone: "555-0199",
      phoneSearch: "5550199",
    },
  });

  await db.manufacturer.createMany({
    data: [
      {
        id: ids.manufacturerAId,
        name: `Pre3J Manufacturer A ${token}`,
        labelerCode: "88000",
      },
      {
        id: ids.manufacturerBId,
        name: `Pre3J Manufacturer B ${token}`,
        labelerCode: "88001",
      },
    ],
  });

  await db.medication.createMany({
    data: [
      {
        id: ids.multiMedicationId,
        genericName: `Pre3J Multi Source ${token}`,
        strength: "10 mg",
        dosageForm: "tablet",
        route: "oral",
      },
      {
        id: ids.ntiMedicationId,
        genericName: `Pre3J NTI ${token}`,
        strength: "1 mg",
        dosageForm: "tablet",
        route: "oral",
        ncNarrowTherapeuticIndex: true,
      },
      {
        id: ids.bioMedicationId,
        genericName: `Pre3J Biologic ${token}`,
        strength: "100 mg/mL",
        dosageForm: "prefilled syringe",
        route: "subcutaneous",
        isBiological: true,
        hasFdaInterchangeableBiologicAlternative: true,
      },
    ],
  });

  const makeNdc = (labeler: string, product: string) =>
    `${labeler}-${product}-01`;
  const makeNdcSearch = (ndc: string) => ndc.replace(/\D/g, "");

  const productRows = [
    {
      id: `product-pre3j-multi-a-${randomUUID()}`,
      medicationId: ids.multiMedicationId,
      manufacturerId: ids.manufacturerAId,
      ndc: makeNdc("88000", digits),
      descriptor: "Pre3J Multi Source A",
      therapeuticEquivalenceCode: "AB",
    },
    {
      id: `product-pre3j-multi-b-${randomUUID()}`,
      medicationId: ids.multiMedicationId,
      manufacturerId: ids.manufacturerBId,
      ndc: makeNdc("88001", digits),
      descriptor: "Pre3J Multi Source B",
      therapeuticEquivalenceCode: "AB",
    },
    {
      id: `product-pre3j-nti-a-${randomUUID()}`,
      medicationId: ids.ntiMedicationId,
      manufacturerId: ids.manufacturerAId,
      ndc: makeNdc("88002", digits),
      descriptor: "Pre3J NTI A",
      therapeuticEquivalenceCode: "AB",
    },
    {
      id: `product-pre3j-nti-b-${randomUUID()}`,
      medicationId: ids.ntiMedicationId,
      manufacturerId: ids.manufacturerBId,
      ndc: makeNdc("88003", digits),
      descriptor: "Pre3J NTI B",
      therapeuticEquivalenceCode: "AB",
    },
    {
      id: `product-pre3j-bio-a-${randomUUID()}`,
      medicationId: ids.bioMedicationId,
      manufacturerId: ids.manufacturerAId,
      ndc: makeNdc("88004", digits),
      descriptor: "Pre3J Biologic A",
      therapeuticEquivalenceCode: null,
      isInterchangeableBiological: true,
    },
  ];

  for (const row of productRows) {
    await db.product.create({
      data: {
        ...row,
        ndcSearch: makeNdcSearch(row.ndc),
        packageDescription: "Synthetic test package",
        packageType: "package",
        unitsPerPackage: 100,
        dispensingUnit: "EACH",
      },
    });
  }

  multiA = {
    id: productRows[0]!.id,
    ndc: productRows[0]!.ndc,
    manufacturerId: ids.manufacturerAId,
  };
  multiB = {
    id: productRows[1]!.id,
    ndc: productRows[1]!.ndc,
    manufacturerId: ids.manufacturerBId,
  };
  ntiA = {
    id: productRows[2]!.id,
    ndc: productRows[2]!.ndc,
    manufacturerId: ids.manufacturerAId,
  };
  ntiB = {
    id: productRows[3]!.id,
    ndc: productRows[3]!.ndc,
    manufacturerId: ids.manufacturerBId,
  };
  bioA = {
    id: productRows[4]!.id,
    ndc: productRows[4]!.ndc,
    manufacturerId: ids.manufacturerAId,
  };

  function futureExpiration(days: number) {
    const date = new Date(Date.now() + days * 86_400_000);
    date.setUTCHours(0, 0, 0, 0);
    return date;
  }

  async function createSource(
    product: ProductFixture,
    lotNumber: string,
    expirationDate: Date,
    quantity = 250,
  ): Promise<SourceFixture> {
    const lot = await db.productLot.create({
      data: {
        siteId,
        productId: product.id,
        lotNumber,
        lotNumberSearch: lotNumber.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
      },
    });
    const expiration = await db.productExpiration.upsert({
      where: {
        siteId_productId_expirationDate: {
          siteId,
          productId: product.id,
          expirationDate,
        },
      },
      update: { active: true },
      create: {
        siteId,
        productId: product.id,
        expirationDate,
      },
    });
    const received = await db.$transaction((tx) =>
      receiveInventory(tx, {
        siteId,
        actorId: technicianId,
        productId: product.id,
        productLotId: lot.id,
        productExpirationId: expiration.id,
        quantity,
        source: "PRE3J_REGRESSION",
        reference: token,
      }),
    );
    return {
      product,
      lotNumber,
      expirationDate,
      balanceId: received.balance.id,
    };
  }

  const earlyExpiration = futureExpiration(180);
  const lateExpiration = futureExpiration(500);

  multiSources = [
    await createSource(multiA, `MULTI-A1-${token}`, earlyExpiration),
    await createSource(multiA, `MULTI-A2-${token}`, earlyExpiration),
    await createSource(multiB, `MULTI-B1-${token}`, lateExpiration),
    await createSource(multiB, `MULTI-B2-${token}`, lateExpiration),
  ];
  ntiSources = [
    await createSource(ntiA, `NTI-A-${token}`, lateExpiration),
    await createSource(ntiB, `NTI-B-${token}`, lateExpiration),
  ];
  bioSource = await createSource(
    bioA,
    `BIO-A-${token}`,
    lateExpiration,
    500,
  );
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

async function createPrescription(input: {
  medicationId: string;
  quantity: number;
  refillsAllowed?: number;
  prescribedProductId?: string;
  productSelectionDirective?: "UNSPECIFIED" | "SELECTION_PERMITTED" | "DISPENSE_AS_WRITTEN";
}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId: ids.patientId,
      prescriberId,
      medicationId: input.medicationId,
      rxNumber: `PRE3J-${randomUUID().slice(0, 12)}`,
      sig: "Use as directed",
      quantityWritten: input.quantity,
      refillsAllowed: input.refillsAllowed ?? 0,
      prescribedProductId: input.prescribedProductId,
      productSelectionDirective:
        input.productSelectionDirective ?? "SELECTION_PERMITTED",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().prescription.id as string;
}

async function createInProgressFill(
  prescriptionId: string,
  quantity: number,
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
    payload: { quantity },
  });
  expect(fill.statusCode).toBe(201);
  return fill.json().fill.id as string;
}

async function scanSource(
  fillId: string,
  source: SourceFixture,
  sourceQuantity: number,
) {
  return app.inject({
    method: "POST",
    url: `/api/fills/${fillId}/scan-product`,
    headers: technicianHeaders,
    payload: {
      ndc: source.product.ndc,
      lotNumber: source.lotNumber,
      expirationDate: source.expirationDate.toISOString(),
      sourceQuantity,
    },
  });
}

async function moveToReady(prescriptionId: string) {
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

async function sell(prescriptionId: string) {
  const sold = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: technicianHeaders,
    payload: { status: "SOLD" },
  });
  expect(sold.statusCode).toBe(200);
}

describe("Pre-3J COB, split-source filling, and NC compliance hardening", () => {
  it("supports four ordered COB coverages and rejects a fifth position", async () => {
    const cobPatient = await db.patient.create({
      data: {
        siteId,
        firstName: "COB",
        lastName: `Regression-${randomUUID().slice(0, 8)}`,
        dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
      },
    });
    const payerIds: string[] = [];
    for (let position = 1; position <= 4; position += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/api/third-party/payers",
        headers: pharmacistHeaders,
        payload: {
          name: `Pre3J Payer ${randomUUID()} position ${position}`,
          bin: `9${position}000${position}`,
          pcn: `PCN${position}`,
          defaultGroupId: `GROUP-${position}`,
          claimStandard: position === 4 ? "F6" : "D0",
          billingNdcStrategy:
            position === 3 ? "SINGLE_SOURCE_ONLY" : "REQUIRE_MANUAL_SELECTION",
        },
      });
      expect(created.statusCode).toBe(201);
      payerIds.push(created.json().payer.id as string);

      const coverage = await app.inject({
        method: "PUT",
        url: `/api/patients/${cobPatient.id}/coverages/${position}`,
        headers: technicianHeaders,
        payload: {
          payerId: payerIds[position - 1],
          memberId: `MEMBER-${position}`,
          relationship: position === 1 ? "SELF" : "OTHER",
        },
      });
      expect(coverage.statusCode).toBe(200);
      expect(coverage.json().coverage.position).toBe(position);
      expect(coverage.json().coverage.groupId).toBe(`GROUP-${position}`);
    }

    const invalid = await app.inject({
      method: "PUT",
      url: `/api/patients/${cobPatient.id}/coverages/5`,
      headers: technicianHeaders,
      payload: { payerId: payerIds[0], memberId: "TOO-MANY" },
    });
    expect(invalid.statusCode).toBe(400);

    const listed = await app.inject({
      method: "GET",
      url: `/api/patients/${cobPatient.id}/coverages`,
      headers: technicianHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed.json().coverages.map((item: { position: number }) => item.position),
    ).toEqual([1, 2, 3, 4]);

    const workspace = await app.inject({
      method: "GET",
      url: "/api/third-party/workspace?query=Regression",
      headers: technicianHeaders,
    });
    expect(workspace.statusCode).toBe(200);
    expect(workspace.json().maxCoveragePositions).toBe(4);
    const patient = workspace
      .json()
      .patients.find((item: { id: string }) => item.id === cobPatient.id);
    expect(patient).toBeTruthy();
    expect(patient.coverages).toHaveLength(4);
    expect(patient.coverages[3].payer.claimStandard).toBe("F6");
  });

  it("keeps the claim adapter strict about billed NDC selection", () => {
    expect(
      requireBillingNdcSelection({
        physicalSources: [{ productId: multiA.id, quantity: 100 }],
        billingNdcStrategy: "REQUIRE_MANUAL_SELECTION",
      }),
    ).toBe(multiA.id);

    expect(() =>
      requireBillingNdcSelection({
        physicalSources: [
          { productId: multiA.id, quantity: 50 },
          { productId: multiB.id, quantity: 50 },
        ],
        billingNdcStrategy: "REQUIRE_MANUAL_SELECTION",
      }),
    ).toThrow(/explicitly selected/i);

    expect(() =>
      requireBillingNdcSelection({
        physicalSources: [
          { productId: multiA.id, quantity: 50 },
          { productId: multiB.id, quantity: 50 },
        ],
        billingProductId: multiA.id,
        billingNdcStrategy: "SINGLE_SOURCE_ONLY",
      }),
    ).toThrow(/does not permit a split-product/i);

    expect(
      requireBillingNdcSelection({
        physicalSources: [
          { productId: multiA.id, quantity: 50 },
          { productId: multiB.id, quantity: 50 },
        ],
        billingProductId: multiB.id,
        billingNdcStrategy: "REQUIRE_MANUAL_SELECTION",
      }),
    ).toBe(multiB.id);

    expect(
      requireBillingNdcSelection({
        physicalSources: [
          { productId: multiA.id, quantity: 30 },
          { productId: multiA.id, quantity: 10 },
          { productId: multiB.id, quantity: 60 },
        ],
        billingNdcStrategy: "MAJORITY_SOURCE",
      }),
    ).toBe(multiB.id);

    expect(() =>
      requireBillingNdcSelection({
        physicalSources: [
          { productId: multiA.id, quantity: 45 },
          { productId: multiB.id, quantity: 45 },
        ],
        billingNdcStrategy: "MAJORITY_SOURCE",
      }),
    ).toThrow(/exact quantity tie/i);

    expect(
      requireBillingNdcSelection({
        physicalSources: [
          { productId: multiA.id, quantity: 45 },
          { productId: multiB.id, quantity: 45 },
        ],
        billingProductId: multiA.id,
        billingNdcStrategy: "MAJORITY_SOURCE",
      }),
    ).toBe(multiA.id);
  });

  it("requires all physical source quantities, caps a dispense part at four sources, commits every source, and returns every source to stock", async () => {
    const prescriptionId = await createPrescription({
      medicationId: ids.multiMedicationId,
      quantity: 100,
    });
    const fillId = await createInProgressFill(prescriptionId, 100);

    const startingBalances = new Map<string, number>();
    for (const source of multiSources) {
      const balance = await db.inventoryBalance.findUniqueOrThrow({
        where: { id: source.balanceId },
      });
      startingBalances.set(source.balanceId, balance.onHandQuantity.toNumber());
    }

    for (const [index, quantity] of [10, 20, 30].entries()) {
      const scanned = await scanSource(
        fillId,
        multiSources[index]!,
        quantity,
      );
      expect(scanned.statusCode).toBe(200);
    }

    const incompleteReview = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(incompleteReview.statusCode).toBe(409);
    expect(incompleteReview.json().code).toBe("PRODUCT_SCAN_REQUIRED");

    const fourth = await scanSource(fillId, multiSources[3]!, 40);
    expect(fourth.statusCode).toBe(200);
    expect(fourth.json().fill.productSources).toHaveLength(4);
    expect(fourth.json().fill.billingProductId).toBeNull();

    const extraQuantity = await scanSource(fillId, multiSources[0]!, 1);
    expect(extraQuantity.statusCode).toBe(400);
    expect(extraQuantity.json().code).toBe("INVALID_FILL_SOURCE_QUANTITY");

    const invalidBilling = await app.inject({
      method: "PUT",
      url: `/api/fills/${fillId}/billing-product`,
      headers: technicianHeaders,
      payload: { productId: "product-demo-atorvastatin-a" },
    });
    expect(invalidBilling.statusCode).toBe(409);

    const selectedBilling = await app.inject({
      method: "PUT",
      url: `/api/fills/${fillId}/billing-product`,
      headers: technicianHeaders,
      payload: { productId: multiB.id },
    });
    expect(selectedBilling.statusCode).toBe(200);
    expect(selectedBilling.json().fill.billingProductId).toBe(multiB.id);

    await moveToReady(prescriptionId);

    const committedFill = await db.prescriptionFill.findUniqueOrThrow({
      where: { id: fillId },
      include: {
        productSources: { orderBy: { sequence: "asc" } },
        inventoryAllocations: true,
      },
    });
    expect(committedFill.inventoryCommittedAt).toBeTruthy();
    expect(committedFill.productSources).toHaveLength(4);
    expect(committedFill.productSources.every((source) => source.committedAt)).toBe(
      true,
    );
    expect(committedFill.inventoryAllocations).toHaveLength(4);
    expect(
      committedFill.inventoryAllocations.every(
        (allocation) => allocation.status === "COMMITTED",
      ),
    ).toBe(true);
    expect(committedFill.patientDiscardDate?.toISOString()).toBe(
      multiSources[0]!.expirationDate.toISOString(),
    );

    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "CANCELLED" },
    });
    expect(cancelled.statusCode).toBe(200);

    const returnedAllocations = await db.inventoryAllocation.findMany({
      where: { fillId },
    });
    expect(returnedAllocations).toHaveLength(4);
    expect(
      returnedAllocations.every((allocation) => allocation.status === "RETURNED"),
    ).toBe(true);

    const returnedSources = await db.fillProductSource.findMany({
      where: { fillId },
    });
    expect(returnedSources).toHaveLength(4);
    expect(returnedSources.every((source) => source.returnedAt)).toBe(true);

    for (const source of multiSources) {
      const balance = await db.inventoryBalance.findUniqueOrThrow({
        where: { id: source.balanceId },
      });
      expect(balance.onHandQuantity.toNumber()).toBe(
        startingBalances.get(source.balanceId),
      );
      expect(balance.reservedQuantity.toNumber()).toBe(0);
    }
  });

  it("caps an incompletely sourced dispense part at four physical sources", async () => {
    const prescriptionId = await createPrescription({
      medicationId: ids.multiMedicationId,
      quantity: 110,
    });
    const fillId = await createInProgressFill(prescriptionId, 110);

    for (const [index, quantity] of [10, 20, 30, 40].entries()) {
      const scanned = await scanSource(
        fillId,
        multiSources[index]!,
        quantity,
      );
      expect(scanned.statusCode).toBe(200);
    }

    const fifth = await scanSource(fillId, multiSources[0]!, 10);
    expect(fifth.statusCode).toBe(409);
    expect(fifth.json().code).toBe("FILL_SOURCE_LIMIT_REACHED");

    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "CANCELLED" },
    });
    expect(cancelled.statusCode).toBe(200);
  });

  it("enforces prescriber DAW product selection before inventory can be reserved", async () => {
    const prescriptionId = await createPrescription({
      medicationId: ids.multiMedicationId,
      quantity: 10,
      prescribedProductId: multiA.id,
      productSelectionDirective: "DISPENSE_AS_WRITTEN",
    });
    const fillId = await createInProgressFill(prescriptionId, 10);

    const wrongProduct = await scanSource(fillId, multiSources[2]!, 10);
    expect(wrongProduct.statusCode).toBe(409);
    expect(wrongProduct.json().code).toBe("DAW_PRODUCT_SELECTION_BLOCKED");

    const correctProduct = await scanSource(fillId, multiSources[0]!, 10);
    expect(correctProduct.statusCode).toBe(200);

    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "CANCELLED" },
    });
    expect(cancelled.statusCode).toBe(200);
  });

  it("preserves split-source traceability when an already-scanned fill is interrupted to a physical partial", async () => {
    const prescriptionId = await createPrescription({
      medicationId: ids.multiMedicationId,
      quantity: 100,
    });
    const fillId = await createInProgressFill(prescriptionId, 100);

    expect((await scanSource(fillId, multiSources[0]!, 40)).statusCode).toBe(200);
    expect((await scanSource(fillId, multiSources[3]!, 60)).statusCode).toBe(200);

    const partial = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/partial`,
      headers: technicianHeaders,
      payload: {
        dispenseQuantity: 50,
        completionScheduledFor: new Date(
          Date.now() + 86_400_000,
        ).toISOString(),
        interruptionReason: "INSUFFICIENT_PHYSICAL_STOCK",
        reason:
          "Physical count changed after scanning; preserve payer intent and resize physical sources.",
      },
    });
    expect(partial.statusCode).toBe(200);
    expect(Number(partial.json().partialFill.quantity)).toBe(50);
    expect(Number(partial.json().partialFill.payerIntendedQuantity)).toBe(100);
    expect(Number(partial.json().partialFill.remainingOwedQuantity)).toBe(50);
    expect(Number(partial.json().completionFill.quantity)).toBe(50);
    expect(Number(partial.json().completionFill.payerIntendedQuantity)).toBe(100);

    const sources = await db.fillProductSource.findMany({
      where: { fillId },
      orderBy: { sequence: "asc" },
    });
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.productId)).toEqual([
      multiA.id,
      multiB.id,
    ]);
    expect(sources.map((source) => source.quantity.toNumber())).toEqual([
      40,
      10,
    ]);

    const allocations = await db.inventoryAllocation.findMany({
      where: { fillId },
      orderBy: { createdAt: "asc" },
    });
    expect(allocations).toHaveLength(4);
    expect(allocations.slice(0, 2).map((item) => item.status)).toEqual([
      "RELEASED",
      "RELEASED",
    ]);
    expect(allocations.slice(2).map((item) => item.status)).toEqual([
      "ACTIVE",
      "ACTIVE",
    ]);
    expect(
      allocations
        .filter((item) => item.status === "ACTIVE")
        .reduce((sum, item) => sum + item.quantity.toNumber(), 0),
    ).toBe(50);

    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "CANCELLED" },
    });
    expect(cancelled.statusCode).toBe(200);
  });

  it("matches a recalled secondary split source on sold fills and invalidates active split reservations", async () => {
    const soldPrescriptionId = await createPrescription({
      medicationId: ids.multiMedicationId,
      quantity: 20,
    });
    const soldFillId = await createInProgressFill(soldPrescriptionId, 20);
    expect((await scanSource(soldFillId, multiSources[0]!, 10)).statusCode).toBe(
      200,
    );
    expect((await scanSource(soldFillId, multiSources[2]!, 10)).statusCode).toBe(
      200,
    );
    await moveToReady(soldPrescriptionId);
    await sell(soldPrescriptionId);

    const activePrescriptionId = await createPrescription({
      medicationId: ids.multiMedicationId,
      quantity: 20,
    });
    const activeFillId = await createInProgressFill(activePrescriptionId, 20);
    expect(
      (await scanSource(activeFillId, multiSources[0]!, 10)).statusCode,
    ).toBe(200);
    expect(
      (await scanSource(activeFillId, multiSources[2]!, 10)).statusCode,
    ).toBe(200);

    const review = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${activePrescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(review.statusCode).toBe(200);

    const recalledSource = multiSources[2]!;
    const recall = await app.inject({
      method: "POST",
      url: "/api/inventory/recalls",
      headers: pharmacistHeaders,
      payload: {
        productId: recalledSource.product.id,
        lotNumber: recalledSource.lotNumber,
        reference: `PRE3J-RECALL-${randomUUID()}`,
        reason:
          "Synthetic regression recall for a secondary NDC/lot in a split fill.",
      },
    });
    expect(recall.statusCode).toBe(201);
    expect(Number(recall.json().summary.reservedAffectedQuantity)).toBe(10);
    expect(recall.json().summary.invalidatedReservedFillCount).toBe(1);
    expect(recall.json().summary.affectedSoldFillCount).toBe(1);
    const recallId = recall.json().recall.id as string;

    const affected = await db.recallAffectedFill.findUnique({
      where: {
        recallCaseId_fillId: {
          recallCaseId: recallId,
          fillId: soldFillId,
        },
      },
    });
    expect(affected).toBeTruthy();

    const resetPrescription = await db.prescription.findUniqueOrThrow({
      where: { id: activePrescriptionId },
    });
    expect(resetPrescription.status).toBe("PRODUCT_FILL");

    const resetFill = await db.prescriptionFill.findUniqueOrThrow({
      where: { id: activeFillId },
      include: {
        productSources: true,
        inventoryAllocations: true,
      },
    });
    expect(resetFill.productSources).toHaveLength(0);
    expect(resetFill.inventoryReservedAt).toBeNull();
    expect(resetFill.productVerifiedAt).toBeNull();
    expect(
      resetFill.inventoryAllocations.filter(
        (allocation) => allocation.status === "ACTIVE",
      ),
    ).toHaveLength(0);
    expect(
      resetFill.inventoryAllocations.filter(
        (allocation) => allocation.status === "RELEASED",
      ),
    ).toHaveLength(2);

    const blocked = await scanSource(activeFillId, recalledSource, 20);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("INVENTORY_RECALLED");

    const safeReplacement = await scanSource(
      activeFillId,
      multiSources[1]!,
      20,
    );
    expect(safeReplacement.statusCode).toBe(200);

    const cancelled = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${activePrescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "CANCELLED" },
    });
    expect(cancelled.statusCode).toBe(200);
  });

  it("requires documented prescriber and patient consent before an NTI manufacturer change on continuing therapy", async () => {
    const firstPrescriptionId = await createPrescription({
      medicationId: ids.ntiMedicationId,
      quantity: 10,
    });
    const firstFillId = await createInProgressFill(firstPrescriptionId, 10);
    const firstScan = await scanSource(firstFillId, ntiSources[0]!, 10);
    expect(firstScan.statusCode).toBe(200);
    await moveToReady(firstPrescriptionId);
    await sell(firstPrescriptionId);

    const nextPrescriptionId = await createPrescription({
      medicationId: ids.ntiMedicationId,
      quantity: 10,
    });
    const nextFillId = await createInProgressFill(nextPrescriptionId, 10);

    const blocked = await scanSource(nextFillId, ntiSources[1]!, 10);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("NC_NTI_MANUFACTURER_CONSENT_REQUIRED");
    expect(blocked.json().details.priorManufacturerId).toBe(
      ids.manufacturerAId,
    );
    expect(blocked.json().details.newManufacturerId).toBe(
      ids.manufacturerBId,
    );

    const documentedAt = new Date().toISOString();
    const consent = await app.inject({
      method: "POST",
      url: `/api/fills/${nextFillId}/nti-manufacturer-consent`,
      headers: pharmacistHeaders,
      payload: {
        priorManufacturerId: ids.manufacturerAId,
        newManufacturerId: ids.manufacturerBId,
        prescriberConsentAt: documentedAt,
        patientConsentAt: documentedAt,
        note: "Prescriber notified before dispensing; prescriber and patient consent documented.",
      },
    });
    expect(consent.statusCode).toBe(201);

    const permitted = await scanSource(nextFillId, ntiSources[1]!, 10);
    expect(permitted.statusCode).toBe(200);
  });

  it("creates the required biologic communication work item and exempts an unchanged refill", async () => {
    const prescriptionId = await createPrescription({
      medicationId: ids.bioMedicationId,
      quantity: 10,
      refillsAllowed: 1,
    });
    const firstFillId = await createInProgressFill(prescriptionId, 10);

    const firstScan = await scanSource(firstFillId, bioSource, 10);
    expect(firstScan.statusCode).toBe(200);
    await moveToReady(prescriptionId);

    const task = await db.biologicCommunicationTask.findUnique({
      where: { fillId: firstFillId },
    });
    expect(task).toBeTruthy();
    expect(task?.status).toBe("OPEN");
    expect(task?.productName).toBe("Pre3J Biologic A");

    const exceptions = await app.inject({
      method: "GET",
      url: "/api/exceptions?kind=BIOLOGIC_COMMUNICATION",
      headers: pharmacistHeaders,
    });
    expect(exceptions.statusCode).toBe(200);
    expect(
      exceptions
        .json()
        .exceptions.some(
          (item: { prescriptionId: string }) =>
            item.prescriptionId === prescriptionId,
        ),
    ).toBe(true);

    const completed = await app.inject({
      method: "POST",
      url: `/api/fills/${firstFillId}/biologic-communication/complete`,
      headers: pharmacistHeaders,
      payload: {
        note: "Product name and manufacturer communicated through an electronically accessible pharmacy record.",
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().task.status).toBe("COMPLETED");

    await sell(prescriptionId);

    const refillDur = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "DUR_REVIEW" },
    });
    expect(refillDur.statusCode).toBe(200);

    const refill = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/fills`,
      headers: technicianHeaders,
      payload: { quantity: 10 },
    });
    expect(refill.statusCode).toBe(201);
    const refillId = refill.json().fill.id as string;

    const refillScan = await scanSource(refillId, bioSource, 10);
    expect(refillScan.statusCode).toBe(200);
    await moveToReady(prescriptionId);

    const unchangedRefillTask = await db.biologicCommunicationTask.findUnique({
      where: { fillId: refillId },
    });
    expect(unchangedRefillTask).toBeNull();
  });
});
