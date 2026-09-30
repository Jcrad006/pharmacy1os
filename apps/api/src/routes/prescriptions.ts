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

type CreatePrescriptionBody = {
  patientId?: string;
  prescriberId?: string;
  rxNumber?: string;
  medicationName?: string;
  strength?: string;
  dosageForm?: string;
  sig?: string;
  quantityWritten?: number;
  refillsAllowed?: number;
  writtenDate?: string;
  doNotFillBefore?: string;
};

type TransitionBody = {
  status?: PrescriptionStatus;
};

type CreateFillBody = {
  scheduledFor?: string;
  quantity?: number;
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

const prescriptionInclude = {
  patient: true,
  prescriber: true,
  fills: { orderBy: { fillNumber: "desc" as const } },
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

function parseDate(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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

export async function prescriptionRoutes(app: FastifyInstance) {
  app.get("/prescriptions/queue", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const requestedStatus = (request.query as { status?: PrescriptionStatus }).status;

      if (requestedStatus && !validStatuses.has(requestedStatus)) {
        return reply.code(400).send({ error: "Invalid prescription status." });
      }

      const prescriptions = await db.prescription.findMany({
        where: {
          siteId: actor.siteId,
          ...(requestedStatus ? { status: requestedStatus } : {}),
        },
        include: prescriptionInclude,
        orderBy: [{ updatedAt: "asc" }],
        take: 100,
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
        !body.medicationName?.trim() ||
        !body.sig?.trim()
      ) {
        return reply.code(400).send({
          error: "patientId, prescriberId, medicationName, and sig are required.",
        });
      }

      const writtenDate = parseDate(body.writtenDate);
      const doNotFillBefore = parseDate(body.doNotFillBefore);

      if (writtenDate === null || doNotFillBefore === null) {
        return reply.code(400).send({ error: "Invalid date value." });
      }

      const [patient, prescriber] = await Promise.all([
        db.patient.findFirst({ where: { id: body.patientId, siteId: actor.siteId } }),
        db.prescriber.findFirst({ where: { id: body.prescriberId, siteId: actor.siteId } }),
      ]);

      if (!patient || !prescriber) {
        return reply.code(400).send({
          error: "Patient or prescriber does not belong to this pharmacy site.",
        });
      }

      const prescription = await db.$transaction(async (tx) => {
        const created = await tx.prescription.create({
          data: {
            siteId: actor.siteId,
            patientId: body.patientId!,
            prescriberId: body.prescriberId!,
            rxNumber: body.rxNumber?.trim() || undefined,
            medicationName: body.medicationName!.trim(),
            strength: body.strength?.trim() || undefined,
            dosageForm: body.dosageForm?.trim() || undefined,
            sig: body.sig!.trim(),
            quantityWritten: body.quantityWritten,
            refillsAllowed: Math.max(0, body.refillsAllowed ?? 0),
            writtenDate,
            doNotFillBefore,
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
          metadata: { rxNumber: created.rxNumber ?? null },
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
        current.status === "PRODUCT_FILL" &&
        body.status === "PHARMACIST_REVIEW" &&
        currentActiveFill?.status !== "IN_PROGRESS"
      ) {
        return reply.code(409).send({
          error: "An in-progress fill is required before pharmacist review.",
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
        include: { fills: { orderBy: { fillNumber: "desc" } } },
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

      const nextFillNumber = (prescription.fills[0]?.fillNumber ?? -1) + 1;
      const totalFillsAllowed = prescription.refillsAllowed + 1;

      if (nextFillNumber >= totalFillsAllowed) {
        return reply.code(409).send({ error: "No fills remain on this prescription." });
      }

      const scheduledFor = parseDate(body.scheduledFor);
      if (scheduledFor === null) {
        return reply.code(400).send({ error: "Invalid scheduledFor date." });
      }

      const now = new Date();
      const isFuture = Boolean(scheduledFor && scheduledFor.getTime() > now.getTime());

      if (
        prescription.doNotFillBefore &&
        (!scheduledFor ||
          scheduledFor.getTime() < prescription.doNotFillBefore.getTime())
      ) {
        return reply.code(409).send({
          error: "This fill is earlier than the prescription's do-not-fill-before date.",
        });
      }

      const result = await db.$transaction(async (tx) => {
        const created = await tx.prescriptionFill.create({
          data: {
            prescriptionId: prescription.id,
            fillNumber: nextFillNumber,
            scheduledFor,
            quantity: body.quantity ?? prescription.quantityWritten ?? undefined,
            status: isFuture ? "SCHEDULED" : "IN_PROGRESS",
          },
        });

        let rx = prescription;

        if (!isFuture) {
          rx = await tx.prescription.update({
            where: { id: prescription.id },
            data: { status: "PRODUCT_FILL" },
            include: { fills: { orderBy: { fillNumber: "desc" } } },
          });
        }

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

      if (
        fill.scheduledFor &&
        fill.scheduledFor.getTime() > Date.now()
      ) {
        return reply.code(409).send({
          error: "This fill is scheduled for a future date.",
        });
      }

      if (fill.prescription.status !== "DUR_REVIEW") {
        return reply.code(409).send({
          error: "The prescription must be in DUR Review before starting the fill.",
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
}
