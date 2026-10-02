import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";

process.env.ALLOW_DEV_IDENTITY = "true";
process.env.ALLOW_LEGACY_DIRECT_SALE = "true";

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

function numericSuffix() {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

async function createPrescription(input: {
  quantity: number;
  medicationId?: string;
  medicationName?: string;
}) {
  const suffix = randomUUID().slice(0, 8);
  const response = await app.inject({
    method: "POST",
    url: "/api/prescriptions",
    headers: technicianHeaders,
    payload: {
      patientId: "patient-demo-001",
      prescriberId: "prescriber-demo-001",
      ...(input.medicationId
        ? { medicationId: input.medicationId }
        : {
            medicationName:
              input.medicationName ?? "Synthetic Continuity Drug",
            strength: "10 mg",
            dosageForm: "tablet",
          }),
      rxNumber: `CONT-${suffix}`,
      sig: "Take 1 tablet by mouth once daily",
      quantityWritten: input.quantity,
      refillsAllowed: 0,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().prescription.id as string;
}

async function moveToDur(prescriptionId: string) {
  const response = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: technicianHeaders,
    payload: { status: "DUR_REVIEW" },
  });
  expect(response.statusCode).toBe(200);
}

async function moveToSoldWithoutCatalog(
  prescriptionId: string,
) {
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/prescriptions/${prescriptionId}/status`,
        headers: technicianHeaders,
        payload: { status: "PHARMACIST_REVIEW" },
      })
    ).statusCode,
  ).toBe(200);

  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/prescriptions/${prescriptionId}/status`,
        headers: pharmacistHeaders,
        payload: { status: "READY" },
      })
    ).statusCode,
  ).toBe(200);

  const sold = await app.inject({
    method: "PATCH",
    url: `/api/prescriptions/${prescriptionId}/status`,
    headers: technicianHeaders,
    payload: { status: "SOLD" },
  });
  expect(sold.statusCode).toBe(200);
  return sold.json().prescription;
}

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

