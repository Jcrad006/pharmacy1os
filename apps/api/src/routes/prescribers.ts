import type {
  PrescriberContactType,
  PrescriberIdentifierType,
} from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError, resolveDevelopmentActor } from "../security/devIdentity.js";

type ProviderIdentifierInput = {
  type?: PrescriberIdentifierType;
  number?: string;
  jurisdiction?: string;
  isPrimary?: boolean;
};

type ProviderContactInput = {
  type?: PrescriberContactType;
  label?: string;
  value?: string;
  extension?: string;
  isPrimary?: boolean;
};

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
  practiceLevel?: string;
  dateOfBirth?: string;
  identifiers?: ProviderIdentifierInput[];
  contacts?: ProviderContactInput[];
  addresses?: ProviderAddressInput[];

  // Transitional aliases accepted by older development callers.
  npi?: string;
  deaNumber?: string;
  stateProviderId?: string;
  stateProviderIdState?: string;
  phone?: string;
  fax?: string;
};

type PrescriberQuery = {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  phone?: string;
  query?: string;
};

const providerInclude = {
  identifiers: {
    orderBy: [{ type: "asc" as const }, { isPrimary: "desc" as const }, { createdAt: "asc" as const }],
  },
  contacts: {
    orderBy: [{ type: "asc" as const }, { isPrimary: "desc" as const }, { createdAt: "asc" as const }],
  },
  addresses: {
    orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
  },
};

function normalizePhone(value?: string) {
  return (value ?? "").replace(/\D/g, "");
}

function normalizeIdentifier(value?: string) {
  return (value ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
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

function normalizeIdentifiers(body: CreatePrescriberBody) {
  const raw: ProviderIdentifierInput[] = [...(body.identifiers ?? [])];

  if (body.npi?.trim()) {
    raw.push({ type: "NPI", number: body.npi, isPrimary: true });
  }
  if (body.deaNumber?.trim()) {
    raw.push({
      type: "DEA",
      number: body.deaNumber,
      jurisdiction: body.stateProviderIdState,
      isPrimary: true,
    });
  }
  if (body.stateProviderId?.trim()) {
    raw.push({
      type: "STATE_ID",
      number: body.stateProviderId,
      jurisdiction: body.stateProviderIdState,
      isPrimary: true,
    });
  }

  const normalized = raw
    .filter((item) => item.number?.trim())
    .map((item) => ({
      type: item.type,
      number: item.number!.trim(),
      numberSearch: normalizeIdentifier(item.number),
      jurisdiction: item.jurisdiction?.trim().toUpperCase() ?? "",
      isPrimary: item.isPrimary === true,
    }));

  if (normalized.some((item) => !item.type)) {
    return { error: "Each provider identifier requires a type." } as const;
  }

  if (normalized.filter((item) => item.type === "NPI").length > 1) {
    return { error: "A provider may have only one NPI." } as const;
  }

  if (
    normalized.some(
      (item) => item.type === "STATE_ID" && !item.jurisdiction,
    )
  ) {
    return {
      error: "Each State Provider ID requires its issuing state/jurisdiction.",
    } as const;
  }

  const seen = new Set<string>();
  const unique = normalized.filter((item) => {
    const key = `${item.type}:${item.numberSearch}:${item.jurisdiction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const type of ["NPI", "DEA", "STATE_ID"] as const) {
    const ofType = unique.filter((item) => item.type === type);
    if (ofType.length > 0 && !ofType.some((item) => item.isPrimary)) {
      ofType[0]!.isPrimary = true;
    }
  }

  return { identifiers: unique } as const;
}

function normalizeContacts(body: CreatePrescriberBody) {
  const raw: ProviderContactInput[] = [...(body.contacts ?? [])];

  if (body.phone?.trim()) {
    raw.push({ type: "PHONE", label: "Main", value: body.phone, isPrimary: true });
  }
  if (body.fax?.trim()) {
    raw.push({ type: "FAX", label: "Main", value: body.fax, isPrimary: true });
  }

  const normalized = raw
    .filter((item) => item.value?.trim())
    .map((item) => ({
      type: item.type,
      label: item.label?.trim() || undefined,
      value: item.value!.trim(),
      valueSearch: normalizePhone(item.value),
      extension: item.extension?.trim() || undefined,
      isPrimary: item.isPrimary === true,
    }));

  if (normalized.some((item) => !item.type)) {
    return { error: "Each provider contact requires a phone or fax type." } as const;
  }

  for (const type of ["PHONE", "FAX"] as const) {
    const ofType = normalized.filter((item) => item.type === type);
    if (ofType.length > 0 && !ofType.some((item) => item.isPrimary)) {
      ofType[0]!.isPrimary = true;
    }
  }

  return { contacts: normalized } as const;
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

  const normalized = populated.map((address) => ({
    label: address.label?.trim() || undefined,
    addressLine1: address.addressLine1!.trim(),
    addressLine2: address.addressLine2?.trim() || undefined,
    city: address.city!.trim(),
    state: address.state!.trim().toUpperCase(),
    postalCode: address.postalCode!.trim(),
    isPrimary: address.isPrimary === true,
  }));

  if (normalized.length > 0 && !normalized.some((address) => address.isPrimary)) {
    normalized[0]!.isPrimary = true;
  }

  return normalized;
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
      const genericIdentifier = normalizeIdentifier(generic);
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
          ...(phoneSearch
            ? {
                contacts: {
                  some: {
                    type: "PHONE",
                    valueSearch: { contains: phoneSearch },
                  },
                },
              }
            : {}),
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
                    { practiceLevel: { startsWith: generic, mode: "insensitive" } },
                    ...(genericIdentifier
                      ? [
                          {
                            identifiers: {
                              some: {
                                numberSearch: { contains: genericIdentifier },
                              },
                            },
                          },
                        ]
                      : []),
                    ...(genericPhone
                      ? [
                          {
                            contacts: {
                              some: {
                                valueSearch: { contains: genericPhone },
                              },
                            },
                          },
                        ]
                      : []),
                  ],
                }
            : {}),
        },
        include: providerInclude,
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

      const identifierResult = normalizeIdentifiers(body);
      if ("error" in identifierResult) {
        return reply.code(400).send({ error: identifierResult.error });
      }

      const contactResult = normalizeContacts(body);
      if ("error" in contactResult) {
        return reply.code(400).send({ error: contactResult.error });
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
            practiceLevel: body.practiceLevel?.trim().toUpperCase() || "UNKNOWN",
            dateOfBirth: dateOfBirth instanceof Date ? dateOfBirth : undefined,
            identifiers:
              identifierResult.identifiers.length > 0
                ? {
                    create: identifierResult.identifiers.map((item) => ({
                      siteId: actor.siteId,
                      type: item.type!,
                      number: item.number,
                      numberSearch: item.numberSearch,
                      jurisdiction: item.jurisdiction,
                      isPrimary: item.isPrimary,
                    })),
                  }
                : undefined,
            contacts:
              contactResult.contacts.length > 0
                ? { create: contactResult.contacts.map((item) => ({ ...item, type: item.type! })) }
                : undefined,
            addresses:
              addresses.length > 0
                ? { create: addresses }
                : undefined,
          },
          include: providerInclude,
        });

        await writeAuditEvent(tx, {
          siteId: actor.siteId,
          actorId: actor.id,
          action: "PRESCRIBER_CREATED",
          entityType: "Prescriber",
          entityId: created.id,
          requestId: request.id,
          metadata: {
            practiceLevel: created.practiceLevel,
            identifierCount: created.identifiers.length,
            contactCount: created.contacts.length,
            addressCount: created.addresses.length,
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
