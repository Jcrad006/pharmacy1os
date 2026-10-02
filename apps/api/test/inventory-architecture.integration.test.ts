import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { reconcileDemandAvailability } from "../src/inventoryArchitecture.js";

process.env.ALLOW_DEV_IDENTITY = "true";

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

describe("Phase 3H inventory architecture hardening", () => {
  it("applies product policy, recommends FEFO stock, creates reorder demand, and resolves receiving discrepancies", async () => {
    const suffix = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    const medicationId = `med-arch-${randomUUID()}`;
    const productId = `product-arch-${randomUUID()}`;
    const ndcSearch = `8${suffix}0001`.padEnd(11, "0").slice(0, 11);
    const gtin = gs1WithCheckDigit(`0088888${suffix}`);

    await db.medication.create({
      data: {
        id: medicationId,
        genericName: `Architecture Test Drug ${suffix}`,
        strength: "10 mg",
        dosageForm: "tablet",
        route: "oral",
      },
    });

    await db.product.create({
      data: {
        id: productId,
        medicationId,
        manufacturerId: "manufacturer-demo-generics",
        ndc: ndcSearch,
        ndcSearch,
        descriptor: "Architecture test bottle",
        packageDescription: "Bottle",
        packageType: "bottle",
        unitsPerPackage: 100,
        dispensingUnit: "EACH",
        active: true,
      },
    });

    const lotEarly = `ARCH-E-${suffix}`;
    const lotLater = `ARCH-L-${suffix}`;
    const rawEarly = `(01)${gtin}(17)270131(10)${lotEarly}`;
    const rawLater = `(01)${gtin}(17)270630(10)${lotLater}`;

    const assigned = await app.inject({
      method: "POST",
      url: "/api/receiving/assign",
      headers: tech,
      payload: {
        rawBarcode: rawEarly,
        productId,
        isPrimary: false,
      },
    });
    expect(assigned.statusCode).toBe(201);

    const firstReceipt = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: tech,
      payload: {
        rawBarcode: rawEarly,
        quantity: 10,
        source: "Architecture Test Supplier",
        reference: `EARLY-${suffix}`,
        unitCost: 0.2,
        idempotencyKey: `arch-early-${suffix}`,
      },
    });
    expect(firstReceipt.statusCode).toBe(201);

    const conflictingReplay = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: tech,
      payload: {
        rawBarcode: rawEarly,
        quantity: 11,
        source: "Architecture Test Supplier",
        reference: `EARLY-CONFLICT-${suffix}`,
        unitCost: 0.2,
        idempotencyKey: `arch-early-${suffix}`,
      },
    });
    expect(conflictingReplay.statusCode).toBe(409);
    expect(conflictingReplay.json().code).toBe("IDEMPOTENCY_KEY_CONFLICT");

    const secondReceipt = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: tech,
      payload: {
        rawBarcode: rawLater,
        quantity: 20,
        source: "Architecture Test Supplier",
        reference: `LATER-${suffix}`,
        unitCost: 0.18,
        idempotencyKey: `arch-later-${suffix}`,
      },
    });
    expect(secondReceipt.statusCode).toBe(201);

    const savedPolicy = await app.inject({
      method: "PUT",
      url: `/api/inventory/policies/${encodeURIComponent(
        `PRODUCT:${productId}`,
      )}`,
      headers: pharmacist,
      payload: {
        scope: "PRODUCT",
        productId,
        reorderPoint: 50,
        targetStockLevel: 100,
        minShelfLifeDays: 30,
        expirationWarningDays: 90,
        fefoEnabled: true,
      },
    });
    expect(savedPolicy.statusCode).toBe(200);
    expect(Number(savedPolicy.json().policy.reorderPoint)).toBe(50);

    const fefo = await app.inject({
      method: "GET",
      url: `/api/inventory/fefo?productId=${encodeURIComponent(
        productId,
      )}&quantity=15`,
      headers: tech,
    });
    expect(fefo.statusCode).toBe(200);
    expect(Number(fefo.json().recommendedQuantity)).toBe(15);
    expect(Number(fefo.json().shortageQuantity)).toBe(0);
    expect(fefo.json().picks[0].lotNumber).toBe(lotEarly);
    expect(Number(fefo.json().picks[0].quantity)).toBe(10);
    expect(fefo.json().picks[1].lotNumber).toBe(lotLater);
    expect(Number(fefo.json().picks[1].quantity)).toBe(5);

    const exceptionRefresh = await app.inject({
      method: "GET",
      url: "/api/inventory/exceptions",
      headers: pharmacist,
    });
    expect(exceptionRefresh.statusCode).toBe(200);
    const reorderException = exceptionRefresh
      .json()
      .exceptions.find(
        (item: { type: string; entityId: string | null }) =>
          item.type === "BELOW_REORDER_POINT" &&
          item.entityId === productId,
      );
    expect(reorderException).toBeTruthy();

    const demand = await db.inventoryDemand.findFirst({
      where: {
        siteId: "site-demo-001",
        productId,
        source: "REORDER",
        status: "OPEN",
      },
    });
    expect(demand).toBeTruthy();
    expect(demand?.requiredQuantity.toNumber()).toBe(70);
    expect(demand?.availableQuantity.toNumber()).toBe(30);

    const discrepancy = await app.inject({
      method: "POST",
      url: "/api/inventory/discrepancies",
      headers: tech,
      payload: {
        type: "SHORT_SHIPMENT",
        expectedProductId: productId,
        expectedQuantity: 25,
        observedQuantity: 20,
        note: "Wholesaler carton was five tablets short.",
      },
    });
    expect(discrepancy.statusCode).toBe(201);
    const discrepancyId = discrepancy.json().discrepancy.id as string;

    const techResolve = await app.inject({
      method: "POST",
      url: `/api/inventory/discrepancies/${discrepancyId}/resolve`,
      headers: tech,
      payload: {
        resolutionNote: "Technician should not resolve this discrepancy.",
      },
    });
    expect(techResolve.statusCode).toBe(403);

    const pharmacistResolve = await app.inject({
      method: "POST",
      url: `/api/inventory/discrepancies/${discrepancyId}/resolve`,
      headers: pharmacist,
      payload: {
        resolutionNote:
          "Wholesaler credit requested and discrepancy documented.",
      },
    });
    expect(pharmacistResolve.statusCode).toBe(200);
    expect(pharmacistResolve.json().discrepancy.status).toBe("RESOLVED");

    const policies = await app.inject({
      method: "GET",
      url: "/api/inventory/policies",
      headers: pharmacist,
    });
    expect(policies.statusCode).toBe(200);
    expect(
      policies
        .json()
        .policies.some(
          (policy: { productId: string | null }) =>
            policy.productId === productId,
        ),
    ).toBe(true);
  });

  it("does not double count the same available stock across competing patient demands", async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const medicationId = `med-demand-${suffix}`;
    const productId = `product-demand-${suffix}`;
    await db.medication.create({
      data: {
        id: medicationId,
        genericName: `Demand Test Drug ${suffix}`,
        strength: "1 mg",
        dosageForm: "tablet",
      },
    });
    await db.product.create({
      data: {
        id: productId,
        medicationId,
        manufacturerId: "manufacturer-demo-generics",
        ndc: `70000-${suffix.slice(0, 4)}-01`,
        ndcSearch: `70000${suffix.slice(0, 4)}01`,
        descriptor: "Demand contention test",
        packageType: "bottle",
        unitsPerPackage: 10,
        dispensingUnit: "EACH",
      },
    });
    const lot = await db.productLot.create({
      data: {
        siteId: "site-demo-001",
        productId,
        lotNumber: `DEM-${suffix}`,
        lotNumberSearch: `DEM${suffix}`.toUpperCase(),
      },
    });
    const expiration = await db.productExpiration.create({
      data: {
        siteId: "site-demo-001",
        productId,
        expirationDate: new Date("2029-12-31T00:00:00.000Z"),
      },
    });
    const balance = await db.inventoryBalance.create({
      data: {
        siteId: "site-demo-001",
        productId,
        productLotId: lot.id,
        productExpirationId: expiration.id,
        onHandQuantity: 10,
      },
    });
    const location = await db.inventoryLocation.findFirstOrThrow({
      where: {
        siteId: "site-demo-001",
        isDefaultDispensing: true,
        active: true,
      },
    });
    await db.inventoryStockPosition.create({
      data: {
        inventoryBalanceId: balance.id,
        locationId: location.id,
        state: "AVAILABLE",
        quantity: 10,
      },
    });

    const first = await db.inventoryDemand.create({
      data: {
        siteId: "site-demo-001",
        medicationId,
        productId,
        source: "MANUAL",
        requiredQuantity: 10,
        neededBy: new Date("2027-01-01T10:00:00.000Z"),
      },
    });
    const second = await db.inventoryDemand.create({
      data: {
        siteId: "site-demo-001",
        medicationId,
        productId,
        source: "MANUAL",
        requiredQuantity: 10,
        neededBy: new Date("2027-01-01T11:00:00.000Z"),
      },
    });

    await db.$transaction((tx) =>
      reconcileDemandAvailability(tx, "site-demo-001", medicationId),
    );

    const [firstAfter, secondAfter] = await Promise.all([
      db.inventoryDemand.findUniqueOrThrow({ where: { id: first.id } }),
      db.inventoryDemand.findUniqueOrThrow({ where: { id: second.id } }),
    ]);
    expect(firstAfter.status).toBe("READY");
    expect(firstAfter.availableQuantity.toNumber()).toBe(10);
    expect(secondAfter.status).toBe("OPEN");
    expect(secondAfter.availableQuantity.toNumber()).toBe(0);
  });
});
