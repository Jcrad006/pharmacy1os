import type { FastifyInstance } from "fastify";
import type {
  FillStatus,
  PrescriptionStatus,
  Prisma,
} from "@prisma/client";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";
import {
  allowedTransitions,
  canTransitionPrescription,
  permissionForTransition,
} from "../workflow/prescriptionWorkflow.js";
import {
  evaluateDispensingDateRules,
  reconcileDateRuleIssues,
  recordDateRuleIssue,
} from "../clinical/dateRules.js";

type CreatePrescriptionBody = {
  patientId?: string;
  prescriberId?: string;
  medicationId?: string;
  rxNumber?: string;
  medicationName?: string;
  strength?: string;
  dosageForm?: string;
  sig?: string;
  quantityWritten?: number;
  refillsAllowed?: number;
  writtenDate?: string;
  expirationDate?: string;
  doNotFillBefore?: string;
  minimumDaysBetweenFills?: number;
};

type UpdatePrescriptionBody = {
  prescriberId?: string;
  medicationId?: string;
  medicationName?: string;
  strength?: string | null;
  dosageForm?: string | null;
  sig?: string;
  quantityWritten?: number;
  refillsAllowed?: number;
  writtenDate?: string | null;
  expirationDate?: string | null;
  doNotFillBefore?: string | null;
  minimumDaysBetweenFills?: number | null;
};

type TransitionBody = {
  status?: PrescriptionStatus;
};

type CreateFillBody = {
  scheduledFor?: string;
  quantity?: number;
};

type ScanProductBody = {
  ndc?: string;
  lotNumber?: string;
  expirationDate?: string;
};

const validStatuses = new Set<PrescriptionStatus>([
  "RECEIVED",
  "DATA_ENTRY",
  "DUR_REVIEW",
  "PRODUCT_FILL",
  "PHARMACIST_REVIEW",
  "READY",
  "SOLD",
  "ON_HOLD",
  "CANCELLED",
  "TRANSFERRED",
]);

const editableStatuses = new Set<PrescriptionStatus>([
  "RECEIVED",
  "DATA_ENTRY",
  "DUR_REVIEW",
  "ON_HOLD",
]);

const prescriptionInclude = {
  patient: true,
  medication: true,
  prescriber: {
    include: {
      identifiers: {
        orderBy: [{ type: "asc" as const }, { isPrimary: "desc" as const }, { createdAt: "asc" as const }],
      },
      contacts: {
        orderBy: [{ type: "asc" as const }, { isPrimary: "desc" as const }, { createdAt: "asc" as const }],
      },
      addresses: {
        orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
      },
    },
  },
  fills: {
    include: {
      product: { include: { manufacturer: true } },
      productLot: true,
      productExpiration: true,
    },
    orderBy: { fillNumber: "desc" as const },
  },
};

function presentPrescription<
  T extends {
    status: PrescriptionStatus;
    heldFromStatus: PrescriptionStatus | null;
  },
>(rx: T) {
  return {
    ...rx,
    allowedTransitions: allowedTransitions(rx.status, rx.heldFromStatus),
  };
}

function parseDate(value?: string | null) {
  if (value === null) return null;
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date;
}

function activeFill(
  fills: Array<{
    id: string;
    fillNumber: number;
    status: FillStatus;
  }>,
) {
  return fills.find((fill) =>
    ["SCHEDULED", "IN_PROGRESS", "READY"].includes(fill.status),
  );
}

function auditValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "object" && "toString" in value) {
    return String(value);
  }
  return String(value);
}

function prescriptionSnapshot(rx: {
  prescriberId: string;
  medicationId: string | null;
  medicationName: string;
  strength: string | null;
  dosageForm: string | null;
  sig: string;
  quantityWritten: unknown;
  refillsAllowed: number;
  writtenDate: Date | null;
  expirationDate: Date | null;
  doNotFillBefore: Date | null;
  minimumDaysBetweenFills: number | null;
}) {
  return {
    prescriberId: auditValue(rx.prescriberId),
    medicationId: auditValue(rx.medicationId),
    medicationName: auditValue(rx.medicationName),
    strength: auditValue(rx.strength),
    dosageForm: auditValue(rx.dosageForm),
    sig: auditValue(rx.sig),
    quantityWritten: auditValue(rx.quantityWritten),
    refillsAllowed: auditValue(rx.refillsAllowed),
    writtenDate: auditValue(rx.writtenDate),
    expirationDate: auditValue(rx.expirationDate),
    doNotFillBefore: auditValue(rx.doNotFillBefore),
    minimumDaysBetweenFills: auditValue(rx.minimumDaysBetweenFills),
  };
}

