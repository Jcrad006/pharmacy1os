import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma, type UserRole } from "@prisma/client";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError } from "../security/devIdentity.js";
import { authenticateSession } from "../security/sessions.js";

/**
 * Stage 3M.2: site-scoped staff administration for synthetic OIDC testing.
 *
 * A routine staff manager MUST NOT grant pharmacist, PIC, or administrator
 * authority. Those grants require independent credential review and a
 * separate, not-yet-implemented approval path. No self-enrollment.
 */
const routineRoles = [
  "TECHNICIAN", "INTERN", "CASHIER", "AUDITOR", "INVENTORY_MANAGER",
] as const satisfies readonly UserRole[];
type RoutineRole = (typeof routineRoles)[number];

function isRoutineRole(role: unknown): role is RoutineRole {
  return typeof role === "string" &&
    (routineRoles as readonly string[]).includes(role);
}

function requireOidc() {
  if (process.env.AUTH_MODE !== "oidc") {
    throw new AccessError(404, "Not found.");
  }
}

function validatedName(value: unknown) {
  if (typeof value !== "string" || value.trim().length < 2 ||
      value.trim().length > 120 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new AccessError(400, "A staff display name of 2–120 characters is required.");
  }
  return value.trim();
}

function validatedSubject(value: unknown) {
  if (typeof value !== "string" || value.trim() !== value ||
      value.length < 1 || value.length > 255 || /[\x00-\x20\x7f]/.test(value)) {
    throw new AccessError(400, "A valid, exact OIDC subject is required.");
  }
  return value;
}

function validatedExpectedDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new AccessError(400, "Expected site-role updatedAt timestamp is required.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AccessError(400, "Invalid expected timestamp.");
  }
  return date;
}

function targetId(raw: unknown) {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) {
    throw new AccessError(400, "Invalid staff ID.");
  }
  return raw;
}

function respondError(reply: FastifyReply, error: unknown) {
  if (error instanceof AccessError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return reply.code(409).send({ error: "This staff identity or site assignment already exists." });
  }
  throw error;
}

async function siteStaff(siteId: string) {
  return db.siteRoleAssignment.findMany({
    where: { siteId },
    include: {
      user: { select: { id: true, displayName: true, active: true, oidcSubject: true } },
    },
    orderBy: [{ user: { displayName: "asc" } }],
  });
}

