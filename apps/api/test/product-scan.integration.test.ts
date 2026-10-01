import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

async function createLisinoprilFill() {
  const suffix = randomUUID().slice(0, 8);

  const created = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId: "patient-demo-001",
      prescriberId: "prescriber-demo-001",
      medicationId: "medication-demo-lisinopril-10",
      rxNumber: `SCAN-${suffix}`,
      sig: "Take 1 tablet by mouth once daily",
      quantityWritten: 30,
      refillsAllowed: 1,
    },
  });

  expect(created.statusCode).toBe(201);
  expect(created.json().prescription.medicationId).toBe(
    "medication-demo-lisinopril-10",
  );
  expect(created.json().prescription.medicationName).toBe("Lisinopril");
  expect(created.json().prescription.strength).toBe("10 mg");
  expect(created.json().prescription.dosageForm).toBe("tablet");

  const prescriptionId = created.json().prescription.id as string;

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
    payload: { quantity: 30 },
  });
  expect(fill.statusCode).toBe(201);
  expect(fill.json().fill.status).toBe("IN_PROGRESS");

  return {
    prescriptionId,
    fillId: fill.json().fill.id as string,
  };
}

describe("Drug selection at Data Entry and NDC/Lot/Expiration verification", () => {
  it("blocks Product Fill progression until a product scan is verified", async () => {
    const { prescriptionId } = await createLisinoprilFill();

    const review = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });

    expect(review.statusCode).toBe(409);
    expect(review.json().code).toBe("PRODUCT_SCAN_REQUIRED");
  });

  it("rejects an NDC that belongs to a different drug", async () => {
    const { fillId } = await createLisinoprilFill();

    const response = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/scan-product`,
      headers: technicianHeaders,
      payload: {
        ndc: "99999-0020-01",
        lotNumber: "ATOR-A3001",
        expirationDate: "2027-09-30T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("NDC_DRUG_MISMATCH");
    expect(response.json().expectedDrug.genericName).toBe("Lisinopril");
    expect(response.json().scannedDrug.genericName).toBe("Atorvastatin");
  });

  it("rejects a lot that does not belong to the scanned NDC", async () => {
    const { fillId } = await createLisinoprilFill();

    const response = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/scan-product`,
      headers: technicianHeaders,
      payload: {
        ndc: "99999-0001-01",
        lotNumber: "LIS-B2001",
        expirationDate: "2027-06-30T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("LOT_NDC_MISMATCH");
  });

  it("rejects an expiration that does not belong to the scanned NDC", async () => {
    const { fillId } = await createLisinoprilFill();

    const response = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/scan-product`,
      headers: technicianHeaders,
      payload: {
        ndc: "99999-0001-01",
        lotNumber: "LIS-A1001",
        expirationDate: "2028-03-31T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("EXPIRATION_NDC_MISMATCH");
  });

  it("accepts any NDC under the selected drug when NDC, lot, and expiration all verify", async () => {
    const { prescriptionId, fillId } = await createLisinoprilFill();

    const verified = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/scan-product`,
      headers: technicianHeaders,
      payload: {
        ndc: "99998-0101-01",
        lotNumber: "LIS-B2001",
        expirationDate: "2028-03-31T00:00:00.000Z",
      },
    });

    expect(verified.statusCode).toBe(200);
    expect(verified.json().verifiedProduct.drug.genericName).toBe("Lisinopril");
    expect(verified.json().fill.scannedNdc).toBe("99998-0101-01");
    expect(verified.json().fill.scannedLotNumber).toBe("LIS-B2001");
    expect(verified.json().fill.productVerifiedAt).toBeTruthy();

    const review = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });

    expect(review.statusCode).toBe(200);
    expect(review.json().prescription.status).toBe("PHARMACIST_REVIEW");
  });
});
