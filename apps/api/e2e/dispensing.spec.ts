import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { db } from "../src/db.js";

test("browser drives a paid synthetic claim and label through pharmacist verification, Will Call and POS", async ({ page }) => {
  const token = randomUUID().slice(0, 10);
  const rxNumber = "E2E-" + token;
  const patientId = "patient-e2e-" + token;
  const payerId = "payer-e2e-" + token;
  const dob = "1990-01-01";
  const bagBarcode = "WC-E2E-" + token.toUpperCase();

  // Fixture only: a synthetic patient, payer and coverage. Every dispensing step is via the browser.
  await db.patient.create({
    data: {
      id: patientId,
      siteId: "site-demo-001",
      firstName: "Browser",
      lastName: "Journey" + token,
      dateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
    },
  });
  await db.payer.create({
    data: {
      id: payerId,
      siteId: "site-demo-001",
      name: "Synthetic E2E Payer " + token,
      bin: "019901",
      pcn: "E2E",
      claimStandard: "D0",
      billingNdcStrategy: "MAJORITY_SOURCE",
      billingProfile: {
        create: {
          siteId: "site-demo-001",
          billingNdcStrategy: "MAJORITY_SOURCE",
          autoReversePaidClaimOnSourceCorrection: true,
          notes: "Browser end-to-end fixture; synthetic only",
        },
      },
    },
  });
  await db.patientCoverage.create({
    data: {
      siteId: "site-demo-001",
      patientId,
      payerId,
      position: 1,
      memberId: "E2ECOPAY250",
      relationship: "SELF",
      active: true,
    },
  });

  await page.goto("/");
  await expect(page.locator("#staff")).toBeVisible();
  await page.locator("#staff").selectOption("dev-technician");
  await page.getByRole("button", { name: "New Prescription" }).click();
  await expect(page.getByRole("heading", { name: "Create prescription" })).toBeVisible();
  await page.getByLabel("Patient", { exact: true }).selectOption(patientId);
  await page.getByLabel("Prescriber", { exact: true }).selectOption("prescriber-demo-001");
  await page.getByLabel("Drug", { exact: true }).selectOption("medication-demo-lisinopril-10");
  await page.getByLabel("Rx number").fill(rxNumber);
  await page.getByLabel("Directions / Sig").fill("Take one tablet once daily");
  await page.getByRole("button", { name: "Create synthetic prescription" }).click();

  await expect(page.getByText(rxNumber).first()).toBeVisible();
  await page.getByRole("button", { name: /Complete data entry/ }).click();
  await expect(page.getByRole("button", { name: "Create fill now" })).toBeVisible();
  await page.getByLabel("Days supply").first().fill("30");
  await page.getByRole("button", { name: "Create fill now" }).click();
  await expect(page.getByRole("button", { name: "Add scanned source" })).toBeVisible();

  await page.getByLabel("Scan stock-package barcode").fill("(01)00999990001015(17)270630(10)LIS-A1001");
  await page.getByRole("button", { name: "Add scanned source" }).click();
  await expect(page.getByRole("button", { name: /Product prepared.*Pharmacist Review/ })).toBeEnabled();

  const rx = await db.prescription.findFirstOrThrow({ where: { siteId: "site-demo-001", rxNumber } });
  const fill = await db.prescriptionFill.findFirstOrThrow({ where: { prescriptionId: rx.id } });
  await expect.poll(() => db.claimTransaction.count({
    where: { fillId: fill.id, operation: "SUBMIT", outcome: "PAID" },
  })).toBe(1);
  await expect.poll(() => db.prescriptionLabel.count({ where: { fillId: fill.id } })).toBeGreaterThan(0);

  await page.getByRole("button", { name: /Product prepared.*Pharmacist Review/ }).click();
  await page.locator("#staff").selectOption("dev-pharmacist");
  await expect(page.getByRole("button", { name: /Verify prescription.*Ready/ })).toBeEnabled();
  await page.getByRole("button", { name: /Verify prescription.*Ready/ }).click();
  await expect.poll(async () => (await db.prescription.findUniqueOrThrow({ where: { id: rx.id } })).status).toBe("READY");

  await page.getByRole("button", { name: /Will Call/ }).first().click();
  const card = page.locator("article.will-call-card").filter({ hasText: rxNumber });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Stage Bag" }).click();
  await card.getByLabel("1. Scan bag barcode").fill(bagBarcode);
  await card.getByRole("button", { name: "Confirm Staging" }).click();
  await expect(card.getByText(bagBarcode)).toBeVisible();

  await card.getByRole("button", { name: "Open Pickup" }).click();
  await card.getByLabel("Patient date of birth").fill(dob);
  await card.getByLabel("Electronic signature").fill("Browser Journey");
  await card.getByLabel("Payment method").selectOption("CASH");
  await card.getByRole("button", { name: "Confirm Pickup" }).click();

  await expect.poll(async () => (await db.prescription.findUniqueOrThrow({ where: { id: rx.id } })).status).toBe("SOLD");
  await expect.poll(() => db.pointOfSaleLine.count({ where: { fillId: fill.id } })).toBe(1);
  const sale = await db.pointOfSaleLine.findFirstOrThrow({
    where: { fillId: fill.id },
    include: { transaction: true },
  });
  expect(sale.transaction.status).toBe("COMPLETED");
  expect(Number(sale.transaction.totalDue)).toBe(2.5);
  expect(await db.willCallPackage.findFirstOrThrow({ where: { fillId: fill.id } }))
    .toMatchObject({ status: "PICKED_UP", bagBarcode });
});
