import type { DurSeverity, Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type CreateIssueBody = {
  code?: string;
  title?: string;
  description?: string;
  severity?: DurSeverity;
};

type CreateInterventionBody = {
  note?: string;
};

type ResolveIssueBody = {
  note?: string;
};

const severities = new Set<DurSeverity>(["INFO", "WARNING", "HIGH"]);

export async function clinicalRoutes(app: FastifyInstance) {
  app.get("/prescriptions/:id/clinical", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const id = (request.params as { id: string }).id;

      const prescription = await db.prescription.findFirst({
        where: { id, siteId: actor.siteId },
        select: { id: true },
      });

      if (!prescription) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      const [issues, interventions] = await Promise.all([
        db.durIssue.findMany({
          where: { prescriptionId: id },
          include: {
            resolvedBy: {
              select: { displayName: true, role: true },
            },
          },
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        }),
        db.interventionNote.findMany({
          where: { prescriptionId: id },
          include: {
            author: {
              select: { displayName: true, role: true },
            },
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      return { issues, interventions };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/prescriptions/:id/dur/issues", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "clinical:document");
      const id = (request.params as { id: string }).id;
      const body = request.body as CreateIssueBody;

      if (!body.code?.trim() || !body.title?.trim()) {
        return reply.code(400).send({ error: "code and title are required." });
      }

      if (body.severity && !severities.has(body.severity)) {
        return reply.code(400).send({ error: "Invalid DUR severity." });
      }

      const prescription = await db.prescription.findFirst({
        where: { id, siteId: actor.siteId },
        select: { id: true },
      });

      if (!prescription) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      const issue = await db.$transaction(async (tx) => {
        const created = await tx.durIssue.create({
          data: {
            prescriptionId: id,
            code: body.code!.trim().toUpperCase(),
            title: body.title!.trim(),
            description: body.description?.trim() || undefined,
            severity: body.severity ?? "WARNING",
            source: "SYNTHETIC_MANUAL",
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "DUR_ISSUE_OPENED",
          entityType: "DurIssue",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            prescriptionId: id,
            code: created.code,
            severity: created.severity,
            source: created.source,
          },
        });

        return created;
      });

      return reply.code(201).send({ issue });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.patch("/dur/issues/:id/resolve", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "clinical:document");
      const id = (request.params as { id: string }).id;
      const body = (request.body ?? {}) as ResolveIssueBody;
      const resolutionNote = body.note?.trim();

      if (!resolutionNote) {
        return reply.code(400).send({
          error: "A resolution note is required to close a DUR issue.",
        });
      }

      if (resolutionNote.length > 4000) {
        return reply.code(400).send({ error: "Resolution note is too long." });
      }

      const issue = await db.durIssue.findUnique({
        where: { id },
        include: {
          prescription: { select: { siteId: true, id: true } },
        },
      });

      if (!issue || issue.prescription.siteId !== actor.siteId) {
        return reply.code(404).send({ error: "DUR issue not found." });
      }

      if (issue.status === "RESOLVED") {
        return reply.code(409).send({ error: "DUR issue is already resolved." });
      }

      const resolved = await db.$transaction(async (tx) => {
        const updated = await tx.durIssue.update({
          where: { id },
          data: {
            status: "RESOLVED",
            resolvedAt: new Date(),
            resolutionNote,
            resolvedAutomatically: false,
            resolvedById: actor.id,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "DUR_ISSUE_RESOLVED",
          entityType: "DurIssue",
          entityId: id,
          requestId: request.id,
          metadata: {
            prescriptionId: issue.prescription.id,
            code: issue.code,
            resolutionNote,
          },
        });

        return updated;
      });

      return { issue: resolved };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/prescriptions/:id/interventions", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "clinical:document");
      const id = (request.params as { id: string }).id;
      const body = request.body as CreateInterventionBody;
      const note = body.note?.trim();

      if (!note) {
        return reply.code(400).send({ error: "Intervention note is required." });
      }

      if (note.length > 4000) {
        return reply.code(400).send({ error: "Intervention note is too long." });
      }

      const prescription = await db.prescription.findFirst({
        where: { id, siteId: actor.siteId },
        select: { id: true },
      });

      if (!prescription) {
        return reply.code(404).send({ error: "Prescription not found." });
      }

      const intervention = await db.$transaction(async (tx) => {
        const created = await tx.interventionNote.create({
          data: {
            prescriptionId: id,
            authorId: actor.id,
            note,
          },
          include: {
            author: {
              select: { displayName: true, role: true },
            },
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PHARMACIST_INTERVENTION_RECORDED",
          entityType: "InterventionNote",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            prescriptionId: id,
          } satisfies Prisma.InputJsonValue,
        });

        return created;
      });

      return reply.code(201).send({ intervention });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
