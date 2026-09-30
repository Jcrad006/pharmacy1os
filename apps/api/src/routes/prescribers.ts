import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type CreatePrescriberBody = {
  firstName?: string;
  lastName?: string;
  npi?: string;
  deaNumber?: string;
  phone?: string;
  fax?: string;
};

export async function prescriberRoutes(app: FastifyInstance) {
  app.get("/prescribers", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const query = String((request.query as { query?: string }).query ?? "").trim();

      const prescribers = await db.prescriber.findMany({
        where: {
          siteId: actor.siteId,
          ...(query
            ? {
                OR: [
                  { firstName: { contains: query, mode: "insensitive" } },
                  { lastName: { contains: query, mode: "insensitive" } },
                  { npi: { contains: query } },
                  { phone: { contains: query } },
                ],
              }
            : {}),
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        take: 50,
      });

      return { prescribers };
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/prescribers", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:enter");
      const body = request.body as CreatePrescriberBody;

      if (!body.firstName?.trim() || !body.lastName?.trim()) {
        return reply.code(400).send({ error: "firstName and lastName are required." });
      }

      const prescriber = await db.$transaction(async (tx) => {
        const created = await tx.prescriber.create({
          data: {
            siteId: actor.siteId,
            firstName: body.firstName!.trim(),
            lastName: body.lastName!.trim(),
            npi: body.npi?.trim() || undefined,
            deaNumber: body.deaNumber?.trim() || undefined,
            phone: body.phone?.trim() || undefined,
            fax: body.fax?.trim() || undefined,
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIBER_CREATED",
          entityType: "Prescriber",
          entityId: created.id,
          requestId: request.id,
        });

        return created;
      });

      return reply.code(201).send({ prescriber });
    } catch (error) {
      if (error instanceof AccessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
