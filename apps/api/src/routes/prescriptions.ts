import type { FastifyInstance } from "fastify";
import {
  Prisma,
  type FillInterruptionReason,
  type FillStatus,
  type PrescriptionStatus,
  type ProductSelectionDirective,
} from "@prisma/client";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";
import {
  allowedTransitions,
  canTransitionPrescription,
  permissionForTransition,
} from "../workflow/prescriptionWorkflow.js";
import { parseBarcode } from "../barcode.js";
import {
  evaluateDispensingDateRules,
  reconcileDateRuleIssues,
  recordDateRuleIssue,
} from "../clinical/dateRules.js";
import {
  commitInventoryForFill,
  InventoryError,
  getFillSourceReservationSummary,
  releaseInventoryReservation,
  removeInventorySourceForFill,
  reserveInventoryForFill,
  reserveInventorySourceForFill,
  resizeInventoryReservationForFill,
  returnInventoryForFill,
} from "../inventory.js";
import {
  validateFillProductSourceCompliance,
} from "../productFillCompliance.js";
import {
  cancelDemandForFill,
  createOrUpdateFillDemand,
} from "../inventoryArchitecture.js";
import {
  adjudicateFillClaims,
  assertFillBillingReadyForReview,
  assertNoActivePaidClaimForMutation,
  ClaimError,
  reverseActivePaidClaimsForFill,
} from "../claims/service.js";

type CreatePrescriptionBody = {
  patientId?: string;
  prescriberId?: string;
  medicationId?: string;
  prescribedProductId?: string;
  productSelectionDirective?: ProductSelectionDirective;
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
  prescribedProductId?: string | null;
  productSelectionDirective?: ProductSelectionDirective;
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
  daysSupply?: number;
};

type CreatePartialFillBody = {
  dispenseQuantity?: number;
  completionScheduledFor?: string;
  interruptionReason?: FillInterruptionReason;
  reason?: string;
};

type CreateEmergencySupplyBody = {
  quantity?: number;
  reason?: string;
  followUpDueAt?: string;
};

type CompleteEmergencyFollowUpBody = {
  note?: string;
};

type ScanProductBody = {
  ndc?: string;
  lotNumber?: string;
  expirationDate?: string;
  sourceQuantity?: number;
};

type ScanBarcodeBody = {
  rawBarcode?: string;
  sourceQuantity?: number;
};

const productSelectionDirectives = new Set<ProductSelectionDirective>([
  "UNSPECIFIED",
  "SELECTION_PERMITTED",
  "DISPENSE_AS_WRITTEN",
]);

const fillInterruptionReasons = new Set<FillInterruptionReason>([
  "INSUFFICIENT_PHYSICAL_STOCK",
  "DAMAGED_PRODUCT",
  "EXPIRED_PRODUCT",
  "STOCK_DISCREPANCY",
  "OTHER",
]);

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
  prescribedProduct: { include: { manufacturer: true } },
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
      inventoryBalance: true,
      productSources: {
        include: {
          product: { include: { manufacturer: true, medication: true } },
          manufacturer: true,
          productLot: true,
          productExpiration: true,
          inventoryBalance: true,
        },
        orderBy: { sequence: "asc" as const },
      },
      biologicCommunicationTask: true,
      willCallPackage: {
        include: { location: true },
      },
    },
    orderBy: [
      { fillNumber: "desc" as const },
      { partNumber: "desc" as const },
      { createdAt: "desc" as const },
    ],
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

async function tryAutoAdjudication(
  fillId: string,
  actor: { id: string; siteId: string },
  requestId?: string,
) {
  try {
    return await adjudicateFillClaims(fillId, {
      siteId: actor.siteId,
      actorId: actor.id,
      requestId,
      retryRejected: false,
    });
  } catch (error) {
    if (error instanceof ClaimError) {
      return {
        state: "BLOCKED" as const,
        code: error.code,
        error: error.message,
        details: error.details,
        transactions: [],
        label: null,
        printJob: null,
        labels: [],
        printJobs: [],
      };
    }
    throw error;
  }
}

