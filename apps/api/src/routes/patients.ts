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

type PatientQuery = {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  phone?: string;
  query?: string;
};

function normalizePhone(value?: string) {
  return (value ?? "").replace(/\D/g, "");
}

function parseDirectoryDate(value?: string) {
  const raw = value?.trim();
  if (!raw) return undefined;

  let iso = raw;
  const usMatch = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}


export async function patientRoutes(app: FastifyInstance) {
  app.get("/patients", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "patient:read");
      const filters = request.query as PatientQuery;
      const firstName = filters.firstName?.trim();
      const lastName = filters.lastName?.trim();
      const phoneSearch = normalizePhone(filters.phone);
      const dateOfBirth = parseDirectoryDate(filters.dateOfBirth);

      if (dateOfBirth === null) {
        return reply.code(400).send({ error: "DOB must use YYYY-MM-DD or MM/DD/YYYY." });
      }

      const generic = filters.query?.trim();
      const genericPhone = normalizePhone(generic);
      const commaParts = generic?.includes(",")
        ? generic.split(",", 2).map((part) => part.trim())
        : null;

      const patients = await db.patient.findMany({
        where: {
          siteId: actor.siteId,
          ...(lastName
            ? { lastName: { startsWith: lastName, mode: "insensitive" } }
            : {}),
          ...(firstName
            ? { firstName: { startsWith: firstName, mode: "insensitive" } }
            : {}),
          ...(dateOfBirth instanceof Date ? { dateOfBirth } : {}),
          ...(phoneSearch ? { phoneSearch: { contains: phoneSearch } } : {}),
          ...(generic
            ? commaParts
              ? {
                  lastName: { startsWith: commaParts[0] ?? "", mode: "insensitive" },
                  ...(commaParts[1]
                    ? { firstName: { startsWith: commaParts[1], mode: "insensitive" } }
                    : {}),
                }
              : {
                  OR: [
                    { lastName: { startsWith: generic, mode: "insensitive" } },
                    { firstName: { startsWith: generic, mode: "insensitive" } },
                    ...(genericPhone
                      ? [{ phoneSearch: { contains: genericPhone } }]
                      : []),
                  ],
                }
            : {}),
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { dateOfBirth: "asc" }],
        take: 100,
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

      const dateOfBirth = parseDirectoryDate(body.dateOfBirth);
      if (dateOfBirth === null) {
        return reply.code(400).send({ error: "Invalid date of birth." });
      }

      const patient = await db.$transaction(async (tx) => {
        const created = await tx.patient.create({
          data: {
            siteId: actor.siteId,
            firstName: body.firstName!.trim(),
            lastName: body.lastName!.trim(),
            dateOfBirth: dateOfBirth instanceof Date ? dateOfBirth : undefined,
            phone: body.phone?.trim() || undefined,
            phoneSearch: normalizePhone(body.phone) || undefined,
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
