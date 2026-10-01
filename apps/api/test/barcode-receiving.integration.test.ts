import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { parseBarcode } from "../src/barcode.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";

const app = buildApp();
const technicianHeaders = { "x-dev-user": "dev-technician" };
const pharmacistHeaders = { "x-dev-user": "dev-pharmacist" };

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
      rxNumber: `BAR-${suffix}`,
      sig: "Take 1 tablet by mouth once daily",
      quantityWritten: 30,
      refillsAllowed: 1,
    },
  });
  expect(created.statusCode).toBe(201);

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

  return {
    prescriptionId,
    fillId: fill.json().fill.id as string,
  };
}

describe("barcode registry, receiving, and Product Fill", () => {
  it("parses GS1 GTIN, expiration, and lot from common scanner representations", () => {
    const parenthesized = parseBarcode(
      "(01)00999990001015(17)270630(10)LIS-A1001",
    );
    expect(parenthesized?.type).toBe("GTIN_14");
    expect(parenthesized?.identifier).toBe("00999990001015");
    expect(parenthesized?.lotNumber).toBe("LIS-A1001");
    expect(parenthesized?.expirationDate?.toISOString()).toBe(
      "2027-06-30T00:00:00.000Z",
    );

    const elementString = parseBarcode(
      "]d201009999900010151727063010LIS-A1001",
    );
    expect(elementString?.identifier).toBe("00999990001015");
    expect(elementString?.lotNumber).toBe("LIS-A1001");
    expect(elementString?.expirationDate?.toISOString()).toBe(
      "2027-06-30T00:00:00.000Z",
    );
  });

  it("recognizes a registered barcode during receiving", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/receiving/scan",
      headers: technicianHeaders,
      payload: {
        rawBarcode: "(01)00999990001015(17)270630(10)LIS-A1001",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("KNOWN");
    expect(response.json().product.ndc).toBe("99999-0001-01");
    expect(response.json().product.medication.genericName).toBe("Lisinopril");
    expect(response.json().parsed.lotNumber).toBe("LIS-A1001");
  });

  it("assigns an unknown barcode to an existing NDC and registers received lot/expiration", async () => {
    const digits = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    const gtin = `0088888${digits}0`;
    const rawBarcode = `(01)${gtin}(17)290131(10)RCV-${digits}`;

    const unknown = await app.inject({
      method: "POST",
      url: "/api/receiving/scan",
      headers: technicianHeaders,
      payload: { rawBarcode },
    });

    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().status).toBe("UNKNOWN");
    expect(unknown.json().parsed.identifier).toBe(gtin);

    const assigned = await app.inject({
      method: "POST",
      url: "/api/receiving/assign",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        productId: "product-demo-lisinopril-a",
        isPrimary: false,
      },
    });

    expect(assigned.statusCode).toBe(201);
    expect(assigned.json().status).toBe("ASSIGNED");
    expect(assigned.json().barcode.identifier).toBe(gtin);
    expect(assigned.json().traceability.lot.lotNumber).toBe(`RCV-${digits}`);
    expect(assigned.json().traceability.expiration.expirationDate).toBe(
      "2029-01-31T00:00:00.000Z",
    );

    const recognized = await app.inject({
      method: "POST",
      url: "/api/receiving/scan",
      headers: technicianHeaders,
      payload: { rawBarcode },
    });

    expect(recognized.statusCode).toBe(200);
    expect(recognized.json().status).toBe("KNOWN");
    expect(recognized.json().product.id).toBe("product-demo-lisinopril-a");

    const catalog = await app.inject({
      method: "GET",
      url: `/api/medications?query=${gtin}`,
      headers: technicianHeaders,
    });
    expect(catalog.statusCode).toBe(200);
    expect(
      catalog
        .json()
        .medications.some(
          (item: { id: string }) => item.id === "medication-demo-lisinopril-10",
        ),
    ).toBe(true);
  });

  it("accepts a registered raw barcode for any NDC under the selected Drug", async () => {
    const { prescriptionId, fillId } = await createLisinoprilFill();

    const response = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: {
        rawBarcode: "(01)00999980101015(17)280331(10)LIS-B2001",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().fill.scannedNdc).toBe("99998-0101-01");
    expect(response.json().fill.scannedLotNumber).toBe("LIS-B2001");
    expect(response.json().verifiedProduct.drug.genericName).toBe("Lisinopril");

    const review = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "PHARMACIST_REVIEW" },
    });
    expect(review.statusCode).toBe(200);
  });

  it("rejects a registered raw barcode that resolves to the wrong Drug", async () => {
    const { fillId } = await createLisinoprilFill();

    const response = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: {
        rawBarcode: "(01)00999990020016(17)270930(10)ATOR-A3001",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("BARCODE_DRUG_MISMATCH");
    expect(response.json().expectedDrug.genericName).toBe("Lisinopril");
    expect(response.json().scannedDrug.genericName).toBe("Atorvastatin");
  });

  it("allows only a pharmacist to correct a wrong receiving barcode assignment and flags historical fill use", async () => {
    const digits = Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0");
    const gtin = `0077777${digits}0`;
    const rawBarcode = `(01)${gtin}(17)291231(10)CORR-${digits}`;

    const wrongAssignment = await app.inject({
      method: "POST",
      url: "/api/receiving/assign",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        productId: "product-demo-atorvastatin-a",
        isPrimary: false,
      },
    });

    expect(wrongAssignment.statusCode).toBe(201);
    const barcodeId = wrongAssignment.json().barcode.id as string;

    const atorvastatinRx = await app.inject({
      method: "POST",
      url: "/api/prescriptions",
      headers: technicianHeaders,
      payload: {
        patientId: "patient-demo-002",
        prescriberId: "prescriber-demo-002",
        medicationId: "medication-demo-atorvastatin-20",
        rxNumber: `CORR-${digits}`,
        sig: "Take 1 tablet by mouth once daily",
        quantityWritten: 30,
        refillsAllowed: 0,
      },
    });
    expect(atorvastatinRx.statusCode).toBe(201);

    const rxId = atorvastatinRx.json().prescription.id as string;
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${rxId}/status`,
          headers: technicianHeaders,
          payload: { status: "DUR_REVIEW" },
        })
      ).statusCode,
    ).toBe(200);

    const fill = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${rxId}/fills`,
      headers: technicianHeaders,
      payload: { quantity: 30 },
    });
    expect(fill.statusCode).toBe(201);

    const unsafeHistoricalUse = await app.inject({
      method: "POST",
      url: `/api/fills/${fill.json().fill.id}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(unsafeHistoricalUse.statusCode).toBe(200);
    expect(unsafeHistoricalUse.json().fill.scannedNdc).toBe("99999-0020-01");

    const technicianCorrection = await app.inject({
      method: "POST",
      url: `/api/receiving/barcodes/${barcodeId}/correct`,
      headers: technicianHeaders,
      payload: {
        productId: "product-demo-lisinopril-a",
        reason: "Wrong Drug/NDC selected during receiving.",
        rawBarcode,
      },
    });
    expect(technicianCorrection.statusCode).toBe(403);

    const pharmacistCorrection = await app.inject({
      method: "POST",
      url: `/api/receiving/barcodes/${barcodeId}/correct`,
      headers: pharmacistHeaders,
      payload: {
        productId: "product-demo-lisinopril-a",
        reason: "Barcode belongs to lisinopril; atorvastatin assignment was entered in error.",
        rawBarcode,
      },
    });

    expect(pharmacistCorrection.statusCode).toBe(200);
    expect(pharmacistCorrection.json().status).toBe("CORRECTED");
    expect(pharmacistCorrection.json().product.id).toBe(
      "product-demo-lisinopril-a",
    );
    expect(pharmacistCorrection.json().safetyReview.historicalUseCount).toBe(1);
    expect(pharmacistCorrection.json().safetyReview.message).toContain(
      "previously used",
    );

    const recognizedAfterCorrection = await app.inject({
      method: "POST",
      url: "/api/receiving/scan",
      headers: technicianHeaders,
      payload: { rawBarcode },
    });

    expect(recognizedAfterCorrection.statusCode).toBe(200);
    expect(recognizedAfterCorrection.json().status).toBe("KNOWN");
    expect(recognizedAfterCorrection.json().product.id).toBe(
      "product-demo-lisinopril-a",
    );
    expect(
      recognizedAfterCorrection.json().product.medication.genericName,
    ).toBe("Lisinopril");

    const oldDrugRescan = await app.inject({
      method: "POST",
      url: `/api/fills/${fill.json().fill.id}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(oldDrugRescan.statusCode).toBe(409);
    expect(oldDrugRescan.json().code).toBe("BARCODE_DRUG_MISMATCH");

    const futureLisinoprilFill = await createLisinoprilFill();
    const futureCorrectUse = await app.inject({
      method: "POST",
      url: `/api/fills/${futureLisinoprilFill.fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(futureCorrectUse.statusCode).toBe(200);
    expect(futureCorrectUse.json().fill.scannedNdc).toBe("99999-0001-01");
    expect(futureCorrectUse.json().barcode.id).toBe(barcodeId);

    const originalAssignmentAudit = await db.auditEvent.findFirst({
      where: {
        action: "RECEIVING_BARCODE_ASSIGNED",
        entityType: "ProductBarcode",
        entityId: barcodeId,
      },
      orderBy: { occurredAt: "asc" },
      include: {
        actor: {
          select: {
            displayName: true,
            role: true,
          },
        },
      },
    });

    expect(originalAssignmentAudit).toBeTruthy();
    expect(originalAssignmentAudit?.actor?.role).toBe("TECHNICIAN");
    const originalMetadata = originalAssignmentAudit?.metadata as Record<
      string,
      unknown
    >;
    expect(originalMetadata.productId).toBe("product-demo-atorvastatin-a");
    expect(originalMetadata.ndc).toBe("99999-0020-01");

    const audit = await db.auditEvent.findFirst({
      where: {
        action: "PRODUCT_BARCODE_ASSIGNMENT_CORRECTED",
        entityType: "ProductBarcode",
        entityId: barcodeId,
      },
      orderBy: { occurredAt: "desc" },
    });

    expect(audit).toBeTruthy();
    const metadata = audit?.metadata as Record<string, unknown>;
    expect(metadata.oldNdc).toBe("99999-0020-01");
    expect(metadata.newNdc).toBe("99999-0001-01");
    expect(metadata.reason).toContain("atorvastatin assignment");

    const originalAssignment = metadata.originalAssignment as Record<
      string,
      unknown
    >;
    expect(originalAssignment.auditEventId).toBe(originalAssignmentAudit?.id);
    expect(originalAssignment.actorId).toBe(originalAssignmentAudit?.actorId);
    expect(originalAssignment.actorRole).toBe("TECHNICIAN");
    expect(originalAssignment.occurredAt).toBe(
      originalAssignmentAudit?.occurredAt.toISOString(),
    );

    const correctingActor = metadata.correctingActor as Record<string, unknown>;
    expect(correctingActor.role).toBe("PHARMACIST");
  });

  it("requires lot and expiration for raw Product Fill barcode verification", async () => {
    const { fillId } = await createLisinoprilFill();

    const response = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode: "00999990001015" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("BARCODE_TRACEABILITY_REQUIRED");
  });
});