function activeFill(
  fills: Array<{
    id: string;
    fillNumber: number;
    partNumber?: number;
    status: FillStatus;
    consumesRefill?: boolean;
    kind?: string;
    quantity?: Prisma.Decimal | null;
    billingAnchorFillId?: string | null;
    productId?: string | null;
    productLotId?: string | null;
    productExpirationId?: string | null;
    productVerifiedAt?: Date | null;
    inventoryBalanceId?: string | null;
    inventoryReservedAt?: Date | null;
    inventoryCommittedAt?: Date | null;
    inventoryReturnedAt?: Date | null;
  }>,
) {
  return (
    fills.find((fill) => fill.status === "IN_PROGRESS") ??
    fills.find((fill) => fill.status === "READY") ??
    fills.find((fill) => fill.status === "SCHEDULED")
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
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

      if (
        body.productSelectionDirective &&
        !productSelectionDirectives.has(body.productSelectionDirective)
      ) {
        return reply.code(400).send({
          error: "Invalid product-selection directive.",
        });
      }

      let prescribedProduct = null;
      if (body.prescribedProductId) {
        prescribedProduct = await db.product.findUnique({
          where: { id: body.prescribedProductId },
          include: { manufacturer: true },
        });
        if (
          !prescribedProduct ||
          !prescribedProduct.active ||
          !selectedMedication ||
          prescribedProduct.medicationId !== selectedMedication.id
        ) {
          return reply.code(400).send({
            error:
              "The prescribed product must be an active NDC under the selected Drug.",
          });
        }
      }

      if (
        body.productSelectionDirective === "DISPENSE_AS_WRITTEN" &&
        !prescribedProduct
      ) {
        return reply.code(400).send({
          error:
            "A prescribed product/NDC is required when product selection is prohibited.",
        });
      }

      const prescription = await db.$transaction(async (tx) => {
        const created = await tx.prescription.create({
          data: {
            siteId: actor.siteId,
            patientId: body.patientId!,
            prescriberId: body.prescriberId!,
            medicationId: selectedMedication?.id,
            prescribedProductId: prescribedProduct?.id,
            productSelectionDirective:
              body.productSelectionDirective ?? "UNSPECIFIED",
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
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
          "prescribedProductId",
          "productSelectionDirective",
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

      if (
        body.productSelectionDirective !== undefined &&
        !productSelectionDirectives.has(body.productSelectionDirective)
      ) {
        return reply.code(400).send({
          error: "Invalid product-selection directive.",
        });
      }

      const effectiveMedicationId =
        selectedMedicationForEdit?.id ?? current.medicationId;
      let prescribedProductForEdit:
        | { id: string; medicationId: string; active: boolean }
        | null
        | undefined = undefined;

      if (body.prescribedProductId !== undefined) {
        if (body.prescribedProductId === null) {
          prescribedProductForEdit = null;
        } else {
          prescribedProductForEdit = await db.product.findUnique({
            where: { id: body.prescribedProductId },
            select: { id: true, medicationId: true, active: true },
          });
          if (
            !prescribedProductForEdit ||
            !prescribedProductForEdit.active ||
            !effectiveMedicationId ||
            prescribedProductForEdit.medicationId !== effectiveMedicationId
          ) {
            return reply.code(400).send({
              error:
                "The prescribed product must be an active NDC under the selected Drug.",
            });
          }
        }
      }

      const effectiveDirective =
        body.productSelectionDirective ?? current.productSelectionDirective;
      const effectivePrescribedProductId =
        prescribedProductForEdit === undefined
          ? current.prescribedProductId
          : prescribedProductForEdit?.id ?? null;

      if (
        effectiveDirective === "DISPENSE_AS_WRITTEN" &&
        !effectivePrescribedProductId
      ) {
        return reply.code(400).send({
          error:
            "A prescribed product/NDC is required when product selection is prohibited.",
        });
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
      if (body.prescribedProductId !== undefined) {
        data.prescribedProduct =
          prescribedProductForEdit === null
            ? { disconnect: true }
            : { connect: { id: prescribedProductForEdit!.id } };
      }
      if (body.productSelectionDirective !== undefined) {
        data.productSelectionDirective = body.productSelectionDirective;
      }
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
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
          !currentActiveFill.productVerifiedAt ||
          !currentActiveFill.inventoryBalanceId ||
          !currentActiveFill.inventoryReservedAt)
      ) {
        return reply.code(409).send({
          error:
            "A verified NDC, lot, expiration, and inventory reservation are required before pharmacist review.",
          code: "PRODUCT_SCAN_REQUIRED",
        });
      }

      if (
        current.status === "PRODUCT_FILL" &&
        body.status === "PHARMACIST_REVIEW" &&
        currentActiveFill
      ) {
        await assertFillBillingReadyForReview(
          currentActiveFill.id,
          actor.siteId,
        );
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

      if (
        current.status === "READY" &&
        body.status === "SOLD" &&
        current.medicationId &&
        currentActiveFill &&
        !currentActiveFill.inventoryCommittedAt
      ) {
        return reply.code(409).send({
          error:
            "Catalog-linked fills require committed inventory before sale.",
          code: "INVENTORY_COMMIT_REQUIRED",
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
          if (current.medicationId) {
            await commitInventoryForFill(tx, {
              fillId: currentActiveFill.id,
              siteId: actor.siteId,
              actorId: actor.id,
            });
          }

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
          const soldAt = new Date();
          const physicalQuantity =
            currentActiveFill.quantity ?? new Prisma.Decimal(0);

          await tx.prescriptionFill.update({
            where: { id: currentActiveFill.id },
            data: {
              status: "SOLD",
              soldAt,
              physicalDispensedQuantity: physicalQuantity,
            },
          });

          if (currentActiveFill.billingAnchorFillId) {
            const billingAnchor = await tx.prescriptionFill.findUnique({
              where: { id: currentActiveFill.billingAnchorFillId },
              select: {
                id: true,
                remainingOwedQuantity: true,
              },
            });

            if (billingAnchor) {
              await tx.prescriptionFill.update({
                where: { id: billingAnchor.id },
                data: {
                  remainingOwedQuantity: Prisma.Decimal.max(
                    billingAnchor.remainingOwedQuantity.minus(
                      physicalQuantity,
                    ),
                    new Prisma.Decimal(0),
                  ),
                },
              });
            }
          }

          if (currentActiveFill.consumesRefill) {
            prescriptionData.refillsUsed = Math.max(
              current.refillsUsed,
              currentActiveFill.fillNumber,
            );
          }
        }

        if (
          (body.status === "CANCELLED" || body.status === "TRANSFERRED") &&
          currentActiveFill
        ) {
          if (
            currentActiveFill.inventoryCommittedAt &&
            !currentActiveFill.inventoryReturnedAt
          ) {
            await returnInventoryForFill(tx, {
              fillId: currentActiveFill.id,
              siteId: actor.siteId,
              actorId: actor.id,
              reason: `Prescription ${body.status.toLowerCase()} after inventory commitment`,
            });
          } else if (
            currentActiveFill.inventoryReservedAt &&
            !currentActiveFill.inventoryCommittedAt
          ) {
            await releaseInventoryReservation(tx, {
              fillId: currentActiveFill.id,
              siteId: actor.siteId,
              actorId: actor.id,
              reason: `Prescription ${body.status.toLowerCase()} before pharmacist verification`,
            });
          }

          await tx.prescriptionFill.update({
            where: { id: currentActiveFill.id },
            data: { status: "CANCELLED" },
          });

          await cancelDemandForFill(tx, currentActiveFill.id);

          const linkedCompletions = await tx.prescriptionFill.findMany({
            where: {
              completionOfFillId: currentActiveFill.id,
              status: "SCHEDULED",
            },
            select: { id: true },
          });

          await tx.prescriptionFill.updateMany({
            where: {
              completionOfFillId: currentActiveFill.id,
              status: "SCHEDULED",
            },
            data: { status: "CANCELLED" },
          });

          for (const completion of linkedCompletions) {
            await cancelDemandForFill(tx, completion.id);
          }
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
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
      if (
        body.daysSupply !== undefined &&
        (!Number.isInteger(body.daysSupply) || body.daysSupply <= 0)
      ) {
        return reply.code(400).send({
          error: "daysSupply must be a positive whole number when provided.",
        });
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
      const latestRefillConsumingFill = prescription.fills.find(
        (fill) => fill.consumesRefill,
      );
      const returnedRefillConsumingFill = prescription.fills.find(
        (fill) =>
          fill.consumesRefill && fill.status === "RETURNED_TO_STOCK",
      );

      if (returnedRefillConsumingFill) {
        const latestFill = returnedRefillConsumingFill;
        const result = await db.$transaction(async (tx) => {
          const reprocessed = await tx.prescriptionFill.update({
            where: { id: latestFill.id },
            data: {
              scheduledFor: scheduledFor instanceof Date ? scheduledFor : null,
              daysSupply: body.daysSupply ?? latestFill.daysSupply ?? null,
              quantity: body.quantity ?? prescription.quantityWritten ?? undefined,
              authorizedQuantity:
                body.quantity ?? prescription.quantityWritten ?? undefined,
              intendedQuantity:
                body.quantity ?? prescription.quantityWritten ?? undefined,
              payerIntendedQuantity:
                body.quantity ?? prescription.quantityWritten ?? undefined,
              physicalDispensedQuantity: 0,
              remainingOwedQuantity: 0,
              billingRole: "PRIMARY_CLAIM",
              billingAnchorFillId: null,
              kind: "STANDARD",
              interruptionReason: null,
              interruptionNote: null,
              interruptedAt: null,
              interruptedById: null,
              status: isFuture ? "SCHEDULED" : "IN_PROGRESS",
              productId: null,
              productLotId: null,
              productExpirationId: null,
              scannedNdc: null,
              scannedLotNumber: null,
              scannedExpiration: null,
              productVerifiedAt: null,
              inventoryBalanceId: null,
              inventoryReservedAt: null,
              inventoryCommittedAt: null,
              inventoryReturnedAt: null,
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

      const nextFillNumber =
        (latestRefillConsumingFill?.fillNumber ?? -1) + 1;
      const totalFillsAllowed = prescription.refillsAllowed + 1;

      if (nextFillNumber >= totalFillsAllowed) {
        return reply.code(409).send({ error: "No fills remain on this prescription." });
      }

      const result = await db.$transaction(async (tx) => {
        const created = await tx.prescriptionFill.create({
          data: {
            prescriptionId: prescription.id,
            fillNumber: nextFillNumber,
            partNumber: 1,
            kind: "STANDARD",
            consumesRefill: true,
            scheduledFor: scheduledFor instanceof Date ? scheduledFor : undefined,
            daysSupply: body.daysSupply,
            quantity: body.quantity ?? prescription.quantityWritten ?? undefined,
            authorizedQuantity:
              body.quantity ?? prescription.quantityWritten ?? undefined,
            intendedQuantity:
              body.quantity ?? prescription.quantityWritten ?? undefined,
            payerIntendedQuantity:
              body.quantity ?? prescription.quantityWritten ?? undefined,
            physicalDispensedQuantity: 0,
            remainingOwedQuantity: 0,
            billingRole: "PRIMARY_CLAIM",
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
      }
      throw error;
    }
  });

  app.post("/fills/:id/partial", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(
        request,
        "prescription:process",
      );
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as CreatePartialFillBody;
      const dispenseQuantity = body.dispenseQuantity;
      const completionScheduledFor = parseDate(body.completionScheduledFor);

      if (
        typeof dispenseQuantity !== "number" ||
        !Number.isFinite(dispenseQuantity) ||
        dispenseQuantity <= 0 ||
        !(completionScheduledFor instanceof Date) ||
        completionScheduledFor.getTime() <= Date.now()
      ) {
        return reply.code(400).send({
          error:
            "A positive partial quantity and a future completion date are required.",
        });
      }

      if (
        body.interruptionReason &&
        !fillInterruptionReasons.has(body.interruptionReason)
      ) {
        return reply.code(400).send({
          error: "A valid fill interruption reason is required.",
        });
      }

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

      if (
        fill.status !== "IN_PROGRESS" ||
        fill.prescription.status !== "PRODUCT_FILL"
      ) {
        return reply.code(409).send({
          error:
            "A partial fill can only be entered during an in-progress Product Fill.",
        });
      }

      if (fill.inventoryCommittedAt) {
        return reply.code(409).send({
          error:
            "A fill cannot be converted to a partial after pharmacist verification has committed inventory.",
          code: "PARTIAL_AFTER_INVENTORY_COMMIT_NOT_ALLOWED",
        });
      }

      const interruptedAfterScan = Boolean(
        fill.productVerifiedAt || fill.inventoryReservedAt,
      );

      if (interruptedAfterScan && !body.interruptionReason) {
        return reply.code(400).send({
          error:
            "A structured interruption reason is required when converting a fill after product scanning/reservation.",
          code: "FILL_INTERRUPTION_REASON_REQUIRED",
        });
      }

      if (fill.kind === "EMERGENCY_SUPPLY") {
        return reply.code(409).send({
          error: "An emergency supply cannot be converted into a partial fill.",
        });
      }

      if (fill.kind === "PARTIAL") {
        return reply.code(409).send({
          error:
            "This dispense part is already a partial. Resolve its scheduled completion before changing it again.",
          code: "FILL_ALREADY_PARTIAL",
        });
      }

      if (fill.quantity === null) {
        return reply.code(409).send({
          error: "The current dispense part has no planned physical quantity.",
        });
      }

      const plannedPartQuantity = fill.quantity;
      const intendedQuantity =
        fill.intendedQuantity ??
        fill.authorizedQuantity ??
        plannedPartQuantity;
      const payerIntendedQuantity =
        fill.payerIntendedQuantity ?? intendedQuantity;
      const partial = new Prisma.Decimal(dispenseQuantity);

      if (partial.gte(plannedPartQuantity)) {
        return reply.code(400).send({
          error:
            "Partial quantity must be less than the current planned physical dispense quantity.",
        });
      }

      const remainder = plannedPartQuantity.minus(partial);
      const billingAnchorFillId = fill.billingAnchorFillId ?? fill.id;
      const wasReserved = Boolean(
        fill.inventoryBalanceId && fill.inventoryReservedAt,
      );

      const result = await db.$transaction(async (tx) => {
        const existingParts = await tx.prescriptionFill.findMany({
          where: {
            prescriptionId: fill.prescriptionId,
            fillNumber: fill.fillNumber,
            claimReversalTransactionIds: claimReversals.map(
              (item) => item.transaction.id,
            ),
          },
          select: { partNumber: true },
          orderBy: { partNumber: "desc" },
        });

        const nextPartNumber =
          (existingParts[0]?.partNumber ?? fill.partNumber) + 1;

        const balanceBefore = fill.inventoryBalanceId
          ? await tx.inventoryBalance.findUnique({
              where: { id: fill.inventoryBalanceId },
            })
          : null;

        const interruptionReason =
          body.interruptionReason ??
          (interruptedAfterScan
            ? ("INSUFFICIENT_PHYSICAL_STOCK" as FillInterruptionReason)
            : null);
        const interruptedAt = interruptionReason ? new Date() : null;

        const partialFill = await tx.prescriptionFill.update({
          where: { id: fill.id },
          data: {
            kind: "PARTIAL",
            quantity: partial,
            authorizedQuantity: intendedQuantity,
            intendedQuantity,
            payerIntendedQuantity,
            physicalDispensedQuantity: 0,
            remainingOwedQuantity:
              fill.billingAnchorFillId === null
                ? intendedQuantity.minus(partial)
                : fill.remainingOwedQuantity,
            billingRole:
              fill.billingAnchorFillId === null
                ? "PRIMARY_CLAIM"
                : "COMPLETION_OF_PRIMARY",
            interruptionReason,
            interruptionNote: body.reason?.trim() || null,
            interruptedAt,
            interruptedById: interruptionReason ? actor.id : null,
          },
        });

        const completion = await tx.prescriptionFill.create({
          data: {
            prescriptionId: fill.prescriptionId,
            fillNumber: fill.fillNumber,
            partNumber: nextPartNumber,
            kind: "COMPLETION",
            billingRole: "COMPLETION_OF_PRIMARY",
            billingAnchorFillId,
            consumesRefill: false,
            completionOfFillId: fill.id,
            scheduledFor: completionScheduledFor,
            daysSupply: fill.daysSupply,
            quantity: remainder,
            authorizedQuantity: intendedQuantity,
            intendedQuantity,
            payerIntendedQuantity,
            physicalDispensedQuantity: 0,
            remainingOwedQuantity: 0,
            status: "SCHEDULED",
          },
        });

        if (wasReserved) {
          await resizeInventoryReservationForFill(tx, {
            fillId: fill.id,
            siteId: actor.siteId,
            actorId: actor.id,
            targetQuantity: partial,
            reason:
              "Fill interrupted and multi-source reservation resized for physical partial dispense",
          });
        }

        await createOrUpdateFillDemand(tx, {
          fillId: completion.id,
          source: "COMPLETION",
          note:
            body.reason?.trim() ||
            "Remaining quantity required to complete a partial fill.",
        });

        let inventoryException = null;
        if (
          balanceBefore &&
          interruptionReason &&
          ["INSUFFICIENT_PHYSICAL_STOCK", "STOCK_DISCREPANCY"].includes(
            interruptionReason,
          )
        ) {
          const systemAvailableBefore = balanceBefore.onHandQuantity
            .minus(balanceBefore.reservedQuantity)
            .minus(balanceBefore.quarantinedQuantity)
            .plus(wasReserved ? plannedPartQuantity : 0);

          inventoryException = await tx.inventoryException.upsert({
            where: {
              siteId_fingerprint: {
                siteId: actor.siteId,
                fingerprint: `physical-stock-shortage:${fill.id}`,
              },
            },
            update: {
              type: "PHYSICAL_STOCK_SHORTAGE",
              status: "OPEN",
              severity: "HIGH",
              entityType: "PrescriptionFill",
              entityId: fill.id,
              title: "Physical stock shortage reported during Product Fill",
              detail:
                `Technician reported only ${partial.toString()} units dispensable while the dispense part expected ${plannedPartQuantity.toString()} units. ` +
                `System balance before reservation resize: on hand ${balanceBefore.onHandQuantity.toString()}, reserved ${balanceBefore.reservedQuantity.toString()}, quarantined ${balanceBefore.quarantinedQuantity.toString()}. Reconcile physical stock before relying on this balance.`,
              lastDetectedAt: new Date(),
              acknowledgedById: null,
              acknowledgedAt: null,
              resolvedAt: null,
              resolvedById: null,
              resolutionNote: null,
            },
            create: {
              siteId: actor.siteId,
              fingerprint: `physical-stock-shortage:${fill.id}`,
              type: "PHYSICAL_STOCK_SHORTAGE",
              status: "OPEN",
              severity: "HIGH",
              entityType: "PrescriptionFill",
              entityId: fill.id,
              title: "Physical stock shortage reported during Product Fill",
              detail:
                `Technician reported only ${partial.toString()} units dispensable while the dispense part expected ${plannedPartQuantity.toString()} units. ` +
                `System-available quantity before resize was approximately ${systemAvailableBefore.toString()}. Reconcile physical stock before relying on this balance.`,
            },
          });
        }

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: interruptedAfterScan
            ? "PRESCRIPTION_FILL_INTERRUPTED_TO_PARTIAL"
            : "PRESCRIPTION_PARTIAL_FILL_CREATED",
          entityType: "PrescriptionFill",
          entityId: fill.id,
          requestId: request.id,
          metadata: {
            prescriptionId: fill.prescriptionId,
            fillNumber: fill.fillNumber,
            partNumber: fill.partNumber,
            priorPlannedPhysicalQuantity: plannedPartQuantity.toString(),
            physicalQuantityThisPart: partial.toString(),
            logicalIntendedQuantity: intendedQuantity.toString(),
            payerIntendedQuantity: payerIntendedQuantity.toString(),
            completionQuantity: remainder.toString(),
            completionFillId: completion.id,
            completionScheduledFor:
              completionScheduledFor.toISOString(),
            billingAnchorFillId,
            billingRole: partialFill.billingRole,
            reservationResized: wasReserved,
            interruptionReason,
            inventoryExceptionId: inventoryException?.id ?? null,
            reason: body.reason?.trim() || null,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIPTION_COMPLETION_FILL_SCHEDULED",
          entityType: "PrescriptionFill",
          entityId: completion.id,
          requestId: request.id,
          metadata: {
            prescriptionId: fill.prescriptionId,
            fillNumber: fill.fillNumber,
            partNumber: completion.partNumber,
            completionOfFillId: fill.id,
            billingAnchorFillId,
            physicalCompletionQuantity: remainder.toString(),
            logicalIntendedQuantity: intendedQuantity.toString(),
            payerIntendedQuantity: payerIntendedQuantity.toString(),
            scheduledFor: completionScheduledFor.toISOString(),
          },
        });

        const finalizedPartialFill =
          await tx.prescriptionFill.findUniqueOrThrow({
            where: { id: fill.id },
          });

        return {
          partialFill: finalizedPartialFill,
          completion,
          inventoryException,
        };
      });

      const prescription = await db.prescription.findUniqueOrThrow({
        where: { id: fill.prescriptionId },
        include: prescriptionInclude,
      });

      const adjudication = result.partialFill.productVerifiedAt
        ? await tryAutoAdjudication(result.partialFill.id, actor, request.id)
        : null;

      return {
        partialFill: result.partialFill,
        completionFill: result.completion,
        inventoryException: result.inventoryException,
        adjudication,
        prescription: presentPrescription(prescription),
      };
    } catch (error) {
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
      }
      throw error;
    }
  });

  app.post("/prescriptions/:id/emergency-supply", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(
        request,
        "prescription:emergency",
      );
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as CreateEmergencySupplyBody;
      const followUpDueAt = parseDate(body.followUpDueAt);
      const reason = body.reason?.trim();

      if (
        typeof body.quantity !== "number" ||
        !Number.isFinite(body.quantity) ||
        body.quantity <= 0 ||
        !reason ||
        !(followUpDueAt instanceof Date) ||
        followUpDueAt.getTime() <= Date.now()
      ) {
        return reply.code(400).send({
          error:
            "A positive emergency quantity, documented pharmacist reason, and future follow-up deadline are required.",
        });
      }

      const prescription = await db.prescription.findFirst({
        where: { id, siteId: actor.siteId },
        include: prescriptionInclude,
      });

      if (!prescription) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      if (prescription.status !== "SOLD") {
        return reply.code(409).send({
          error:
            "Emergency supply may only be initiated from a previously dispensed prescription.",
        });
      }

      if (prescription.refillsUsed < prescription.refillsAllowed) {
        return reply.code(409).send({
          error:
            "Authorized refills remain; use the normal refill workflow instead.",
          code: "AUTHORIZED_REFILLS_REMAIN",
        });
      }

      if (!prescription.medicationId) {
        return reply.code(409).send({
          error:
            "Emergency supply requires a catalog-linked medication selection.",
          code: "DRUG_SELECTION_REQUIRED",
        });
      }

      if (activeFill(prescription.fills)) {
        return reply.code(409).send({
          error: "Resolve the existing active fill before creating emergency supply.",
        });
      }

      const latestAccountingFill = prescription.fills.find(
        (fill) => fill.consumesRefill,
      );
      if (!latestAccountingFill) {
        return reply.code(409).send({
          error:
            "Emergency supply requires a prior completed prescription fill.",
        });
      }

      const result = await db.$transaction(async (tx) => {
        const parts = await tx.prescriptionFill.findMany({
          where: {
            prescriptionId: prescription.id,
            fillNumber: latestAccountingFill.fillNumber,
          },
          select: { partNumber: true },
          orderBy: { partNumber: "desc" },
        });
        const partNumber = (parts[0]?.partNumber ?? 0) + 1;

        const emergencyFill = await tx.prescriptionFill.create({
          data: {
            prescriptionId: prescription.id,
            fillNumber: latestAccountingFill.fillNumber,
            partNumber,
            kind: "EMERGENCY_SUPPLY",
            billingRole: "EMERGENCY_SUPPLY",
            consumesRefill: false,
            quantity: body.quantity,
            authorizedQuantity: body.quantity,
            intendedQuantity: body.quantity,
            payerIntendedQuantity: body.quantity,
            physicalDispensedQuantity: 0,
            remainingOwedQuantity: 0,
            status: "IN_PROGRESS",
            emergencyReason: reason,
            emergencyAuthorizedById: actor.id,
            emergencyAuthorizedAt: new Date(),
            followUpDueAt,
          },
        });

        const rx = await tx.prescription.update({
          where: { id: prescription.id },
          data: { status: "PRODUCT_FILL" },
          include: prescriptionInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIPTION_EMERGENCY_SUPPLY_AUTHORIZED",
          entityType: "PrescriptionFill",
          entityId: emergencyFill.id,
          requestId: request.id,
          metadata: {
            prescriptionId: prescription.id,
            fillNumber: emergencyFill.fillNumber,
            partNumber: emergencyFill.partNumber,
            quantity: String(body.quantity),
            reason,
            followUpDueAt: followUpDueAt.toISOString(),
            priorRefillsAllowed: prescription.refillsAllowed,
            priorRefillsUsed: prescription.refillsUsed,
          },
        });

        return { fill: emergencyFill, prescription: rx };
      });

      return reply.code(201).send({
        fill: result.fill,
        prescription: presentPrescription(result.prescription),
      });
    } catch (error) {
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
      }
      throw error;
    }
  });

  app.post(
    "/fills/:id/emergency-follow-up/complete",
    async (request, reply) => {
      try {
        const actor = await resolveDevelopmentActor(
          request,
          "prescription:emergency",
        );
        const id = (request.params as { id: string }).id;
        const body = (request.body ?? {}) as CompleteEmergencyFollowUpBody;
        const note = body.note?.trim();

        if (!note) {
          return reply.code(400).send({
            error: "A follow-up note is required.",
          });
        }

        const fill = await db.prescriptionFill.findUnique({
          where: { id },
          include: { prescription: true },
        });

        if (!fill || fill.prescription.siteId !== actor.siteId) {
          return reply.code(404).send({ error: "Emergency fill not found." });
        }

        if (fill.kind !== "EMERGENCY_SUPPLY") {
          return reply.code(409).send({
            error: "This fill is not an emergency supply.",
          });
        }

        if (fill.followUpCompletedAt) {
          return reply.code(409).send({
            error: "Emergency-supply follow-up is already complete.",
          });
        }

        const completedAt = new Date();
        const updated = await db.$transaction(async (tx) => {
          const completed = await tx.prescriptionFill.update({
            where: { id: fill.id },
            data: {
              followUpCompletedAt: completedAt,
              followUpNote: note,
            },
          });

          await writeAuditEvent(tx, {
            siteId: actor.siteId,
            actorId: actor.id,
            action: "PRESCRIPTION_EMERGENCY_SUPPLY_FOLLOW_UP_COMPLETED",
            entityType: "PrescriptionFill",
            entityId: fill.id,
            requestId: request.id,
            metadata: {
              prescriptionId: fill.prescriptionId,
              completedAt: completedAt.toISOString(),
              note,
            },
          });

          return completed;
        });

        return { fill: updated };
      } catch (error) {
        if (error instanceof AccessError || error instanceof InventoryError) {
          return reply.code(error.statusCode).send({
            error: error.message,
            ...(error instanceof InventoryError
              ? { code: error.code, details: error.details }
              : {}),
          });
        }
        throw error;
      }
    },
  );

  app.post("/fills/:id/scan-barcode", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:process");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as ScanBarcodeBody;
      const parsed = parseBarcode(body.rawBarcode ?? "");

      if (!parsed) {
        return reply.code(400).send({ error: "A barcode scan is required." });
      }

      if (!parsed.lotNumber || !parsed.expirationDate) {
        return reply.code(409).send({
          error:
            "The scanned barcode does not contain both lot and expiration information. Use a traceability barcode or the manual development fallback.",
          code: "BARCODE_TRACEABILITY_REQUIRED",
          parsed,
        });
      }

      const registered = await db.productBarcode.findUnique({
        where: {
          type_identifierSearch: {
            type: parsed.type,
            identifierSearch: parsed.identifierSearch,
          },
        },
        include: {
          product: {
            include: {
              manufacturer: true,
              medication: true,
            },
          },
        },
      });

      if (!registered || !registered.product.active) {
        return reply.code(409).send({
          error:
            "This barcode identifier is not assigned to an active product in the Drug/Product catalog.",
          code: "BARCODE_UNKNOWN",
          parsed,
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
          error: "Barcode verification is only allowed during an in-progress Product Fill.",
        });
      }

      if (!fill.prescription.medicationId || !fill.prescription.medication) {
        return reply.code(409).send({
          error:
            "This legacy prescription has no catalog drug selection. Select a drug before product verification.",
          code: "DRUG_SELECTION_REQUIRED",
        });
      }

      const product = registered.product;

      if (product.medicationId !== fill.prescription.medicationId) {
        return reply.code(409).send({
          error:
            "The scanned barcode resolves to a product under a different drug than the drug selected during Data Entry.",
          code: "BARCODE_DRUG_MISMATCH",
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
          parsed,
        });
      }

      const lotNumberSearch = parsed.lotNumber
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase();

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
            expirationDate: parsed.expirationDate,
            active: true,
          },
        }),
      ]);

      if (!lot) {
        return reply.code(409).send({
          error:
            "The barcode lot has not been received/cataloged under this NDC at this pharmacy site.",
          code: "BARCODE_LOT_NOT_RECEIVED",
          parsed,
        });
      }

      if (!expiration) {
        return reply.code(409).send({
          error:
            "The barcode expiration has not been received/cataloged under this NDC at this pharmacy site.",
          code: "BARCODE_EXPIRATION_NOT_RECEIVED",
          parsed,
        });
      }

      const expirationEnd = new Date(expiration.expirationDate);
      expirationEnd.setUTCHours(23, 59, 59, 999);
      if (expirationEnd.getTime() < Date.now()) {
        return reply.code(409).send({
          error: "The scanned product is expired.",
          code: "PRODUCT_EXPIRED",
          parsed,
        });
      }

      const verified = await db.$transaction(async (tx) => {
        await validateFillProductSourceCompliance(tx, {
          fillId: id,
          productId: product.id,
        });

        const before = await getFillSourceReservationSummary(tx, id);
        const requestedSourceQuantity =
          body.sourceQuantity === undefined
            ? before.remainingQuantity
            : new Prisma.Decimal(body.sourceQuantity);

        if (
          requestedSourceQuantity.lte(0) ||
          requestedSourceQuantity.gt(before.remainingQuantity)
        ) {
          throw new InventoryError(
            400,
            "INVALID_FILL_SOURCE_QUANTITY",
            "Source quantity must be positive and cannot exceed the remaining physical dispense quantity.",
            {
              remainingQuantity: before.remainingQuantity.toString(),
              requestedQuantity: requestedSourceQuantity.toString(),
            },
          );
        }

        const reservation = await reserveInventorySourceForFill(tx, {
          fillId: id,
          siteId: actor.siteId,
          actorId: actor.id,
          productId: product.id,
          productLotId: lot.id,
          productExpirationId: expiration.id,
          quantity: requestedSourceQuantity,
        });

        const updated = await tx.prescriptionFill.findUniqueOrThrow({
          where: { id },
          include: {
            product: { include: { manufacturer: true } },
            productLot: true,
            productExpiration: true,
            inventoryBalance: true,
            productSources: {
              include: {
                product: { include: { manufacturer: true, medication: true } },
                manufacturer: true,
                productLot: true,
                productExpiration: true,
                inventoryBalance: true,
              },
              orderBy: { sequence: "asc" },
            },
            biologicCommunicationTask: true,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: reservation.complete
            ? "FILL_PRODUCT_SOURCES_COMPLETE"
            : "FILL_PRODUCT_SOURCE_ADDED",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            prescriptionId: fill.prescriptionId,
            medicationId: fill.prescription.medicationId,
            sourceId: reservation.source.id,
            sourceSequence: reservation.source.sequence,
            productId: product.id,
            productBarcodeId: registered.id,
            barcodeType: registered.type,
            identifier: registered.identifier,
            ndc: product.ndc,
            lotNumber: lot.lotNumber,
            expirationDate: expiration.expirationDate.toISOString(),
            manufacturerName: product.manufacturer.name,
            inventoryBalanceId: reservation.balance.id,
            sourceQuantity: reservation.sourceQuantity.toString(),
            totalReservedQuantity: reservation.totalReserved.toString(),
            remainingQuantity: reservation.remainingQuantity.toString(),
            sourceCount: updated.productSources.length,
            complete: reservation.complete,
          },
        });

        return updated;
      });

      const adjudication = verified.productVerifiedAt
        ? await tryAutoAdjudication(id, actor, request.id)
        : null;

      return {
        fill: verified,
        adjudication,
        parsed,
        barcode: registered,
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
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
        await validateFillProductSourceCompliance(tx, {
          fillId: id,
          productId: product.id,
        });

        const before = await getFillSourceReservationSummary(tx, id);
        const requestedSourceQuantity =
          body.sourceQuantity === undefined
            ? before.remainingQuantity
            : new Prisma.Decimal(body.sourceQuantity);

        if (
          requestedSourceQuantity.lte(0) ||
          requestedSourceQuantity.gt(before.remainingQuantity)
        ) {
          throw new InventoryError(
            400,
            "INVALID_FILL_SOURCE_QUANTITY",
            "Source quantity must be positive and cannot exceed the remaining physical dispense quantity.",
            {
              remainingQuantity: before.remainingQuantity.toString(),
              requestedQuantity: requestedSourceQuantity.toString(),
            },
          );
        }

        const reservation = await reserveInventorySourceForFill(tx, {
          fillId: id,
          siteId: actor.siteId,
          actorId: actor.id,
          productId: product.id,
          productLotId: lot.id,
          productExpirationId: expiration.id,
          quantity: requestedSourceQuantity,
        });

        const verified = await tx.prescriptionFill.findUniqueOrThrow({
          where: { id },
          include: {
            product: { include: { manufacturer: true } },
            productLot: true,
            productExpiration: true,
            inventoryBalance: true,
            productSources: {
              include: {
                product: { include: { manufacturer: true, medication: true } },
                manufacturer: true,
                productLot: true,
                productExpiration: true,
                inventoryBalance: true,
              },
              orderBy: { sequence: "asc" },
            },
            biologicCommunicationTask: true,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: reservation.complete
            ? "FILL_PRODUCT_SOURCES_COMPLETE"
            : "FILL_PRODUCT_SOURCE_ADDED",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            prescriptionId: fill.prescriptionId,
            medicationId: fill.prescription.medicationId,
            sourceId: reservation.source.id,
            sourceSequence: reservation.source.sequence,
            productId: product.id,
            ndc: product.ndc,
            lotNumber: lot.lotNumber,
            expirationDate: expiration.expirationDate.toISOString(),
            manufacturerName: product.manufacturer.name,
            inventoryBalanceId: reservation.balance.id,
            sourceQuantity: reservation.sourceQuantity.toString(),
            totalReservedQuantity: reservation.totalReserved.toString(),
            remainingQuantity: reservation.remainingQuantity.toString(),
            sourceCount: verified.productSources.length,
            complete: reservation.complete,
          },
        });

        return verified;
      });

      const adjudication = result.productVerifiedAt
        ? await tryAutoAdjudication(id, actor, request.id)
        : null;

      return {
        fill: result,
        adjudication,
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
      }
      throw error;
    }
  });

  app.put("/fills/:id/billing-product", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:write");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as { productId?: string | null };

      const fill = await db.prescriptionFill.findFirst({
        where: { id, prescription: { siteId: actor.siteId } },
        include: {
          productSources: true,
          prescription: true,
        },
      });
      if (!fill) {
        return reply.code(404).send({ error: "Fill not found." });
      }
      if (fill.inventoryCommittedAt) {
        return reply.code(409).send({
          error: "Billing product cannot be changed after pharmacist inventory commitment.",
        });
      }
      if ((body.productId ?? null) !== fill.billingProductId) {
        await assertNoActivePaidClaimForMutation(id, actor.siteId);
      }

      if (body.productId) {
        const source = fill.productSources.find(
          (item) => item.productId === body.productId,
        );
        if (!source) {
          return reply.code(409).send({
            error:
              "The billing product must be one of the physical NDC products used for this dispense part.",
          });
        }
      }

      const updated = await db.$transaction(async (tx) => {
        const result = await tx.prescriptionFill.update({
          where: { id },
          data: { billingProductId: body.productId ?? null },
          include: {
            productSources: {
              include: {
                product: { include: { manufacturer: true, medication: true } },
                manufacturer: true,
                productLot: true,
                productExpiration: true,
                inventoryBalance: true,
              },
              orderBy: { sequence: "asc" },
            },
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "FILL_BILLING_PRODUCT_SELECTED",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            billingProductId: body.productId ?? null,
            physicalProductIds: fill.productSources.map(
              (source) => source.productId,
            ),
          },
        });
        return result;
      });

      const adjudication = updated.productVerifiedAt
        ? await tryAutoAdjudication(id, actor, request.id)
        : null;

      return { fill: updated, adjudication };
    } catch (error) {
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
      }
      throw error;
    }
  });

  app.put("/fills/:id/billing-details", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "thirdparty:write");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as {
        daysSupply?: number;
        billingProductId?: string | null;
      };

      if (
        body.daysSupply !== undefined &&
        (!Number.isInteger(body.daysSupply) || body.daysSupply <= 0)
      ) {
        return reply.code(400).send({
          error: "daysSupply must be a positive whole number.",
        });
      }

      const fill = await db.prescriptionFill.findFirst({
        where: { id, prescription: { siteId: actor.siteId } },
        include: {
          productSources: true,
          prescription: true,
        },
      });
      if (!fill) {
        return reply.code(404).send({ error: "Fill not found." });
      }
      if (fill.inventoryCommittedAt) {
        return reply.code(409).send({
          error: "Billing details cannot be changed after pharmacist inventory commitment.",
        });
      }
      if (body.daysSupply === undefined && body.billingProductId === undefined) {
        return reply.code(400).send({
          error: "Provide daysSupply and/or billingProductId.",
        });
      }

      const claimSensitiveChange =
        (body.daysSupply !== undefined && body.daysSupply !== fill.daysSupply) ||
        (body.billingProductId !== undefined &&
          body.billingProductId !== fill.billingProductId);
      if (claimSensitiveChange) {
        await assertNoActivePaidClaimForMutation(id, actor.siteId);
      }

      if (body.billingProductId) {
        const source = fill.productSources.find(
          (item) => item.productId === body.billingProductId,
        );
        if (!source) {
          return reply.code(409).send({
            error:
              "The billing product must be one of the physical NDC products used for this dispense part.",
            code: "BILLING_PRODUCT_NOT_IN_FILL",
          });
        }
      }

      const updated = await db.$transaction(async (tx) => {
        const result = await tx.prescriptionFill.update({
          where: { id },
          data: {
            daysSupply: body.daysSupply,
            billingProductId:
              body.billingProductId === undefined
                ? undefined
                : body.billingProductId,
          },
          include: {
            productSources: {
              include: {
                product: { include: { manufacturer: true, medication: true } },
                manufacturer: true,
                productLot: true,
                productExpiration: true,
                inventoryBalance: true,
              },
              orderBy: { sequence: "asc" },
            },
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "FILL_BILLING_DETAILS_UPDATED",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            daysSupply: result.daysSupply,
            billingProductId: result.billingProductId,
          },
        });
        return result;
      });

      const adjudication = updated.productVerifiedAt
        ? await tryAutoAdjudication(id, actor, request.id)
        : null;

      return { fill: updated, adjudication };
    } catch (error) {
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
      }
      throw error;
    }
  });

  app.put("/fills/:id/packaging", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(
        request,
        "prescription:process",
      );
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as {
        dispensedInOriginalContainer?: boolean;
      };
      if (typeof body.dispensedInOriginalContainer !== "boolean") {
        return reply.code(400).send({
          error: "dispensedInOriginalContainer must be true or false.",
        });
      }

      const fill = await db.prescriptionFill.findFirst({
        where: { id, prescription: { siteId: actor.siteId } },
      });
      if (!fill) {
        return reply.code(404).send({ error: "Fill not found." });
      }
      if (fill.inventoryCommittedAt) {
        return reply.code(409).send({
          error: "Packaging status cannot be changed after pharmacist verification.",
        });
      }

      const updated = await db.$transaction(async (tx) => {
        const result = await tx.prescriptionFill.update({
          where: { id },
          data: {
            dispensedInOriginalContainer: body.dispensedInOriginalContainer,
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "FILL_PACKAGING_STATUS_UPDATED",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            dispensedInOriginalContainer:
              body.dispensedInOriginalContainer,
          },
        });
        return result;
      });

      return { fill: updated };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.delete("/fills/:id/product-sources/:sourceId", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(
        request,
        "prescription:process",
      );
      const params = request.params as { id: string; sourceId: string };
      const fill = await db.prescriptionFill.findFirst({
        where: {
          id: params.id,
          prescription: { siteId: actor.siteId },
        },
        include: { prescription: true },
      });
      if (!fill) {
        return reply.code(404).send({ error: "Fill not found." });
      }
      if (
        fill.status !== "IN_PROGRESS" ||
        fill.prescription.status !== "PRODUCT_FILL"
      ) {
        return reply.code(409).send({
          error:
            "Product sources may only be removed during an in-progress Product Fill.",
        });
      }
      const reversedClaims = await reverseActivePaidClaimsForFill(
        params.id,
        {
          siteId: actor.siteId,
          actorId: actor.id,
          requestId: request.id,
        },
        { requireMajoritySource: true },
      );

      const summary = await db.$transaction(async (tx) => {
        const updated = await removeInventorySourceForFill(tx, {
          fillId: params.id,
          sourceId: params.sourceId,
          siteId: actor.siteId,
          actorId: actor.id,
          reason: "Product Fill source removed before pharmacist verification",
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "FILL_PRODUCT_SOURCE_REMOVED",
          entityType: "PrescriptionFill",
          entityId: params.id,
          requestId: request.id,
          metadata: {
            sourceId: params.sourceId,
            reservedQuantity: updated.reservedQuantity.toString(),
            remainingQuantity: updated.remainingQuantity.toString(),
            sourceCount: updated.sources.length,
            reversedClaimTransactionIds: reversedClaims.map(
              (item) => item.transaction.id,
            ),
          },
        });
        return updated;
      });

      const updatedFill = await db.prescriptionFill.findUniqueOrThrow({
        where: { id: params.id },
        include: {
          product: { include: { manufacturer: true } },
          productLot: true,
          productExpiration: true,
          inventoryBalance: true,
          productSources: {
            include: {
              product: { include: { manufacturer: true, medication: true } },
              manufacturer: true,
              productLot: true,
              productExpiration: true,
              inventoryBalance: true,
            },
            orderBy: { sequence: "asc" },
          },
          biologicCommunicationTask: true,
        },
      });

      return {
        fill: updatedFill,
        sourceSummary: {
          requiredQuantity: summary.requiredQuantity.toString(),
          reservedQuantity: summary.reservedQuantity.toString(),
          remainingQuantity: summary.remainingQuantity.toString(),
          complete: summary.complete,
        },
      };
    } catch (error) {
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
      }
      throw error;
    }
  });

  app.post("/fills/:id/nti-manufacturer-consent", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "product:compliance");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as {
        priorManufacturerId?: string;
        newManufacturerId?: string;
        prescriberConsentAt?: string;
        patientConsentAt?: string;
        note?: string;
      };
      const prescriberConsentAt = parseDate(body.prescriberConsentAt);
      const patientConsentAt = parseDate(body.patientConsentAt);
      const note = body.note?.trim();

      if (
        !body.priorManufacturerId ||
        !body.newManufacturerId ||
        body.priorManufacturerId === body.newManufacturerId ||
        !(prescriberConsentAt instanceof Date) ||
        !(patientConsentAt instanceof Date) ||
        !note
      ) {
        return reply.code(400).send({
          error:
            "Prior/new manufacturers, prescriber consent time, patient consent time, and a documentation note are required.",
        });
      }

      const fill = await db.prescriptionFill.findFirst({
        where: {
          id,
          prescription: { siteId: actor.siteId },
        },
        include: {
          prescription: { include: { medication: true } },
        },
      });
      if (!fill) {
        return reply.code(404).send({ error: "Fill not found." });
      }
      if (!fill.prescription.medication?.ncNarrowTherapeuticIndex) {
        return reply.code(409).send({
          error: "This medication is not configured as a North Carolina NTI drug.",
        });
      }

      const consent = await db.$transaction(async (tx) => {
        const record = await tx.ntiManufacturerConsent.upsert({
          where: {
            fillId_priorManufacturerId_newManufacturerId: {
              fillId: id,
              priorManufacturerId: body.priorManufacturerId!,
              newManufacturerId: body.newManufacturerId!,
            },
          },
          update: {
            prescriberConsentAt,
            patientConsentAt,
            documentedById: actor.id,
            note,
          },
          create: {
            fillId: id,
            priorManufacturerId: body.priorManufacturerId!,
            newManufacturerId: body.newManufacturerId!,
            prescriberConsentAt,
            patientConsentAt,
            documentedById: actor.id,
            note,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "NC_NTI_MANUFACTURER_CHANGE_CONSENT_DOCUMENTED",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            priorManufacturerId: body.priorManufacturerId,
            newManufacturerId: body.newManufacturerId,
            prescriberConsentAt: prescriberConsentAt.toISOString(),
            patientConsentAt: patientConsentAt.toISOString(),
            note,
          },
        });
        return record;
      });

      return reply.code(201).send({ consent });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/fills/:id/biologic-communication/complete", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "product:compliance");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as { note?: string };
      const note = body.note?.trim();
      if (!note) {
        return reply.code(400).send({
          error: "A prescriber-communication note is required.",
        });
      }

      const task = await db.biologicCommunicationTask.findFirst({
        where: {
          fillId: id,
          siteId: actor.siteId,
        },
      });
      if (!task) {
        return reply.code(404).send({
          error: "No biologic prescriber-communication task exists for this fill.",
        });
      }
      if (task.status === "COMPLETED") {
        return reply.code(409).send({
          error: "Biologic communication is already documented complete.",
        });
      }

      const completedAt = new Date();
      const completed = await db.$transaction(async (tx) => {
        const updated = await tx.biologicCommunicationTask.update({
          where: { id: task.id },
          data: {
            status: "COMPLETED",
            completedById: actor.id,
            completedAt,
            note,
          },
        });
        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "NC_BIOLOGIC_PRESCRIBER_COMMUNICATION_COMPLETED",
          entityType: "PrescriptionFill",
          entityId: id,
          requestId: request.id,
          metadata: {
            productName: task.productName,
            manufacturerName: task.manufacturerName,
            dueAt: task.dueAt.toISOString(),
            completedAt: completedAt.toISOString(),
            note,
          },
        });
        return updated;
      });

      return { task: completed };
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

      const isCompletion = fill.kind === "COMPLETION";

      if (
        (!isCompletion && fill.prescription.status !== "DUR_REVIEW") ||
        (isCompletion &&
          !["SOLD", "DUR_REVIEW"].includes(fill.prescription.status))
      ) {
        return reply.code(409).send({
          error: isCompletion
            ? "A completion fill can only start after the partial dispense has been sold."
            : "The prescription must be in DUR Review before starting the fill.",
        });
      }

      const startTime = new Date();

      if (!isCompletion) {
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
            partNumber: fill.partNumber,
            kind: fill.kind,
          },
        });

        return { fill: started, prescription: rx };
      });

      return {
        fill: result.fill,
        prescription: presentPrescription(result.prescription),
      };
    } catch (error) {
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
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

      const claimReversals = await reverseActivePaidClaimsForFill(id, {
        siteId: actor.siteId,
        actorId: actor.id,
        requestId: request.id,
      });
      await assertNoActivePaidClaimForMutation(id, actor.siteId);

      const result = await db.$transaction(async (tx) => {
        await returnInventoryForFill(tx, {
          fillId: id,
          siteId: actor.siteId,
          actorId: actor.id,
          reason: "Ready fill returned to stock",
        });

        const returned = await tx.prescriptionFill.update({
          where: { id },
          data: {
            status: "RETURNED_TO_STOCK",
            soldAt: null,
          },
        });

        const linkedCompletions = await tx.prescriptionFill.findMany({
          where: {
            completionOfFillId: id,
            status: "SCHEDULED",
          },
          select: { id: true },
        });

        await tx.prescriptionFill.updateMany({
          where: {
            completionOfFillId: id,
            status: "SCHEDULED",
          },
          data: { status: "CANCELLED" },
        });

        for (const completion of linkedCompletions) {
          await cancelDemandForFill(tx, completion.id);
        }

        await tx.willCallPackage.updateMany({
          where: {
            fillId: id,
            status: "STAGED",
          },
          data: {
            status: "RETURNED_TO_STOCK",
            returnedAt: new Date(),
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
      if (
        error instanceof AccessError ||
        error instanceof InventoryError ||
        error instanceof ClaimError
      ) {
        return reply.code(error.statusCode).send({
          error: error.message,
          ...(
            error instanceof InventoryError || error instanceof ClaimError
              ? { code: error.code, details: error.details }
              : {}
          ),
        });
      }
      throw error;
    }
  });
}