export async function staffRoutes(app: FastifyInstance) {
  app.get("/staff", async (request, reply) => {
    try {
      requireOidc();
      const auth = await authenticateSession(request, "user:manage");
      const entries = await siteStaff(auth.actor.siteId);
      return {
        staff: entries.map(({ user, id, role, active, updatedAt }) => ({
          id: user.id, displayName: user.displayName, role, active,
          accountActive: user.active, provisioned: Boolean(user.oidcSubject),
          assignmentId: id, updatedAt: updatedAt.toISOString(),
        })),
        assignableRoles: routineRoles,
      };
    } catch (error) { return respondError(reply, error); }
  });

  app.post("/staff", async (request, reply) => {
    try {
      requireOidc();
      const auth = await authenticateSession(request, "user:manage");
      const body = request.body as {
        displayName?: unknown; oidcSubject?: unknown; role?: unknown;
      } | null;
      const displayName = validatedName(body?.displayName);
      const oidcSubject = validatedSubject(body?.oidcSubject);
      if (!isRoutineRole(body?.role)) {
        throw new AccessError(403, "Privileged roles cannot be self-provisioned or routinely assigned.");
      }
      const created = await db.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            siteId: auth.actor.siteId, displayName, oidcSubject,
            role: body.role as RoutineRole, active: true,
          },
        });
        const grant = await tx.siteRoleAssignment.create({
          data: { userId: user.id, siteId: auth.actor.siteId, role: body.role as RoutineRole },
        });
        await writeAuditEvent(tx, {
          siteId: auth.actor.siteId, actorId: auth.actor.id,
          action: "STAFF_PROVISIONED", entityType: "User",
          entityId: user.id, requestId: request.id,
          metadata: { role: grant.role, siteId: grant.siteId },
        });
        return { user, grant };
      });
      return reply.code(201).send({
        staff: {
          id: created.user.id, displayName: created.user.displayName,
          role: created.grant.role, active: created.grant.active,
          accountActive: created.user.active, provisioned: true,
          assignmentId: created.grant.id, updatedAt: created.grant.updatedAt.toISOString(),
        },
      });
    } catch (error) { return respondError(reply, error); }
  });

  app.patch("/staff/:id/role", async (request, reply) => {
    try {
      requireOidc();
      const auth = await authenticateSession(request, "user:manage");
      const id = targetId((request.params as { id?: unknown }).id);
      const body = request.body as { role?: unknown; expectedUpdatedAt?: unknown } | null;
      if (id === auth.actor.id) throw new AccessError(403, "Self-elevation or self-role changes are prohibited.");
      if (!isRoutineRole(body?.role)) {
        throw new AccessError(403, "Privileged roles require a separate, independently reviewed workflow.");
      }
      const expectedUpdatedAt = validatedExpectedDate(body?.expectedUpdatedAt);
      const changed = await db.$transaction(async (tx) => {
        const grant = await tx.siteRoleAssignment.findUnique({
          where: { userId_siteId: { userId: id, siteId: auth.actor.siteId } },
        });
        if (!grant) throw new AccessError(404, "Staff member not found at this site.");
        if (!grant.active || !isRoutineRole(grant.role)) {
          throw new AccessError(403, "Privileged or inactive assignments cannot be changed here.");
        }
        if (grant.role === body!.role) throw new AccessError(409, "Role is already assigned.");
        const now = new Date();
        const result = await tx.siteRoleAssignment.updateMany({
          where: { id: grant.id, active: true, updatedAt: expectedUpdatedAt },
          data: { role: body!.role as RoutineRole },
        });
        if (result.count !== 1) {
          throw new AccessError(409, "Staff role changed. Refresh and retry.");
        }
        const revoked = await tx.authSession.updateMany({
          where: { userId: id, siteId: auth.actor.siteId, revokedAt: null },
          data: { revokedAt: now },
        });
        await writeAuditEvent(tx, {
          siteId: auth.actor.siteId, actorId: auth.actor.id,
          action: "STAFF_SITE_ROLE_CHANGED", entityType: "SiteRoleAssignment",
          entityId: grant.id, requestId: request.id,
          metadata: {
            from: grant.role, to: body!.role as RoutineRole,
            invalidatedSessions: revoked.count,
          },
        });
        return tx.siteRoleAssignment.findUniqueOrThrow({ where: { id: grant.id } });
      });
      return { assignment: { id: changed.id, role: changed.role, active: changed.active,
        updatedAt: changed.updatedAt.toISOString() } };
    } catch (error) { return respondError(reply, error); }
  });

  app.patch("/staff/:id/site-access", async (request, reply) => {
    try {
      requireOidc();
      const auth = await authenticateSession(request, "user:manage");
      const id = targetId((request.params as { id?: unknown }).id);
      const body = request.body as { active?: unknown; expectedUpdatedAt?: unknown } | null;
      if (id === auth.actor.id) throw new AccessError(403, "You cannot change your own site access.");
      if (typeof body?.active !== "boolean") throw new AccessError(400, "active must be boolean.");
      const expectedUpdatedAt = validatedExpectedDate(body.expectedUpdatedAt);
      const result = await db.$transaction(async (tx) => {
        const grant = await tx.siteRoleAssignment.findUnique({
          where: { userId_siteId: { userId: id, siteId: auth.actor.siteId } },
        });
        if (!grant) throw new AccessError(404, "Staff member not found at this site.");
        // High-trust role assignment/deactivation requires independent review;
        // a routine manager cannot take over by disabling other site leaders.
        if (!isRoutineRole(grant.role)) {
          throw new AccessError(403, "Privileged site access changes require independent authorization.");
        }
        if (grant.active === body.active) throw new AccessError(409, "Site access already has this status.");
        const user = await tx.user.findUniqueOrThrow({ where: { id } });
        if (body.active && !user.active) {
          throw new AccessError(403, "The staff account is globally disabled.");
        }
        const changed = await tx.siteRoleAssignment.updateMany({
          where: { id: grant.id, updatedAt: expectedUpdatedAt },
          data: { active: body.active },
        });
        if (changed.count !== 1) throw new AccessError(409, "Site access changed. Refresh and retry.");
        // Always revoke affected sessions on any access change: no stale
        // capabilities or implicit reactivation of a prior login.
        const revoked = await tx.authSession.updateMany({
          where: { userId: id, siteId: auth.actor.siteId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await writeAuditEvent(tx, {
          siteId: auth.actor.siteId, actorId: auth.actor.id,
          action: body.active ? "STAFF_SITE_ACCESS_RESTORED" : "STAFF_SITE_ACCESS_REVOKED",
          entityType: "SiteRoleAssignment", entityId: grant.id,
          requestId: request.id,
          metadata: { revokedSessions: revoked.count },
        });
        return tx.siteRoleAssignment.findUniqueOrThrow({ where: { id: grant.id } });
      });
      return { assignment: { id: result.id, role: result.role, active: result.active,
        updatedAt: result.updatedAt.toISOString() } };
    } catch (error) { return respondError(reply, error); }
  });

  app.post("/staff/:id/sessions/revoke", async (request, reply) => {
    try {
      requireOidc();
      const auth = await authenticateSession(request, "user:manage");
      const id = targetId((request.params as { id?: unknown }).id);
      if (id === auth.actor.id) throw new AccessError(403, "Use Lock or Sign Out to revoke your own session.");
      const result = await db.$transaction(async (tx) => {
        const grant = await tx.siteRoleAssignment.findUnique({
          where: { userId_siteId: { userId: id, siteId: auth.actor.siteId } },
        });
        if (!grant) throw new AccessError(404, "Staff member not found at this site.");
        const revoked = await tx.authSession.updateMany({
          where: { userId: id, siteId: auth.actor.siteId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        await writeAuditEvent(tx, {
          siteId: auth.actor.siteId, actorId: auth.actor.id,
          action: "STAFF_SITE_SESSIONS_REVOKED", entityType: "User",
          entityId: id, requestId: request.id,
          metadata: { revokedSessions: revoked.count },
        });
        return revoked.count;
      });
      return { revokedSessions: result };
    } catch (error) { return respondError(reply, error); }
  });
}
