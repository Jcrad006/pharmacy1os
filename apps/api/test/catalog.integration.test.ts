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
  it("stores one drug with multiple manufacturer/NDC products and multiple lots", async () => {
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
        labelName: `${genericName} 25 mg`,
        packageDescription: "Bottle of 100 tablets",
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
        labelName: `${genericName} 25 mg`,
        packageDescription: "Bottle of 500 tablets",
      },
    });
    expect(productB.statusCode).toBe(201);

    const productAId = productA.json().product.id as string;
    const productBId = productB.json().product.id as string;

    for (const [lotNumber, expirationDate] of [
      [`LOT-A-${suffix}`, "2028-01-31T00:00:00.000Z"],
      [`LOT-B-${suffix}`, "2028-07-31T00:00:00.000Z"],
    ]) {
      const lot = await app.inject({
        method: "POST",
        url: `/api/products/${productAId}/lots`,
        headers: technicianHeaders,
        payload: { lotNumber, expirationDate },
      });
      expect(lot.statusCode).toBe(201);
    }

    const productBLot = await app.inject({
      method: "POST",
      url: `/api/products/${productBId}/lots`,
      headers: technicianHeaders,
      payload: {
        lotNumber: `LOT-C-${suffix}`,
        expirationDate: "2029-02-28T00:00:00.000Z",
      },
    });
    expect(productBLot.statusCode).toBe(201);

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
    expect(
      stored.products.find((item: { id: string }) => item.id === productAId).lots,
    ).toHaveLength(2);
    expect(
      stored.products.find((item: { id: string }) => item.id === productBId).lots,
    ).toHaveLength(1);
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