function diffSnapshots(
  before: Record<string, string | number | boolean | null>,
  after: Record<string, string | number | boolean | null>,
) {
  const changes: Record<
    string,
    { before: string | number | boolean | null; after: string | number | boolean | null }
  > = {};

  for (const key of Object.keys(before)) {
    if (before[key] !== after[key]) {
      changes[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
  }

  return changes;
}

export async function prescriptionRoutes(app: FastifyInstance) {
  app.get("/prescriptions/queue", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const query = request.query as {
        status?: PrescriptionStatus;
        query?: string;
        sort?: "oldest" | "newest";
        limit?: string;
      };
      const requestedStatus = query.status;
      const search = String(query.query ?? "").trim();
      const sort = query.sort === "newest" ? "newest" : "oldest";
      const parsedLimit = Number.parseInt(String(query.limit ?? "100"), 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(200, Math.max(1, parsedLimit))
        : 100;

      if (requestedStatus && !validStatuses.has(requestedStatus)) {
        return reply.code(400).send({ error: "Invalid prescription status." });
      }

      const prescriptions = await db.prescription.findMany({
        where: {
          siteId: actor.siteId,
          ...(requestedStatus ? { status: requestedStatus } : {}),
          ...(search
            ? {
                OR: [
                  { rxNumber: { contains: search, mode: "insensitive" } },
                  { medicationName: { contains: search, mode: "insensitive" } },
                  { patient: { firstName: { contains: search, mode: "insensitive" } } },
                  { patient: { lastName: { contains: search, mode: "insensitive" } } },
                  { prescriber: { firstName: { contains: search, mode: "insensitive" } } },
                  { prescriber: { lastName: { contains: search, mode: "insensitive" } } },
                ],
              }
            : {}),
        },
        include: prescriptionInclude,
        orderBy: [{ updatedAt: sort === "oldest" ? "asc" : "desc" }],
        take: limit,
      });

      return {
        prescriptions: prescriptions.map(presentPrescription),
        meta: {
          query: search,
          status: requestedStatus ?? null,
          sort,
          returned: prescriptions.length,
          limit,
        },
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/prescriptions/will-call", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");

      const prescriptions = await db.prescription.findMany({
        where: {
          siteId: actor.siteId,
          status: "READY",
        },
        include: prescriptionInclude,
        orderBy: [{ updatedAt: "asc" }],
        take: 200,
      });

      return {
        prescriptions: prescriptions.map(presentPrescription),
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/prescriptions/:id", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const id = (request.params as { id: string }).id;

      const prescription = await db.prescription.findFirst({
        where: { id, siteId: actor.siteId },
        include: prescriptionInclude,
      });

      if (!prescription) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      return { prescription: presentPrescription(prescription) };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/prescriptions/:id/audit", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "audit:read");
      const id = (request.params as { id: string }).id;

      const prescription = await db.prescription.findFirst({
        where: { id, siteId: actor.siteId },
        select: { id: true },
      });

      if (!prescription) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      const fillIds = await db.prescriptionFill.findMany({
        where: { prescriptionId: id },
        select: { id: true },
      });

      const events = await db.auditEvent.findMany({
        where: {
          siteId: actor.siteId,
          OR: [
            { entityType: "Prescription", entityId: id },
            {
              entityType: "PrescriptionFill",
              entityId: { in: fillIds.map((fill) => fill.id) },
            },
          ],
        },
        include: {
          actor: {
            select: {
              displayName: true,
              role: true,
            },
          },
        },
        orderBy: { occurredAt: "desc" },
        take: 200,
      });

      return { events };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/prescriptions", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:enter");
      const body = request.body as CreatePrescriptionBody;

      if (
        !body.patientId ||
        !body.prescriberId ||
        (!body.medicationId && !body.medicationName?.trim()) ||
        !body.sig?.trim()
      ) {
        return reply.code(400).send({
          error: "patientId, prescriberId, a medication selection, and sig are required.",
        });
      }

      const writtenDate = parseDate(body.writtenDate);
      const expirationDate = parseDate(body.expirationDate);
      const doNotFillBefore = parseDate(body.doNotFillBefore);

      if (
        writtenDate === "invalid" ||
        expirationDate === "invalid" ||
        doNotFillBefore === "invalid"
      ) {
        return reply.code(400).send({ error: "Invalid date value." });
      }

      const [patient, prescriber, selectedMedication] = await Promise.all([
        db.patient.findFirst({ where: { id: body.patientId, siteId: actor.siteId } }),
        db.prescriber.findFirst({ where: { id: body.prescriberId, siteId: actor.siteId } }),
        body.medicationId
          ? db.medication.findUnique({ where: { id: body.medicationId } })
          : Promise.resolve(null),
      ]);

      if (!patient || !prescriber) {
        return reply.code(400).send({
          error: "Patient or prescriber does not belong to this pharmacy site.",
        });
      }

      if (body.medicationId && (!selectedMedication || !selectedMedication.active)) {
        return reply.code(400).send({
          error: "Selected drug does not exist or is inactive.",
        });
      }

      const prescription = await db.$transaction(async (tx) => {
        const created = await tx.prescription.create({
          data: {
            siteId: actor.siteId,
            patientId: body.patientId!,
            prescriberId: body.prescriberId!,
            medicationId: selectedMedication?.id,
            rxNumber: body.rxNumber?.trim() || undefined,
            medicationName:
              selectedMedication?.genericName ?? body.medicationName!.trim(),
            strength:
              selectedMedication?.strength ?? (body.strength?.trim() || undefined),
            dosageForm:
              selectedMedication?.dosageForm ?? (body.dosageForm?.trim() || undefined),
            sig: body.sig!.trim(),
            quantityWritten: body.quantityWritten,
            refillsAllowed: Math.max(0, body.refillsAllowed ?? 0),
            writtenDate: writtenDate instanceof Date ? writtenDate : undefined,
            expirationDate: expirationDate instanceof Date ? expirationDate : undefined,
            doNotFillBefore: doNotFillBefore instanceof Date ? doNotFillBefore : undefined,
            minimumDaysBetweenFills:
              body.minimumDaysBetweenFills !== undefined
                ? Math.max(0, Math.trunc(body.minimumDaysBetweenFills))
                : undefined,
            status: "DATA_ENTRY",
          },
          include: prescriptionInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIPTION_CREATED",
          entityType: "Prescription",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            rxNumber: created.rxNumber ?? null,
            medicationId: created.medicationId ?? null,
          },
        });

        return created;
      });

      return reply.code(201).send({
        prescription: presentPrescription(prescription),
      });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch("/prescriptions/:id", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:edit");
      const id = (request.params as { id: string }).id;
      const body = request.body as UpdatePrescriptionBody;

      const current = await db.prescription.findFirst({
        where: { id, siteId: actor.siteId },
        include: prescriptionInclude,
      });

      if (!current) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      if (!editableStatuses.has(current.status)) {
        return reply.code(409).send({
          error: "This prescription cannot be edited in its current workflow state.",
        });
      }

      if (activeFill(current.fills)) {
        return reply.code(409).send({
          error: "An active fill must be resolved before editing the prescription.",
        });
      }

      const suppliedFields = Object.keys(body).filter((key) =>
        [
          "prescriberId",
          "medicationId",
          "medicationName",
          "strength",
          "dosageForm",
          "sig",
          "quantityWritten",
          "refillsAllowed",
          "writtenDate",
          "expirationDate",
          "doNotFillBefore",
          "minimumDaysBetweenFills",
        ].includes(key),
      );

      if (suppliedFields.length === 0) {
        return reply.code(400).send({ error: "No editable prescription fields supplied." });
      }

      if (body.medicationName !== undefined && !body.medicationName.trim()) {
        return reply.code(400).send({ error: "Medication name cannot be blank." });
      }

      if (body.sig !== undefined && !body.sig.trim()) {
        return reply.code(400).send({ error: "Sig cannot be blank." });
      }

      if (
        body.quantityWritten !== undefined &&
        (!Number.isFinite(body.quantityWritten) || body.quantityWritten <= 0)
      ) {
        return reply.code(400).send({ error: "Quantity must be greater than zero." });
      }

      if (
        body.refillsAllowed !== undefined &&
        (!Number.isInteger(body.refillsAllowed) ||
          body.refillsAllowed < current.refillsUsed)
      ) {
        return reply.code(400).send({
          error: "Refills allowed cannot be less than refills already used.",
        });
      }

      if (
        body.minimumDaysBetweenFills !== undefined &&
        body.minimumDaysBetweenFills !== null &&
        (!Number.isInteger(body.minimumDaysBetweenFills) ||
          body.minimumDaysBetweenFills < 0 ||
          body.minimumDaysBetweenFills > 365)
      ) {
        return reply.code(400).send({
          error: "minimumDaysBetweenFills must be an integer from 0 to 365.",
        });
      }

      let selectedMedicationForEdit: {
        id: string;
        genericName: string;
        strength: string;
        dosageForm: string;
        active: boolean;
      } | null = null;

      if (body.medicationId !== undefined) {
        selectedMedicationForEdit = await db.medication.findUnique({
          where: { id: body.medicationId },
          select: {
            id: true,
            genericName: true,
            strength: true,
            dosageForm: true,
            active: true,
          },
        });
        if (!selectedMedicationForEdit || !selectedMedicationForEdit.active) {
          return reply.code(400).send({
            error: "Selected drug does not exist or is inactive.",
          });
        }
      }

      if (body.prescriberId !== undefined) {
        const prescriber = await db.prescriber.findFirst({
          where: { id: body.prescriberId, siteId: actor.siteId },
          select: { id: true },
        });
        if (!prescriber) {
          return reply.code(400).send({
            error: "Prescriber does not belong to this pharmacy site.",
          });
        }
      }

      const writtenDate = parseDate(body.writtenDate);
      const expirationDate = parseDate(body.expirationDate);
      const doNotFillBefore = parseDate(body.doNotFillBefore);

      if (
        writtenDate === "invalid" ||
        expirationDate === "invalid" ||
        doNotFillBefore === "invalid"
      ) {
        return reply.code(400).send({ error: "Invalid date value." });
      }

      const before = prescriptionSnapshot(current);

      const data: Prisma.PrescriptionUpdateInput = {};
      if (body.prescriberId !== undefined) {
        data.prescriber = { connect: { id: body.prescriberId } };
      }
      if (selectedMedicationForEdit) {
        data.medication = { connect: { id: selectedMedicationForEdit.id } };
        data.medicationName = selectedMedicationForEdit.genericName;
        data.strength = selectedMedicationForEdit.strength;
        data.dosageForm = selectedMedicationForEdit.dosageForm;
      } else if (body.medicationName !== undefined) data.medicationName = body.medicationName.trim();
      if (body.strength !== undefined) data.strength = body.strength?.trim() || null;
      if (body.dosageForm !== undefined) data.dosageForm = body.dosageForm?.trim() || null;
      if (body.sig !== undefined) data.sig = body.sig.trim();
      if (body.quantityWritten !== undefined) data.quantityWritten = body.quantityWritten;
      if (body.refillsAllowed !== undefined) data.refillsAllowed = body.refillsAllowed;
      if (body.writtenDate !== undefined) data.writtenDate = writtenDate instanceof Date ? writtenDate : null;
      if (body.expirationDate !== undefined) data.expirationDate = expirationDate instanceof Date ? expirationDate : null;
      if (body.doNotFillBefore !== undefined) data.doNotFillBefore = doNotFillBefore instanceof Date ? doNotFillBefore : null;
      if (body.minimumDaysBetweenFills !== undefined) {
        data.minimumDaysBetweenFills = body.minimumDaysBetweenFills;
      }

      let workflowReset: { from: PrescriptionStatus; to: PrescriptionStatus } | null = null;

      if (current.status === "DUR_REVIEW") {
        data.status = "DATA_ENTRY";
        workflowReset = { from: "DUR_REVIEW", to: "DATA_ENTRY" };
      } else if (
        current.status === "ON_HOLD" &&
        current.heldFromStatus === "DUR_REVIEW"
      ) {
        data.heldFromStatus = "DATA_ENTRY";
        workflowReset = { from: "DUR_REVIEW", to: "DATA_ENTRY" };
      } else if (current.status === "RECEIVED") {
        data.status = "DATA_ENTRY";
        workflowReset = { from: "RECEIVED", to: "DATA_ENTRY" };
      }

      const updated = await db.$transaction(async (tx) => {
        const rx = await tx.prescription.update({
          where: { id },
          data,
          include: prescriptionInclude,
        });

        const after = prescriptionSnapshot(rx);
        const changes = diffSnapshots(before, after);

        if (Object.keys(changes).length > 0 || workflowReset) {
          await writeAuditEvent(tx, {
            siteId: actor.siteId,
            actorId: actor.id,
            action: "PRESCRIPTION_EDITED",
            entityType: "Prescription",
            entityId: id,
            requestId: request.id,
            metadata: {
              changes,
              workflowReset,
            },
          });
        }

        return rx;
      });

      return { prescription: presentPrescription(updated) };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch("/prescriptions/:id/status", async (request, reply) => {
    try {
      const body = request.body as TransitionBody;
      const id = (request.params as { id: string }).id;

      if (!body.status || !validStatuses.has(body.status)) {
        return reply.code(400).send({ error: "A valid target status is required." });
      }

      const current = await db.prescription.findUnique({
        where: { id },
        include: { fills: { orderBy: { fillNumber: "desc" } } },
      });

      if (!current) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      const actor = await resolveDevelopmentActor(
        request,
        permissionForTransition(current.status, body.status),
      );

      if (current.siteId !== actor.siteId) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      if (
        !canTransitionPrescription(
          current.status,
          body.status,
          current.heldFromStatus,
        )
      ) {
        return reply.code(409).send({
          error: `Transition ${current.status} → ${body.status} is not allowed.`,
          allowedTransitions: allowedTransitions(
            current.status,
            current.heldFromStatus,
          ),
        });
      }

      if (
        current.status === "SOLD" &&
        body.status === "DUR_REVIEW" &&
        current.refillsUsed >= current.refillsAllowed
      ) {
        return reply.code(409).send({ error: "No refills remain on this prescription." });
      }

      const currentActiveFill = activeFill(current.fills);

      if (
        current.status === "PHARMACIST_REVIEW" &&
        body.status === "READY"
      ) {
        const openHighIssues = await db.durIssue.findMany({
          where: {
            prescriptionId: id,
            status: "OPEN",
            severity: "HIGH",
          },
          select: {
            id: true,
            code: true,
            title: true,
          },
          orderBy: { createdAt: "asc" },
        });

        if (openHighIssues.length > 0) {
          return reply.code(409).send({
            error:
              "Resolve all HIGH DUR issues before final pharmacist verification.",
            code: "OPEN_HIGH_DUR",
            issues: openHighIssues,
          });
        }
      }

      if (
        current.status === "PRODUCT_FILL" &&
        body.status === "PHARMACIST_REVIEW" &&
        currentActiveFill?.status !== "IN_PROGRESS"
      ) {
        return reply.code(409).send({
          error: "An in-progress fill is required before pharmacist review.",
        });
      }

      if (
        current.status === "PRODUCT_FILL" &&
        body.status === "PHARMACIST_REVIEW" &&
        current.medicationId &&
        (!currentActiveFill?.productId ||
          !currentActiveFill.productLotId ||
          !currentActiveFill.productExpirationId ||
          !currentActiveFill.productVerifiedAt)
      ) {
        return reply.code(409).send({
          error:
            "A verified NDC, lot, and expiration scan is required before pharmacist review.",
          code: "PRODUCT_SCAN_REQUIRED",
        });
      }

      if (
        current.status === "PHARMACIST_REVIEW" &&
        body.status === "READY" &&
        currentActiveFill?.status !== "IN_PROGRESS"
      ) {
        return reply.code(409).send({
          error: "An in-progress fill is required for pharmacist verification.",
        });
      }

      if (
        current.status === "READY" &&
        body.status === "SOLD" &&
        currentActiveFill?.status !== "READY"
      ) {
        return reply.code(409).send({
          error: "A ready fill is required before sale.",
        });
      }

      const updated = await db.$transaction(async (tx) => {
        const prescriptionData: Prisma.PrescriptionUpdateInput = {
          status: body.status,
        };

        if (body.status === "ON_HOLD") {
          prescriptionData.heldFromStatus = current.status;
        } else if (current.status === "ON_HOLD") {
          prescriptionData.heldFromStatus = null;
        }

        if (body.status === "CANCELLED" || body.status === "TRANSFERRED") {
          prescriptionData.heldFromStatus = null;
        }

        if (
          current.status === "PHARMACIST_REVIEW" &&
          body.status === "READY" &&
          currentActiveFill
        ) {
          await tx.prescriptionFill.update({
            where: { id: currentActiveFill.id },
            data: {
              status: "READY",
              filledAt: new Date(),
            },
          });
        }

        if (
          current.status === "READY" &&
          body.status === "SOLD" &&
          currentActiveFill
        ) {
          await tx.prescriptionFill.update({
            where: { id: currentActiveFill.id },
            data: {
              status: "SOLD",
              soldAt: new Date(),
            },
          });

          prescriptionData.refillsUsed = Math.max(
            current.refillsUsed,
            currentActiveFill.fillNumber,
          );
        }

        if (
          (body.status === "CANCELLED" || body.status === "TRANSFERRED") &&
          currentActiveFill
        ) {
          await tx.prescriptionFill.update({
            where: { id: currentActiveFill.id },
            data: { status: "CANCELLED" },
          });
        }

        const rx = await tx.prescription.update({
          where: { id },
          data: prescriptionData,
          include: prescriptionInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIPTION_STATUS_CHANGED",
          entityType: "Prescription",
          entityId: id,
          requestId: request.id,
          metadata: {
            from: current.status,
            to: body.status,
            resumedFromHold:
              current.status === "ON_HOLD" ? current.heldFromStatus : null,
          },
        });

        return rx;
      });

      return { prescription: presentPrescription(updated) };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/prescriptions/:id/fills", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:process");
      const id = (request.params as { id: string }).id;
      const body = request.body as CreateFillBody;

      const prescription = await db.prescription.findFirst({
        where: { id, siteId: actor.siteId },
        include: prescriptionInclude,
      });

      if (!prescription) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      if (prescription.status !== "DUR_REVIEW") {
        return reply.code(409).send({
          error: "A fill can only be created after DUR review.",
        });
      }

      if (activeFill(prescription.fills)) {
        return reply.code(409).send({
          error: "This prescription already has an active fill.",
        });
      }

      const scheduledFor = parseDate(body.scheduledFor);
      if (scheduledFor === "invalid") {
        return reply.code(400).send({ error: "Invalid scheduledFor date." });
      }

      const now = new Date();
      const isFuture = Boolean(
        scheduledFor instanceof Date && scheduledFor.getTime() > now.getTime(),
      );

      const targetDate = scheduledFor instanceof Date ? scheduledFor : now;

      await reconcileDateRuleIssues({
        prescription,
        targetDate,
        actorId: actor.id,
        requestId: request.id,
      });

      const dateRuleBlock = evaluateDispensingDateRules(prescription, targetDate);

      if (dateRuleBlock) {
        await recordDateRuleIssue({
          prescription,
          block: dateRuleBlock,
          actorId: actor.id,
          requestId: request.id,
        });

        return reply.code(409).send({
          error: dateRuleBlock.message,
          code: dateRuleBlock.code,
          eligibleAt: dateRuleBlock.eligibleAt?.toISOString() ?? null,
        });
      }

      const latestFill = prescription.fills[0];

      if (latestFill?.status === "RETURNED_TO_STOCK") {
        const result = await db.$transaction(async (tx) => {
          const reprocessed = await tx.prescriptionFill.update({
            where: { id: latestFill.id },
            data: {
              scheduledFor: scheduledFor instanceof Date ? scheduledFor : null,
              quantity: body.quantity ?? prescription.quantityWritten ?? undefined,
              status: isFuture ? "SCHEDULED" : "IN_PROGRESS",
              productId: null,
              productLotId: null,
              productExpirationId: null,
              scannedNdc: null,
              scannedLotNumber: null,
              scannedExpiration: null,
              productVerifiedAt: null,
              filledAt: null,
              soldAt: null,
            },
          });

          const rx = await tx.prescription.update({
            where: { id: prescription.id },
            data: { status: isFuture ? "DUR_REVIEW" : "PRODUCT_FILL" },
            include: prescriptionInclude,
          });

          await writeAuditEvent(tx, {
            siteId: actor.siteId,
            actorId: actor.id,
            action: "PRESCRIPTION_FILL_REPROCESSED",
            entityType: "PrescriptionFill",
            entityId: reprocessed.id,
            requestId: request.id,
            metadata: {
              prescriptionId: prescription.id,
              fillNumber: reprocessed.fillNumber,
              scheduledFor: reprocessed.scheduledFor?.toISOString() ?? null,
              immediate: !isFuture,
            },
          });

          return { fill: reprocessed, prescription: rx };
        });

        return reply.code(201).send({
          fill: result.fill,
          prescription: presentPrescription(result.prescription),
        });
      }

      const nextFillNumber = (latestFill?.fillNumber ?? -1) + 1;
      const totalFillsAllowed = prescription.refillsAllowed + 1;

      if (nextFillNumber >= totalFillsAllowed) {
        return reply.code(409).send({ error: "No fills remain on this prescription." });
      }

      const result = await db.$transaction(async (tx) => {
        const created = await tx.prescriptionFill.create({
          data: {
            prescriptionId: prescription.id,
            fillNumber: nextFillNumber,
            scheduledFor: scheduledFor instanceof Date ? scheduledFor : undefined,
            quantity: body.quantity ?? prescription.quantityWritten ?? undefined,
            status: isFuture ? "SCHEDULED" : "IN_PROGRESS",
          },
        });

        const rx = await tx.prescription.update({
          where: { id: prescription.id },
          data: { status: isFuture ? "DUR_REVIEW" : "PRODUCT_FILL" },
          include: prescriptionInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIPTION_FILL_CREATED",
          entityType: "PrescriptionFill",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            prescriptionId: prescription.id,
            fillNumber: created.fillNumber,
            scheduledFor: created.scheduledFor?.toISOString() ?? null,
            immediate: !isFuture,
          },
        });

        return { fill: created, prescription: rx };
      });

      return reply.code(201).send({
        fill: result.fill,
        prescription: presentPrescription(result.prescription),
      });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/fills/:id/scan-product", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:process");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as ScanProductBody;

      const ndcSearch = (body.ndc ?? "").replace(/\D/g, "");
      const lotNumber = body.lotNumber?.trim();
      const lotNumberSearch = (lotNumber ?? "")
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase();
      const scannedExpiration = parseDate(body.expirationDate);

      if (!ndcSearch || !lotNumberSearch || !(scannedExpiration instanceof Date)) {
        return reply.code(400).send({
          error: "NDC, lot number, and expiration date are required from the scan.",
        });
      }

      const fill = await db.prescriptionFill.findUnique({
        where: { id },
        include: {
          prescription: { include: { medication: true } },
        },
      });

      if (!fill || fill.prescription.siteId !== actor.siteId) {
        return reply.code(404).send({ error: "Fill not found." });
      }

      if (
        fill.status !== "IN_PROGRESS" ||
        fill.prescription.status !== "PRODUCT_FILL"
      ) {
        return reply.code(409).send({
          error: "Product scanning is only allowed during an in-progress Product Fill.",
        });
      }

      if (!fill.prescription.medicationId || !fill.prescription.medication) {
        return reply.code(409).send({
          error:
            "This legacy prescription has no catalog drug selection. Select a drug before product verification.",
          code: "DRUG_SELECTION_REQUIRED",
        });
      }

      const product = await db.product.findUnique({
        where: { ndcSearch },
        include: {
          manufacturer: true,
          medication: true,
        },
      });

      if (!product || !product.active) {
        return reply.code(409).send({
          error: "The scanned NDC is not an active catalog product.",
          code: "UNKNOWN_NDC",
        });
      }

      if (product.medicationId !== fill.prescription.medicationId) {
        return reply.code(409).send({
          error:
            "The scanned NDC belongs to a different drug than the drug selected during Data Entry.",
          code: "NDC_DRUG_MISMATCH",
          expectedDrug: {
            id: fill.prescription.medication.id,
            genericName: fill.prescription.medication.genericName,
            strength: fill.prescription.medication.strength,
            dosageForm: fill.prescription.medication.dosageForm,
          },
          scannedDrug: {
            id: product.medication.id,
            genericName: product.medication.genericName,
            strength: product.medication.strength,
            dosageForm: product.medication.dosageForm,
          },
        });
      }

      const [lot, expiration] = await Promise.all([
        db.productLot.findFirst({
          where: {
            siteId: actor.siteId,
            productId: product.id,
            lotNumberSearch,
            active: true,
          },
        }),
        db.productExpiration.findFirst({
          where: {
            siteId: actor.siteId,
            productId: product.id,
            expirationDate: scannedExpiration,
            active: true,
          },
        }),
      ]);

      if (!lot) {
        return reply.code(409).send({
          error: "The scanned lot is not cataloged under this NDC at this pharmacy site.",
          code: "LOT_NDC_MISMATCH",
        });
      }

      if (!expiration) {
        return reply.code(409).send({
          error:
            "The scanned expiration date is not cataloged under this NDC at this pharmacy site.",
          code: "EXPIRATION_NDC_MISMATCH",
        });
      }

      const expirationEnd = new Date(expiration.expirationDate);
      expirationEnd.setUTCHours(23, 59, 59, 999);
      if (expirationEnd.getTime() < Date.now()) {
        return reply.code(409).send({
          error: "The scanned product is expired.",
          code: "PRODUCT_EXPIRED",
        });
      }

      const result = await db.$transaction(async (tx) => {
        const verifiedAt = new Date();
        const verified = await tx.prescriptionFill.update({
          where: { id },
          data: {
            productId: product.id,
            productLotId: lot.id,
            productExpirationId: expiration.id,
            scannedNdc: product.ndc,
            scannedLotNumber: lot.lotNumber,
            scannedExpiration: expiration.expirationDate,
            productVerifiedAt: verifiedAt,
          },
          include: {
            product: { include: { manufacturer: true } },
            productLot: true,
            productExpiration: true,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "FILL_PRODUCT_SCAN_VERIFIED",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            prescriptionId: fill.prescriptionId,
            medicationId: fill.prescription.medicationId,
            productId: product.id,
            ndc: product.ndc,
            lotNumber: lot.lotNumber,
            expirationDate: expiration.expirationDate.toISOString(),
            manufacturerName: product.manufacturer.name,
          },
        });

        return verified;
      });

      return {
        fill: result,
        verifiedProduct: {
          drug: product.medication,
          product: {
            id: product.id,
            ndc: product.ndc,
            descriptor: product.descriptor,
            manufacturer: product.manufacturer,
          },
          lot,
          expiration,
        },
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/fills/:id/start", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:process");
      const id = (request.params as { id: string }).id;

      const fill = await db.prescriptionFill.findUnique({
        where: { id },
        include: {
          prescription: {
            include: prescriptionInclude,
          },
        },
      });

      if (!fill || fill.prescription.siteId !== actor.siteId) {
        return reply.code(404).send({ error: "Fill not found." });
      }

      if (fill.status !== "SCHEDULED") {
        return reply.code(409).send({ error: "Only a scheduled fill can be started." });
      }

      if (fill.scheduledFor && fill.scheduledFor.getTime() > Date.now()) {
        return reply.code(409).send({
          error: "This fill is scheduled for a future date.",
        });
      }

      if (fill.prescription.status !== "DUR_REVIEW") {
        return reply.code(409).send({
          error: "The prescription must be in DUR Review before starting the fill.",
        });
      }

      const startTime = new Date();

      await reconcileDateRuleIssues({
        prescription: fill.prescription,
        targetDate: startTime,
        actorId: actor.id,
        requestId: request.id,
      });

      const dateRuleBlock = evaluateDispensingDateRules(
        fill.prescription,
        startTime,
      );

      if (dateRuleBlock) {
        await recordDateRuleIssue({
          prescription: fill.prescription,
          block: dateRuleBlock,
          actorId: actor.id,
          requestId: request.id,
        });

        return reply.code(409).send({
          error: dateRuleBlock.message,
          code: dateRuleBlock.code,
          eligibleAt: dateRuleBlock.eligibleAt?.toISOString() ?? null,
        });
      }

      const result = await db.$transaction(async (tx) => {
        const started = await tx.prescriptionFill.update({
          where: { id },
          data: { status: "IN_PROGRESS" },
        });

        const rx = await tx.prescription.update({
          where: { id: fill.prescriptionId },
          data: { status: "PRODUCT_FILL" },
          include: prescriptionInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIPTION_FILL_STARTED",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            prescriptionId: fill.prescriptionId,
            fillNumber: fill.fillNumber,
          },
        });

        return { fill: started, prescription: rx };
      });

      return {
        fill: result.fill,
        prescription: presentPrescription(result.prescription),
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/fills/:id/return-to-stock", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:process");
      const id = (request.params as { id: string }).id;

      const fill = await db.prescriptionFill.findUnique({
        where: { id },
        include: {
          prescription: {
            include: prescriptionInclude,
          },
        },
      });

      if (!fill || fill.prescription.siteId !== actor.siteId) {
        return reply.code(404).send({ error: "Fill not found." });
      }

      if (fill.status !== "READY" || fill.prescription.status !== "READY") {
        return reply.code(409).send({
          error: "Only a Ready, unsold fill can be returned to stock.",
        });
      }

      const result = await db.$transaction(async (tx) => {
        const returned = await tx.prescriptionFill.update({
          where: { id },
          data: {
            status: "RETURNED_TO_STOCK",
            soldAt: null,
          },
        });

        const rx = await tx.prescription.update({
          where: { id: fill.prescriptionId },
          data: { status: "DUR_REVIEW" },
          include: prescriptionInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIPTION_FILL_RETURNED_TO_STOCK",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            prescriptionId: fill.prescriptionId,
            fillNumber: fill.fillNumber,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIPTION_STATUS_CHANGED",
          entityType: "Prescription",
          entityId: fill.prescriptionId,
          requestId: request.id,
          metadata: {
            from: "READY",
            to: "DUR_REVIEW",
            reason: "RETURN_TO_STOCK",
          },
        });

        return { fill: returned, prescription: rx };
      });

      return {
        fill: result.fill,
        prescription: presentPrescription(result.prescription),
      };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
