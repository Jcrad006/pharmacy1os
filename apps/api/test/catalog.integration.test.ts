import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };
const cashierHeaders = { "x-dev-user": "catalog-test-cashier" };

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe("drug product NDC and lot catalog", () => {
  it("stores Drug > NDC > independent Lots AND Expirations", async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
    const ndcSegment = Math.floor(Math.random() * 10_000)
      .toString()
      .padStart(4, "0");
    const genericName = `CatalogDrug-${suffix}`;

    const medication = await app.inject({
      method: "POST",
      url: "/api/medications",
      headers: technicianHeaders,
      payload: {
        genericName,
        brandName: `CatalogBrand-${suffix}`,
        strength: "25 mg",
        dosageForm: "tablet",
        route: "oral",
      },
    });
    expect(medication.statusCode).toBe(201);
    const medicationId = medication.json().medication.id as string;

    const productA = await app.inject({
      method: "POST",
      url: `/api/medications/${medicationId}/products`,
      headers: technicianHeaders,
      payload: {
        ndc: `98765-${ndcSegment}-01`,
        manufacturerName: `Manufacturer A ${suffix}`,
        descriptor: `${genericName} 25 mg tablet — 100 count bottle`,
        packageDescription: "Bottle of 100 tablets",
        packageType: "bottle",
        unitsPerPackage: 100,
        dispensingUnit: "EACH",
        packagePrice: 3.0,
      },
    });
    expect(productA.statusCode).toBe(201);

    const productB = await app.inject({
      method: "POST",
      url: `/api/medications/${medicationId}/products`,
      headers: technicianHeaders,
      payload: {
        ndc: `87654-${ndcSegment}-02`,
        manufacturerName: `Manufacturer B ${suffix}`,
        descriptor: `${genericName} 25 mg tablet — 500 count bottle`,
        packageDescription: "Bottle of 500 tablets",
        packageType: "bottle",
        unitsPerPackage: 500,
        dispensingUnit: "EACH",
        unitPrice: 0.025,
      },
    });
    expect(productB.statusCode).toBe(201);

    const productAId = productA.json().product.id as string;
    const productBId = productB.json().product.id as string;

    for (const lotNumber of [
      `LOT-A-${suffix}`,
      `LOT-B-${suffix}`,
      `LOT-C-${suffix}`,
    ]) {
      const lot = await app.inject({
        method: "POST",
        url: `/api/products/${productAId}/lots`,
        headers: technicianHeaders,
        payload: { lotNumber },
      });
      expect(lot.statusCode).toBe(201);
    }

    for (const expirationDate of [
      "2028-01-31T00:00:00.000Z",
      "2028-07-31T00:00:00.000Z",
    ]) {
      const expiration = await app.inject({
        method: "POST",
        url: `/api/products/${productAId}/expirations`,
        headers: technicianHeaders,
        payload: { expirationDate },
      });
      expect(expiration.statusCode).toBe(201);
    }

    const productBLot = await app.inject({
      method: "POST",
      url: `/api/products/${productBId}/lots`,
      headers: technicianHeaders,
      payload: { lotNumber: `LOT-D-${suffix}` },
    });
    expect(productBLot.statusCode).toBe(201);

    const productBExpiration = await app.inject({
      method: "POST",
      url: `/api/products/${productBId}/expirations`,
      headers: technicianHeaders,
      payload: { expirationDate: "2029-02-28T00:00:00.000Z" },
    });
    expect(productBExpiration.statusCode).toBe(201);

    const catalog = await app.inject({
      method: "GET",
      url: `/api/medications?query=${encodeURIComponent(genericName)}`,
      headers: technicianHeaders,
    });
    expect(catalog.statusCode).toBe(200);

    const stored = catalog
      .json()
      .medications.find((item: { id: string }) => item.id === medicationId);

    expect(stored).toBeTruthy();
    expect(stored.products).toHaveLength(2);

    const storedA = stored.products.find(
      (item: { id: string }) => item.id === productAId,
    );
    const storedB = stored.products.find(
      (item: { id: string }) => item.id === productBId,
    );

    expect(storedA.descriptor).toContain("100 count bottle");
    expect(Number(storedA.unitsPerPackage)).toBe(100);
    expect(storedA.dispensingUnit).toBe("EACH");
    expect(Number(storedA.packagePrice)).toBeCloseTo(3, 4);
    expect(Number(storedA.unitPrice)).toBeCloseTo(0.03, 6);

    expect(Number(storedB.unitsPerPackage)).toBe(500);
    expect(storedB.dispensingUnit).toBe("EACH");
    expect(Number(storedB.unitPrice)).toBeCloseTo(0.025, 6);
    expect(Number(storedB.packagePrice)).toBeCloseTo(12.5, 4);

    expect(storedA.lots).toHaveLength(3);
    expect(storedA.expirations).toHaveLength(2);
    expect(storedB.lots).toHaveLength(1);
    expect(storedB.expirations).toHaveLength(1);

    expect(storedA.lots.map((lot: { lotNumber: string }) => lot.lotNumber)).toEqual(
      expect.arrayContaining([
        `LOT-A-${suffix}`,
        `LOT-B-${suffix}`,
        `LOT-C-${suffix}`,
      ]),
    );
    expect(
      storedA.expirations.map(
        (expiration: { expirationDate: string }) => expiration.expirationDate,
      ),
    ).toEqual(
      expect.arrayContaining([
        "2028-01-31T00:00:00.000Z",
        "2028-07-31T00:00:00.000Z",
      ]),
    );
  });

  it("retrieves catalog entries by normalized NDC, manufacturer, and lot number", async () => {
    const byFormattedNdc = await app.inject({
      method: "GET",
      url: "/api/medications?query=99999-0001-01",
      headers: technicianHeaders,
    });
    expect(byFormattedNdc.statusCode).toBe(200);
    expect(
      byFormattedNdc
        .json()
        .medications.some((item: { genericName: string }) => item.genericName === "Lisinopril"),
    ).toBe(true);

    const byUnformattedNdc = await app.inject({
      method: "GET",
      url: "/api/medications?query=99999000101",
      headers: technicianHeaders,
    });
    expect(byUnformattedNdc.statusCode).toBe(200);
    expect(
      byUnformattedNdc
        .json()
        .medications.some((item: { genericName: string }) => item.genericName === "Lisinopril"),
    ).toBe(true);

    const byManufacturer = await app.inject({
      method: "GET",
      url: "/api/medications?query=Demo%20Generics",
      headers: technicianHeaders,
    });
    expect(byManufacturer.statusCode).toBe(200);
    expect(byManufacturer.json().medications.length).toBeGreaterThan(0);

    const byLot = await app.inject({
      method: "GET",
      url: "/api/medications?query=LIS-A1002",
      headers: technicianHeaders,
    });
    expect(byLot.statusCode).toBe(200);
    const lisinopril = byLot
      .json()
      .medications.find((item: { genericName: string }) => item.genericName === "Lisinopril");
    expect(lisinopril).toBeTruthy();
    expect(
      lisinopril.products.some((product: { lots: Array<{ lotNumber: string }> }) =>
        product.lots.some((lot) => lot.lotNumber === "LIS-A1002"),
      ),
    ).toBe(true);
  });

  it("supports gram and milliliter dispensing units for NDC packages", async () => {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
    const ndcA = Math.floor(Math.random() * 10_000).toString().padStart(4, "0");
    const ndcB = Math.floor(Math.random() * 10_000).toString().padStart(4, "0");

    const cream = await app.inject({
      method: "POST",
      url: "/api/medications",
      headers: technicianHeaders,
      payload: {
        genericName: `CreamDrug-${suffix}`,
        strength: "1%",
        dosageForm: "cream",
        route: "topical",
      },
    });
    expect(cream.statusCode).toBe(201);

    const creamProduct = await app.inject({
      method: "POST",
      url: `/api/medications/${cream.json().medication.id}/products`,
      headers: technicianHeaders,
      payload: {
        ndc: `76543-${ndcA}-01`,
        manufacturerName: `Cream Manufacturer ${suffix}`,
        descriptor: `CreamDrug-${suffix} 1% — 30 g tube`,
        packageType: "tube",
        unitsPerPackage: 30,
        dispensingUnit: "GRAM",
        packagePrice: 15,
      },
    });
    expect(creamProduct.statusCode).toBe(201);
    expect(creamProduct.json().product.dispensingUnit).toBe("GRAM");
    expect(Number(creamProduct.json().product.unitPrice)).toBeCloseTo(0.5, 6);

    const liquid = await app.inject({
      method: "POST",
      url: "/api/medications",
      headers: technicianHeaders,
      payload: {
        genericName: `LiquidDrug-${suffix}`,
        strength: "10 mg/mL",
        dosageForm: "solution",
        route: "oral",
      },
    });
    expect(liquid.statusCode).toBe(201);

    const liquidProduct = await app.inject({
      method: "POST",
      url: `/api/medications/${liquid.json().medication.id}/products`,
      headers: technicianHeaders,
      payload: {
        ndc: `65432-${ndcB}-01`,
        manufacturerName: `Liquid Manufacturer ${suffix}`,
        descriptor: `LiquidDrug-${suffix} 10 mg/mL — 473 mL bottle`,
        packageType: "bottle",
        unitsPerPackage: 473,
        dispensingUnit: "MILLILITER",
        unitPrice: 0.12,
      },
    });
    expect(liquidProduct.statusCode).toBe(201);
    expect(liquidProduct.json().product.dispensingUnit).toBe("MILLILITER");
    expect(Number(liquidProduct.json().product.packagePrice)).toBeCloseTo(56.76, 4);
  });

  it("prevents roles without inventory-write permission from creating catalog records", async () => {
    await db.user.upsert({
      where: { externalAuthId: "catalog-test-cashier" },
      update: {
        displayName: "Catalog Test Cashier",
        role: "CASHIER",
        active: true,
      },
      create: {
        siteId: "site-demo-001",
        externalAuthId: "catalog-test-cashier",
        displayName: "Catalog Test Cashier",
        role: "CASHIER",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/medications",
      headers: cashierHeaders,
      payload: {
        genericName: "Blocked Drug",
        strength: "1 mg",
        dosageForm: "tablet",
      },
    });

    expect(response.statusCode).toBe(403);
  });
});
