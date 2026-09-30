import type { FastifyInstance } from "fastify";
import type { PrescriptionStatus } from "@prisma/client";
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
        include: {
          patient: true,
          prescriber: true,
          fills: { orderBy: { fillNumber: "desc" } },
        },
        orderBy: [{ updatedAt: "asc" }],
        take: 100,
      });

      return {
        prescriptions: prescriptions.map((rx) => ({
          ...rx,
          allowedTransitions: allowedTransitions(rx.status),
        })),
      };
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

      if (!body.patientId || !body.prescriberId || !body.medicationName?.trim() || !body.sig?.trim()) {
        return reply.code(400).send({
          error: "patientId, prescriberId, medicationName, and sig are required.",
        });
      }

      const [patient, prescriber] = await Promise.all([
        db.patient.findFirst({ where: { id: body.patientId, siteId: actor.siteId } }),
        db.prescriber.findFirst({ where: { id: body.prescriberId, siteId: actor.siteId } }),
      ]);

      if (!patient || !prescriber) {
        return reply.code(400).send({ error: "Patient or prescriber does not belong to this pharmacy site." });
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
            writtenDate: body.writtenDate ? new Date(body.writtenDate) : undefined,
            doNotFillBefore: body.doNotFillBefore ? new Date(body.doNotFillBefore) : undefined,
            status: "DATA_ENTRY",
          },
          include: { patient: true, prescriber: true, fills: true },
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

      return reply.code(201).send({ prescription });
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

      const current = await db.prescription.findUnique({ where: { id } });
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

      if (!canTransitionPrescription(current.status, body.status)) {
        return reply.code(409).send({
          error: `Transition ${current.status} → ${body.status} is not allowed.`,
          allowedTransitions: allowedTransitions(current.status),
        });
      }

      const updated = await db.$transaction(async (tx) => {
        const rx = await tx.prescription.update({
          where: { id },
          data: { status: body.status },
          include: { patient: true, prescriber: true, fills: true },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIPTION_STATUS_CHANGED",
          entityType: "Prescription",
          entityId: id,
          requestId: request.id,
          metadata: { from: current.status, to: body.status },
        });

        return rx;
      });

      return { prescription: updated };
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
        include: { fills: { orderBy: { fillNumber: "desc" }, take: 1 } },
      });

      if (!prescription) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      if (prescription.status === "CANCELLED" || prescription.status === "TRANSFERRED") {
        return reply.code(409).send({ error: "A fill cannot be created for this prescription." });
      }

      const nextFillNumber = (prescription.fills[0]?.fillNumber ?? -1) + 1;
      const availableFills = prescription.refillsAllowed + 1;

      if (nextFillNumber >= availableFills) {
        return reply.code(409).send({ error: "No fills remain on this prescription." });
      }

      const fill = await db.$transaction(async (tx) => {
        const created = await tx.prescriptionFill.create({
          data: {
            prescriptionId: prescription.id,
            fillNumber: nextFillNumber,
            scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : undefined,
            quantity: body.quantity ?? prescription.quantityWritten ?? undefined,
            status: body.scheduledFor ? "SCHEDULED" : "IN_PROGRESS",
          },
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
          },
        });

        return created;
      });

      return reply.code(201).send({ fill });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
