import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type ProviderAddressInput = {
  label?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  isPrimary?: boolean;
};

type CreatePrescriberBody = {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  npi?: string;
  deaNumber?: string;
  stateProviderId?: string;
  stateProviderIdState?: string;
  phone?: string;
  fax?: string;
  addresses?: ProviderAddressInput[];
};

type PrescriberQuery = {
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

  let iso = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw.slice(0, 10) : raw;
  const usMatch = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (usMatch) {
    const month = usMatch[1]!;
    const day = usMatch[2]!;
    const year = usMatch[3]!;
    iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeAddresses(addresses?: ProviderAddressInput[]) {
  const populated = (addresses ?? []).filter((address) =>
    [
      address.label,
      address.addressLine1,
      address.addressLine2,
      address.city,
      address.state,
      address.postalCode,
    ].some((value) => value?.trim()),
  );

  for (const address of populated) {
    if (
      !address.addressLine1?.trim() ||
      !address.city?.trim() ||
      !address.state?.trim() ||
      !address.postalCode?.trim()
    ) {
      return null;
    }
  }

  return populated.map((address, index) => ({
    label: address.label?.trim() || undefined,
    addressLine1: address.addressLine1!.trim(),
    addressLine2: address.addressLine2?.trim() || undefined,
    city: address.city!.trim(),
    state: address.state!.trim().toUpperCase(),
    postalCode: address.postalCode!.trim(),
    isPrimary:
      address.isPrimary === true ||
      (!populated.some((item) => item.isPrimary === true) && index === 0),
  }));
}

export async function prescriberRoutes(app: FastifyInstance) {
  app.get("/prescribers", async (request, reply) => {
    try {
      const actor = await resolveDevelopmentActor(request, "prescription:read");
      const filters = request.query as PrescriberQuery;
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

      const prescribers = await db.prescriber.findMany({
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
                    { npi: { contains: generic } },
                    { deaNumber: { contains: generic, mode: "insensitive" } },
                    { stateProviderId: { contains: generic, mode: "insensitive" } },
                    ...(genericPhone
                      ? [{ phoneSearch: { contains: genericPhone } }]
                      : []),
                  ],
                }
            : {}),
        },
        include: {
          addresses: {
            orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          },
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { dateOfBirth: "asc" }],
        take: 100,
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

      const dateOfBirth = parseDirectoryDate(body.dateOfBirth);
      if (dateOfBirth === null) {
        return reply.code(400).send({ error: "Invalid date of birth." });
      }

      const addresses = normalizeAddresses(body.addresses);
      if (addresses === null) {
        return reply.code(400).send({
          error: "Each provider address requires street, city, state, and postal code.",
        });
      }

      const prescriber = await db.$transaction(async (tx) => {
        const created = await tx.prescriber.create({
          data: {
            siteId: actor.siteId,
            firstName: body.firstName!.trim(),
            lastName: body.lastName!.trim(),
            dateOfBirth: dateOfBirth instanceof Date ? dateOfBirth : undefined,
            npi: body.npi?.trim() || undefined,
            deaNumber: body.deaNumber?.trim().toUpperCase() || undefined,
            stateProviderId: body.stateProviderId?.trim() || undefined,
            stateProviderIdState:
              body.stateProviderIdState?.trim().toUpperCase() || undefined,
            phone: body.phone?.trim() || undefined,
            phoneSearch: normalizePhone(body.phone) || undefined,
            fax: body.fax?.trim() || undefined,
            addresses:
              addresses.length > 0
                ? {
                    create: addresses,
                  }
                : undefined,
          },
          include: {
            addresses: {
              orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
            },
          },
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIBER_CREATED",
          entityType: "Prescriber",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            addressCount: created.addresses.length,
            hasDeaNumber: Boolean(created.deaNumber),
            hasStateProviderId: Boolean(created.stateProviderId),
          },
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