describe("Phase 3I dispensing continuity", () => {
  it("creates a technician-entered partial fill and prompts a linked completion without consuming another refill", async () => {
    const rawBarcode =
      "(01)00999990001015(17)270630(10)LIS-A1001";
    const prescriptionId = await createPrescription({
      quantity: 90,
      medicationId: "medication-demo-lisinopril-10",
    });
    await moveToDur(prescriptionId);

    const fill = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/fills`,
      headers: technicianHeaders,
      payload: { quantity: 90 },
    });
    expect(fill.statusCode).toBe(201);
    const fillId = fill.json().fill.id as string;

    const completionDate = new Date(Date.now() + 86_400_000);
    const partial = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/partial`,
      headers: technicianHeaders,
      payload: {
        dispenseQuantity: 3,
        completionScheduledFor: completionDate.toISOString(),
        reason: "Only three tablets in stock; remainder ordered.",
      },
    });

    expect(partial.statusCode).toBe(200);
    expect(partial.json().partialFill.kind).toBe("PARTIAL");
    expect(Number(partial.json().partialFill.quantity)).toBe(3);
    expect(partial.json().partialFill.fillNumber).toBe(0);
    expect(partial.json().partialFill.partNumber).toBe(1);
    expect(partial.json().partialFill.consumesRefill).toBe(true);
    expect(partial.json().partialFill.billingRole).toBe("PRIMARY_CLAIM");
    expect(Number(partial.json().partialFill.intendedQuantity)).toBe(90);
    expect(Number(partial.json().partialFill.payerIntendedQuantity)).toBe(90);
    expect(Number(partial.json().partialFill.physicalDispensedQuantity)).toBe(0);
    expect(Number(partial.json().partialFill.remainingOwedQuantity)).toBe(87);

    const completion = partial.json().completionFill;
    expect(completion.kind).toBe("COMPLETION");
    expect(Number(completion.quantity)).toBe(87);
    expect(completion.fillNumber).toBe(0);
    expect(completion.partNumber).toBe(2);
    expect(completion.consumesRefill).toBe(false);
    expect(completion.completionOfFillId).toBe(fillId);
    expect(completion.billingRole).toBe("COMPLETION_OF_PRIMARY");
    expect(completion.billingAnchorFillId).toBe(fillId);
    expect(Number(completion.intendedQuantity)).toBe(90);
    expect(Number(completion.payerIntendedQuantity)).toBe(90);

    const demand = await db.inventoryDemand.findUnique({
      where: { fillId: completion.id },
    });
    expect(demand).toBeTruthy();
    expect(demand?.source).toBe("COMPLETION");
    expect(demand?.requiredQuantity.toNumber()).toBe(87);
    expect(demand?.neededBy?.toISOString()).toBe(
      completionDate.toISOString(),
    );

    const demandQueue = await app.inject({
      method: "GET",
      url: "/api/inventory/demands",
      headers: technicianHeaders,
    });
    expect(demandQueue.statusCode).toBe(200);
    expect(
      demandQueue
        .json()
        .demands.some(
          (item: { fillId: string | null }) => item.fillId === completion.id,
        ),
    ).toBe(true);

    const scannedPartial = await app.inject({
      method: "POST",
      url: `/api/fills/${fillId}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(scannedPartial.statusCode).toBe(200);

    const soldPartial = await moveToSoldWithoutCatalog(prescriptionId);
    expect(soldPartial.refillsUsed).toBe(0);

    const partialAfterSale = await db.prescriptionFill.findUniqueOrThrow({
      where: { id: fillId },
    });
    expect(partialAfterSale.physicalDispensedQuantity.toNumber()).toBe(3);
    expect(partialAfterSale.payerIntendedQuantity?.toNumber()).toBe(90);
    expect(partialAfterSale.remainingOwedQuantity.toNumber()).toBe(87);

    await db.prescriptionFill.update({
      where: { id: completion.id },
      data: { scheduledFor: new Date(Date.now() - 1_000) },
    });

    const exceptions = await app.inject({
      method: "GET",
      url: "/api/exceptions?kind=COMPLETION_FILL",
      headers: technicianHeaders,
    });
    expect(exceptions.statusCode).toBe(200);
    expect(
      exceptions
        .json()
        .exceptions.some(
          (item: { prescriptionId: string; kind: string }) =>
            item.prescriptionId === prescriptionId &&
            item.kind === "COMPLETION_FILL",
        ),
    ).toBe(true);

    const start = await app.inject({
      method: "POST",
      url: `/api/fills/${completion.id}/start`,
      headers: technicianHeaders,
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().fill.status).toBe("IN_PROGRESS");
    expect(start.json().prescription.status).toBe("PRODUCT_FILL");

    const scannedCompletion = await app.inject({
      method: "POST",
      url: `/api/fills/${completion.id}/scan-barcode`,
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(scannedCompletion.statusCode).toBe(200);

    const soldCompletion = await moveToSoldWithoutCatalog(prescriptionId);
    expect(soldCompletion.refillsUsed).toBe(0);

    const parts = await db.prescriptionFill.findMany({
      where: { prescriptionId, fillNumber: 0 },
      orderBy: { partNumber: "asc" },
    });
    expect(parts).toHaveLength(2);
    expect(parts.map((item) => item.kind)).toEqual([
      "PARTIAL",
      "COMPLETION",
    ]);
    expect(parts.map((item) => item.status)).toEqual(["SOLD", "SOLD"]);
    expect(parts[0]?.remainingOwedQuantity.toNumber()).toBe(0);
    expect(parts[1]?.physicalDispensedQuantity.toNumber()).toBe(87);
    expect(parts[0]?.payerIntendedQuantity?.toNumber()).toBe(90);
    expect(parts[1]?.payerIntendedQuantity?.toNumber()).toBe(90);
  });

  it("interrupts a scanned 90-unit fill to 3 physical units while preserving the 90-unit payer intent", async () => {
    const suffix = numericSuffix();
    const gtin = gs1WithCheckDigit(`0066666${suffix}`);
    const lotNumber = "PARTIAL-" + suffix;
    const rawBarcode =
      "(01)" + gtin + "(17)270630(10)" + lotNumber;

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

    const received = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        quantity: 120,
        source: "Interrupted partial fill test",
      },
    });
    expect(received.statusCode).toBe(201);
    const balanceId = received.json().balance.id as string;

    const prescriptionId = await createPrescription({
      quantity: 90,
      medicationId: "medication-demo-lisinopril-10",
    });
    await moveToDur(prescriptionId);

    const createdFill = await app.inject({
      method: "POST",
      url: "/api/prescriptions/" + prescriptionId + "/fills",
      headers: technicianHeaders,
      payload: { quantity: 90 },
    });
    expect(createdFill.statusCode).toBe(201);
    const fillId = createdFill.json().fill.id as string;

    const scanned = await app.inject({
      method: "POST",
      url: "/api/fills/" + fillId + "/scan-barcode",
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(scanned.statusCode).toBe(200);

    let balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.reservedQuantity.toNumber()).toBe(90);

    const completionDate = new Date(Date.now() + 86_400_000);
    const interrupted = await app.inject({
      method: "POST",
      url: "/api/fills/" + fillId + "/partial",
      headers: technicianHeaders,
      payload: {
        dispenseQuantity: 3,
        completionScheduledFor: completionDate.toISOString(),
        interruptionReason: "INSUFFICIENT_PHYSICAL_STOCK",
        reason:
          "Physical count found only three tablets available for this fill.",
      },
    });

    expect(interrupted.statusCode).toBe(200);
    const partialFill = interrupted.json().partialFill;
    const completionFill = interrupted.json().completionFill;
    const inventoryException = interrupted.json().inventoryException;

    expect(partialFill.kind).toBe("PARTIAL");
    expect(partialFill.billingRole).toBe("PRIMARY_CLAIM");
    expect(Number(partialFill.quantity)).toBe(3);
    expect(Number(partialFill.intendedQuantity)).toBe(90);
    expect(Number(partialFill.payerIntendedQuantity)).toBe(90);
    expect(Number(partialFill.remainingOwedQuantity)).toBe(87);
    expect(partialFill.interruptionReason).toBe(
      "INSUFFICIENT_PHYSICAL_STOCK",
    );
    expect(partialFill.inventoryReservedAt).toBeTruthy();

    expect(completionFill.kind).toBe("COMPLETION");
    expect(completionFill.billingRole).toBe("COMPLETION_OF_PRIMARY");
    expect(completionFill.billingAnchorFillId).toBe(fillId);
    expect(Number(completionFill.quantity)).toBe(87);
    expect(Number(completionFill.intendedQuantity)).toBe(90);
    expect(Number(completionFill.payerIntendedQuantity)).toBe(90);
    expect(completionFill.consumesRefill).toBe(false);

    balance = await db.inventoryBalance.findUniqueOrThrow({
      where: { id: balanceId },
    });
    expect(balance.reservedQuantity.toNumber()).toBe(3);

    const allocations = await db.inventoryAllocation.findMany({
      where: { fillId },
      orderBy: { createdAt: "asc" },
    });
    expect(allocations).toHaveLength(2);
    expect(allocations[0]?.status).toBe("RELEASED");
    expect(allocations[0]?.quantity.toNumber()).toBe(90);
    expect(allocations[1]?.status).toBe("ACTIVE");
    expect(allocations[1]?.quantity.toNumber()).toBe(3);

    expect(inventoryException).toBeTruthy();
    expect(inventoryException.type).toBe("PHYSICAL_STOCK_SHORTAGE");
    expect(inventoryException.status).toBe("OPEN");

    const refreshedExceptions = await app.inject({
      method: "GET",
      url: "/api/inventory/exceptions",
      headers: technicianHeaders,
    });
    expect(refreshedExceptions.statusCode).toBe(200);
    expect(
      refreshedExceptions
        .json()
        .exceptions.some(
          (item: { id: string; type: string; status: string }) =>
            item.id === inventoryException.id &&
            item.type === "PHYSICAL_STOCK_SHORTAGE" &&
            item.status === "OPEN",
        ),
    ).toBe(true);

    const soldPartial = await moveToSoldWithoutCatalog(prescriptionId);
    expect(soldPartial.refillsUsed).toBe(0);

    const rootAfterPartialSale =
      await db.prescriptionFill.findUniqueOrThrow({
        where: { id: fillId },
      });
    expect(
      rootAfterPartialSale.physicalDispensedQuantity.toNumber(),
    ).toBe(3);
    expect(rootAfterPartialSale.payerIntendedQuantity?.toNumber()).toBe(
      90,
    );
    expect(rootAfterPartialSale.remainingOwedQuantity.toNumber()).toBe(
      87,
    );

    await db.prescriptionFill.update({
      where: { id: completionFill.id },
      data: { scheduledFor: new Date(Date.now() - 1_000) },
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/fills/" + completionFill.id + "/start",
      headers: technicianHeaders,
    });
    expect(started.statusCode).toBe(200);

    const completionScan = await app.inject({
      method: "POST",
      url: "/api/fills/" + completionFill.id + "/scan-barcode",
      headers: technicianHeaders,
      payload: { rawBarcode },
    });
    expect(completionScan.statusCode).toBe(200);

    const soldCompletion =
      await moveToSoldWithoutCatalog(prescriptionId);
    expect(soldCompletion.refillsUsed).toBe(0);

    const rootAfterCompletion =
      await db.prescriptionFill.findUniqueOrThrow({
        where: { id: fillId },
      });
    const completionAfterSale =
      await db.prescriptionFill.findUniqueOrThrow({
        where: { id: completionFill.id },
      });

    expect(rootAfterCompletion.remainingOwedQuantity.toNumber()).toBe(0);
    expect(rootAfterCompletion.payerIntendedQuantity?.toNumber()).toBe(
      90,
    );
    expect(
      completionAfterSale.physicalDispensedQuantity.toNumber(),
    ).toBe(87);
    expect(
      completionAfterSale.payerIntendedQuantity?.toNumber(),
    ).toBe(90);

    const technicianResolve = await app.inject({
      method: "POST",
      url:
        "/api/inventory/exceptions/" +
        inventoryException.id +
        "/resolve",
      headers: technicianHeaders,
      payload: {
        resolutionNote:
          "Technician should not be permitted to resolve the discrepancy.",
      },
    });
    expect(technicianResolve.statusCode).toBe(403);

    const pharmacistResolve = await app.inject({
      method: "POST",
      url:
        "/api/inventory/exceptions/" +
        inventoryException.id +
        "/resolve",
      headers: pharmacistHeaders,
      payload: {
        resolutionNote:
          "Physical inventory was reconciled and a separate count/adjustment was documented.",
      },
    });
    expect(pharmacistResolve.statusCode).toBe(200);
    expect(pharmacistResolve.json().exception.status).toBe("RESOLVED");

    const audits = await db.auditEvent.findMany({
      where: {
        entityType: "PrescriptionFill",
        entityId: fillId,
      },
    });
    expect(
      audits.map((event) => event.action),
    ).toContain("PRESCRIPTION_FILL_INTERRUPTED_TO_PARTIAL");
  });

  it("restricts emergency supply authorization to pharmacists and keeps it outside refill accounting", async () => {
    const suffix = numericSuffix();
    const gtin = gs1WithCheckDigit(`0077777${suffix}`);
    const lotNumber = `EMERG-${suffix}`;
    const rawBarcode = `(01)${gtin}(17)270630(10)${lotNumber}`;

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

    const received = await app.inject({
      method: "POST",
      url: "/api/receiving/stock",
      headers: technicianHeaders,
      payload: {
        rawBarcode,
        quantity: 100,
        source: "Emergency supply continuity test",
      },
    });
    expect(received.statusCode).toBe(201);

    const prescriptionId = await createPrescription({
      quantity: 30,
      medicationId: "medication-demo-lisinopril-10",
    });
    await moveToDur(prescriptionId);

    const initialFill = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/fills`,
      headers: technicianHeaders,
      payload: { quantity: 30 },
    });
    expect(initialFill.statusCode).toBe(201);
    const initialFillId = initialFill.json().fill.id as string;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/fills/${initialFillId}/scan-barcode`,
          headers: technicianHeaders,
          payload: { rawBarcode },
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${prescriptionId}/status`,
          headers: technicianHeaders,
          payload: { status: "PHARMACIST_REVIEW" },
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${prescriptionId}/status`,
          headers: pharmacistHeaders,
          payload: { status: "READY" },
        })
      ).statusCode,
    ).toBe(200);

    const initialSold = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "SOLD" },
    });
    expect(initialSold.statusCode).toBe(200);
    expect(initialSold.json().prescription.refillsUsed).toBe(0);

    const followUpDueAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const technicianEmergency = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/emergency-supply`,
      headers: technicianHeaders,
      payload: {
        quantity: 3,
        reason:
          "Therapy interruption could create clinically significant risk.",
        followUpDueAt: followUpDueAt.toISOString(),
      },
    });
    expect(technicianEmergency.statusCode).toBe(403);

    const emergency = await app.inject({
      method: "POST",
      url: `/api/prescriptions/${prescriptionId}/emergency-supply`,
      headers: pharmacistHeaders,
      payload: {
        quantity: 3,
        reason:
          "Therapy interruption could create clinically significant risk.",
        followUpDueAt: followUpDueAt.toISOString(),
      },
    });
    expect(emergency.statusCode).toBe(201);
    expect(emergency.json().fill.kind).toBe("EMERGENCY_SUPPLY");
    expect(emergency.json().fill.consumesRefill).toBe(false);
    expect(emergency.json().prescription.status).toBe("PRODUCT_FILL");
    const emergencyFillId = emergency.json().fill.id as string;

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/fills/${emergencyFillId}/scan-barcode`,
          headers: technicianHeaders,
          payload: { rawBarcode },
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${prescriptionId}/status`,
          headers: technicianHeaders,
          payload: { status: "PHARMACIST_REVIEW" },
        })
      ).statusCode,
    ).toBe(200);

    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/prescriptions/${prescriptionId}/status`,
          headers: pharmacistHeaders,
          payload: { status: "READY" },
        })
      ).statusCode,
    ).toBe(200);

    const emergencySold = await app.inject({
      method: "PATCH",
      url: `/api/prescriptions/${prescriptionId}/status`,
      headers: technicianHeaders,
      payload: { status: "SOLD" },
    });
    expect(emergencySold.statusCode).toBe(200);
    expect(emergencySold.json().prescription.refillsUsed).toBe(0);

    const followUpExceptions = await app.inject({
      method: "GET",
      url: "/api/exceptions?kind=EMERGENCY_FOLLOW_UP",
      headers: pharmacistHeaders,
    });
    expect(followUpExceptions.statusCode).toBe(200);
    expect(
      followUpExceptions
        .json()
        .exceptions.some(
          (item: { prescriptionId: string }) =>
            item.prescriptionId === prescriptionId,
        ),
    ).toBe(true);

    const technicianFollowUp = await app.inject({
      method: "POST",
      url: `/api/fills/${emergencyFillId}/emergency-follow-up/complete`,
      headers: technicianHeaders,
      payload: {
        note: "Technician should not be permitted to close this follow-up.",
      },
    });
    expect(technicianFollowUp.statusCode).toBe(403);

    const pharmacistFollowUp = await app.inject({
      method: "POST",
      url: `/api/fills/${emergencyFillId}/emergency-follow-up/complete`,
      headers: pharmacistHeaders,
      payload: {
        note:
          "Prescriber office notified; renewal request documented and forwarded.",
      },
    });
    expect(pharmacistFollowUp.statusCode).toBe(200);
    expect(pharmacistFollowUp.json().fill.followUpCompletedAt).toBeTruthy();

    const afterFollowUp = await app.inject({
      method: "GET",
      url: "/api/exceptions?kind=EMERGENCY_FOLLOW_UP",
      headers: pharmacistHeaders,
    });
    expect(
      afterFollowUp
        .json()
        .exceptions.some(
          (item: { prescriptionId: string }) =>
            item.prescriptionId === prescriptionId,
        ),
    ).toBe(false);

    const audit = await db.auditEvent.findMany({
      where: {
        entityType: "PrescriptionFill",
        entityId: { in: [emergencyFillId] },
      },
    });
    const actions = audit.map((event) => event.action);
    expect(actions).toContain("PRESCRIPTION_EMERGENCY_SUPPLY_AUTHORIZED");
    expect(actions).toContain(
      "PRESCRIPTION_EMERGENCY_SUPPLY_FOLLOW_UP_COMPLETED",
    );
  });
});
