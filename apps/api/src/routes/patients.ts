import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type CreatePatientBody = {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  phone?: string;
  email?: string;
};

export async function patientRoutes(app: FastifyInstance) {
  app.get("/patients", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "patient:read");
      const query = String((request.query as { query?: string }).query ?? "").trim();

      const patients = await db.patient.findMany({
        where: {
          siteId: actor.siteId,
          ...(query
            ? {
                OR: [
                  { firstName: { contains: query, mode: "insensitive" } },
                  { lastName: { contains: query, mode: "insensitive" } },
                  { phone: { contains: query } },
                ],
              }
            : {}),
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        take: 50,
      });

      return { patients };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/patients", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "patient:write");
      const body = request.body as CreatePatientBody;

      if (!body.firstName?.trim() || !body.lastName?.trim()) {
        return reply.code(400).send({ error: "firstName and lastName are required." });
      }

      const patient = await db.$transaction(async (tx) => {
        const created = await tx.patient.create({
          data: {
            siteId: actor.siteId,
            firstName: body.firstName!.trim(),
            lastName: body.lastName!.trim(),
            dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
            phone: body.phone?.trim() || undefined,
            email: body.email?.trim() || undefined,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PATIENT_CREATED",
          entityType: "Patient",
          entityId: created.id,
          requestId: request.id,
        });

        return created;
      });

      return reply.code(201).send({ patient });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
