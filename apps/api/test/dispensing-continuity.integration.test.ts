import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
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

describe("Phase 3I dispensing continuity", () => {
  it("creates a technician-entered partial fill and prompts a linked completion without consuming another refill", async () => {
    const prescriptionId = await createPrescription({
      quantity: 90,
      medicationName: "Synthetic Partial Drug",
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

    const completion = partial.json().completionFill;
    expect(completion.kind).toBe("COMPLETION");
    expect(Number(completion.quantity)).toBe(87);
    expect(completion.fillNumber).toBe(0);
    expect(completion.partNumber).toBe(2);
    expect(completion.consumesRefill).toBe(false);
    expect(completion.completionOfFillId).toBe(fillId);

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

    const soldPartial = await moveToSoldWithoutCatalog(prescriptionId);
    expect(soldPartial.refillsUsed).toBe(0);

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
  });

  it("restricts emergency supply authorization to pharmacists and keeps it outside refill accounting", async () => {
    const suffix = numericSuffix();
    const gtin = `0077777${suffix}0`;
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
