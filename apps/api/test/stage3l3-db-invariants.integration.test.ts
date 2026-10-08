import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../src/db.js";

afterAll(async () => { await db.$disconnect(); });

// A probe always rolls back, even if a safety constraint unexpectedly permits the write.
async function expectRejectedProbe(work: Parameters<Parameters<typeof db.$transaction>[0]>[0] extends never ? never : (tx: any) => Promise<unknown>) {
  let rejected = false;
  try {
    await db.$transaction(async (tx) => {
      try { await work(tx); } catch { rejected = true; }
      throw new Error("STAGE3L3_PROBE_ROLLBACK");
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("STAGE3L3_PROBE_ROLLBACK")) throw error;
  }
  expect(rejected).toBe(true);
}

describe("Stage 3L.3 validated database invariants", () => {
  it("validates every required Postgres safety constraint", async () => {
    const names = [
      "InventoryBalance_nonnegative_and_capacity_ck",
      "PrescriptionFill_quantity_and_sequence_bounds_ck",
      "InventoryAllocation_site_balance_fk",
      "Prescription_site_patient_3l3_fk",
      "Prescription_site_prescriber_3l3_fk",
      "PatientCoverage_site_patient_3l3_fk",
      "PatientCoverage_site_payer_3l3_fk",
      "Document_site_prescription_3l3_fk",
      "InventoryTransaction_site_balance_3l3_fk",
      "WillCallPackage_site_location_3l3_fk",
    ];
    const rows = await db.$queryRaw<Array<{ conname: string; convalidated: boolean }>>`
      SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%_3l3_fk'
        OR conname IN ('InventoryBalance_nonnegative_and_capacity_ck',
          'PrescriptionFill_quantity_and_sequence_bounds_ck', 'InventoryAllocation_site_balance_fk')
    `;
    for (const name of names) {
      expect(rows.find((row) => row.conname === name), name).toMatchObject({ convalidated: true });
    }
  });

  it("blocks negative stock and over-reservation, leaving ledger intact", async () => {
    const id = "inventory-demo-lisinopril-a1";
    const before = await db.inventoryBalance.findUniqueOrThrow({ where: { id } });
    await expectRejectedProbe(async (tx: any) => {
      await tx.$executeRaw`UPDATE "InventoryBalance" SET "onHandQuantity" = -1 WHERE "id" = ${id}`;
    });
    await expectRejectedProbe(async (tx: any) => {
      await tx.$executeRaw`UPDATE "InventoryBalance" SET "reservedQuantity" = "onHandQuantity" + 1 WHERE "id" = ${id}`;
    });
    const after = await db.inventoryBalance.findUniqueOrThrow({ where: { id } });
    expect(after.onHandQuantity.toString()).toBe(before.onHandQuantity.toString());
  });

  it("rejects a cross-site prescription/patient association even via direct SQL", async () => {
    const otherSitePatientId = "patient-cross-site-" + randomUUID();
    await db.patient.create({
      data: { id: otherSitePatientId, siteId: "site-demo-002", firstName: "Other", lastName: "Site" },
    });
    await expectRejectedProbe(async (tx: any) => {
      await tx.$executeRaw`UPDATE "Prescription" SET "patientId" = ${otherSitePatientId} WHERE "id" = 'rx-demo-001'`;
    });
  });

  it("rejects cross-site physical stock location despite separate valid foreign keys", async () => {
    const location = await db.inventoryLocation.findFirstOrThrow({ where: { siteId: "site-demo-002" } });
    await expectRejectedProbe(async (tx: any) => {
      await tx.inventoryStockPosition.create({
        data: {
          inventoryBalanceId: "inventory-demo-lisinopril-a1",
          locationId: location.id,
          quantity: 1, state: "AVAILABLE",
        },
      });
    });
  });
});
