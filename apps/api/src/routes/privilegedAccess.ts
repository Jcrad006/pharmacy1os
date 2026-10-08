import { Prisma, type UserRole } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError } from "../security/devIdentity.js";
import { authenticateSession } from "../security/sessions.js";
import { roleHasPermission, type Role } from "../security/roles.js";

// Explicit allowlists. This prototype cannot delegate pharmacist verification,
// controlled-substance authority, identity management or any clinical role
// through temporary permissions.
const temporaryPermissions = ["inventory:correct", "thirdparty:override"] as const;
const highTrustRoles = ["PHARMACIST", "PHARMACIST_IN_CHARGE", "ADMIN"] as const satisfies readonly UserRole[];
type HighTrustRole = (typeof highTrustRoles)[number];
type TemporaryPermission = (typeof temporaryPermissions)[number];
const REQUEST_TTL_MS = 10 * 60_000;
const ELEVATION_TTL_MS = 15 * 60_000;
const STEP_UP_WINDOW_MS = 5 * 60_000;

function oidcOnly() {
  if (process.env.AUTH_MODE !== "oidc" || process.env.NODE_ENV === "production") {
    throw new AccessError(404, "Not found.");
  }
}
function bodyText(raw: unknown, field = "Reason") {
  if (typeof raw !== "string" || raw.trim().length < 10 || raw.trim().length > 500 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) {
    throw new AccessError(400, field + " must be between 10 and 500 characters.");
  }
  return raw.trim();
}
function identifier(raw: unknown) {
  if (typeof raw !== "string" || !raw || raw.length > 128) {
    throw new AccessError(400, "Invalid request or staff identifier.");
  }
  return raw;
}
function parseTimestamp(raw: unknown) {
  if (typeof raw !== "string" || !/^\d{4}-\d\d-\d\dT/.test(raw)) {
    throw new AccessError(400, "Expected role revision is required.");
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new AccessError(400, "Invalid role revision.");
  return date;
}
function freshMfa(verifiedAt: Date, now: Date) {
  const age = now.getTime() - verifiedAt.getTime();
  if (age < -60_000 || age > STEP_UP_WINDOW_MS) {
    throw new AccessError(403, "A fresh multifactor sign-in is required for privileged actions.");
  }
}
function isHighTrustRole(raw: unknown): raw is HighTrustRole {
  return typeof raw === "string" && (highTrustRoles as readonly string[]).includes(raw);
}
function isTemporaryPermission(raw: unknown): raw is TemporaryPermission {
  return typeof raw === "string" && (temporaryPermissions as readonly string[]).includes(raw);
}
function mayRequestRole(current: UserRole, target: HighTrustRole) {
  if (target === "ADMIN") return current === "PHARMACIST_IN_CHARGE";
  return current === "ADMIN";
}
function mayApproveRole(current: UserRole, target: HighTrustRole) {
  return target === "ADMIN" ? current === "ADMIN" : current === "PHARMACIST_IN_CHARGE";
}
function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AccessError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2002", "P2034"].includes(error.code)) {
    return reply.code(409).send({ error: "Concurrent authorization change. Refresh and retry." });
  }
  throw error;
}
function publicRequest(entry: {
  id: string; siteId: string; targetUserId: string; requestedById: string;
  reviewedById: string | null; kind: string; status: string;
  requestedRole: UserRole | null; requestedPermission: string | null;
  reason: string; reviewNote: string | null;
  createdAt: Date; reviewDeadlineAt: Date; reviewedAt: Date | null;
  effectiveUntil: Date | null;
}) {
  const { id, siteId, targetUserId, requestedById, reviewedById, kind, status,
    requestedRole, requestedPermission, reason, reviewNote, createdAt,
    reviewDeadlineAt, reviewedAt, effectiveUntil } = entry;
  return {
    id, siteId, targetUserId, requestedById, reviewedById, kind, status,
    requestedRole, requestedPermission, reason, reviewNote,
    createdAt: createdAt.toISOString(), reviewDeadlineAt: reviewDeadlineAt.toISOString(),
    reviewedAt: reviewedAt?.toISOString() ?? null,
    effectiveUntil: effectiveUntil?.toISOString() ?? null,
  };
}

export async function privilegedAccessRoutes(app: FastifyInstance) {
  app.get("/privileged/requests", async (request, reply) => {
    try {
      oidcOnly();
      const auth = await authenticateSession(request);
      const manager = roleHasPermission(auth.actor.role as Role, "user:manage");
      const entries = await db.privilegedAccessRequest.findMany({
        where: {
          siteId: auth.actor.siteId,
          ...(manager ? {} : { OR: [
            { requestedById: auth.actor.id }, { targetUserId: auth.actor.id },
          ] }),
        },
        orderBy: { createdAt: "desc" }, take: 100,
      });
      return { requests: entries.map(publicRequest), temporaryPermissions };
    } catch (error) { return fail(reply, error); }
  });

  app.post("/privileged/requests", async (request, reply) => {
    try {
      oidcOnly();
      const auth = await authenticateSession(request);
      const now = new Date();
      freshMfa(auth.mfaVerifiedAt, now);
      const input = request.body as {
        kind?: unknown; targetUserId?: unknown; requestedRole?: unknown;
        requestedPermission?: unknown; expectedAssignmentUpdatedAt?: unknown;
        reason?: unknown;
      } | null;
      const reason = bodyText(input?.reason);
      let kind: "ROLE_GRANT" | "TEMP_PERMISSION";
      let targetUserId: string;
      let requestedRole: HighTrustRole | undefined;
      let requestedPermission: TemporaryPermission | undefined;
      let expectedAssignmentUpdatedAt: Date | undefined;

      if (input?.kind === "TEMP_PERMISSION" && isTemporaryPermission(input?.requestedPermission)) {
        kind = "TEMP_PERMISSION";
        targetUserId = auth.actor.id;
        requestedPermission = input.requestedPermission;
        const prerequisite = requestedPermission === "inventory:correct"
          ? "inventory:write" : "thirdparty:write";
        if (!roleHasPermission(auth.actor.role as Role, prerequisite) ||
            roleHasPermission(auth.actor.role as Role, requestedPermission)) {
          throw new AccessError(403, "Temporary privilege unavailable for this role.");
        }
        if (input.targetUserId !== undefined && input.targetUserId !== targetUserId) {
          throw new AccessError(403, "Temporary elevation can only be requested for yourself.");
        }
      } else if (input?.kind === "ROLE_GRANT" && isHighTrustRole(input.requestedRole)) {
        kind = "ROLE_GRANT";
        requestedRole = input.requestedRole;
        targetUserId = identifier(input.targetUserId);
        expectedAssignmentUpdatedAt = parseTimestamp(input.expectedAssignmentUpdatedAt);
        if (targetUserId === auth.actor.id || !mayRequestRole(auth.actor.role, requestedRole)) {
          throw new AccessError(403, "This privileged role request requires another authorized requester.");
        }
      } else {
        throw new AccessError(403, "This privilege is not available for delegation.");
      }
      const target = await db.user.findUnique({ where: { id: targetUserId } });
      const targetGrant = await db.siteRoleAssignment.findUnique({
        where: { userId_siteId: { userId: targetUserId, siteId: auth.actor.siteId } },
      });
      if (!target?.active || !target.oidcSubject || !targetGrant?.active) {
        throw new AccessError(404, "No active provisioned staff member at this site.");
      }
      if (requestedRole && (targetGrant.role === requestedRole ||
          targetGrant.updatedAt.getTime() !== expectedAssignmentUpdatedAt?.getTime())) {
        throw new AccessError(409, "Site role revision is stale or unchanged.");
      }
      const existing = await db.privilegedAccessRequest.findFirst({
        where: {
          siteId: auth.actor.siteId, targetUserId, kind, status: "PENDING",
          reviewDeadlineAt: { gt: now },
          ...(requestedRole ? { requestedRole } : { requestedPermission }),
        },
        select: { id: true },
      });
      if (existing) throw new AccessError(409, "A matching privilege request is pending.");
      const entry = await db.$transaction(async tx => {
        const created = await tx.privilegedAccessRequest.create({
          data: {
            siteId: auth.actor.siteId, targetUserId, requestedById: auth.actor.id,
            kind, reason, requestedRole, requestedPermission, expectedAssignmentUpdatedAt,
            reviewDeadlineAt: new Date(now.getTime() + REQUEST_TTL_MS),
          },
        });
        await writeAuditEvent(tx, {
          siteId: auth.actor.siteId, actorId: auth.actor.id,
          action: "PRIVILEGE_APPROVAL_REQUESTED", entityType: "PrivilegedAccessRequest",
          entityId: created.id, requestId: request.id,
          metadata: { kind, requestedRole: requestedRole ?? null,
            requestedPermission: requestedPermission ?? null, targetUserId },
        });
        return created;
      });
      return reply.code(201).send({ request: publicRequest(entry) });
    } catch (error) { return fail(reply, error); }
  });

  app.post("/privileged/requests/:id/review", async (request, reply) => {
    try {
      oidcOnly();
      const auth = await authenticateSession(request);
      const now = new Date();
      freshMfa(auth.mfaVerifiedAt, now);
      const requestId = identifier((request.params as { id?: unknown }).id);
      const body = request.body as { decision?: unknown; note?: unknown } | null;
      if (body?.decision !== "APPROVED" && body?.decision !== "DENIED") {
        throw new AccessError(400, "Decision must be APPROVED or DENIED.");
      }
      const decision = body.decision;
      const note = bodyText(body.note, "Review note");
      const result = await db.$transaction(async tx => {
        const entry = await tx.privilegedAccessRequest.findFirst({
          where: { id: requestId, siteId: auth.actor.siteId },
        });
        if (!entry) throw new AccessError(404, "Privilege request not found at this site.");
        if (entry.status !== "PENDING" || entry.reviewDeadlineAt <= now) {
          throw new AccessError(409, "Privilege request is no longer open.");
        }
        if (entry.requestedById === auth.actor.id || entry.targetUserId === auth.actor.id) {
          throw new AccessError(403, "Requesters and beneficiaries cannot approve their own privileges.");
        }
        const isManager = ["ADMIN", "PHARMACIST_IN_CHARGE"].includes(auth.actor.role);
        if (entry.kind === "ROLE_GRANT") {
          if (!entry.requestedRole || !isHighTrustRole(entry.requestedRole) ||
              !mayApproveRole(auth.actor.role, entry.requestedRole)) {
            throw new AccessError(403, "An independent designated site leader must review this grant.");
          }
        } else if (!isManager) {
          throw new AccessError(403, "Temporary permissions require a site leader's approval.");
        }
        const target = await tx.user.findUnique({ where: { id: entry.targetUserId } });
        const grant = await tx.siteRoleAssignment.findUnique({
          where: { userId_siteId: { userId: entry.targetUserId, siteId: entry.siteId } },
        });
        if (!target?.active || !target.oidcSubject || !grant?.active) {
          throw new AccessError(409, "Target staff access is no longer active.");
        }
        if (entry.kind === "TEMP_PERMISSION") {
          const prerequisite = entry.requestedPermission === "inventory:correct"
            ? "inventory:write" : "thirdparty:write";
          if (!isTemporaryPermission(entry.requestedPermission) ||
              !roleHasPermission(grant.role as Role, prerequisite) ||
              roleHasPermission(grant.role as Role, entry.requestedPermission)) {
            throw new AccessError(409, "Staff role no longer qualifies for elevation.");
          }
        }
        const claimed = await tx.privilegedAccessRequest.updateMany({
          where: {
            id: entry.id, status: "PENDING",
            reviewDeadlineAt: { gt: now }, reviewedById: null,
          },
          data: {
            status: decision, reviewedById: auth.actor.id, reviewedAt: now,
            reviewNote: note,
            effectiveUntil: decision === "APPROVED" && entry.kind === "TEMP_PERMISSION"
              ? new Date(now.getTime() + ELEVATION_TTL_MS) : null,
          },
        });
        if (claimed.count !== 1) throw new AccessError(409, "Another reviewer already decided.");
        let revoked = 0;
        if (decision === "APPROVED" && entry.kind === "ROLE_GRANT") {
          if (!entry.requestedRole || !entry.expectedAssignmentUpdatedAt) {
            throw new AccessError(409, "Role request is invalid.");
          }
          const changed = await tx.siteRoleAssignment.updateMany({
            where: {
              id: grant.id, active: true,
              updatedAt: entry.expectedAssignmentUpdatedAt,
            },
            data: { role: entry.requestedRole },
          });
          if (changed.count !== 1) throw new AccessError(409, "Target role changed since request.");
          const sessions = await tx.authSession.updateMany({
            where: { userId: entry.targetUserId, siteId: entry.siteId, revokedAt: null },
            data: { revokedAt: now },
          });
          revoked = sessions.count;
          // Previous scoped permissions must not survive a material role change.
          await tx.privilegedAccessRequest.updateMany({
            where: {
              siteId: entry.siteId, targetUserId: entry.targetUserId,
              kind: "TEMP_PERMISSION", status: "APPROVED",
            },
            data: { status: "CANCELLED", effectiveUntil: now },
          });
        }
        await writeAuditEvent(tx, {
          siteId: entry.siteId, actorId: auth.actor.id,
          action: decision === "APPROVED" ? "PRIVILEGE_APPROVED" : "PRIVILEGE_DENIED",
          entityType: "PrivilegedAccessRequest", entityId: entry.id,
          requestId: request.id,
          metadata: {
            kind: entry.kind, requestedRole: entry.requestedRole,
            requestedPermission: entry.requestedPermission,
            requestedById: entry.requestedById, targetUserId: entry.targetUserId,
            revokedSessions: revoked,
          },
        });
        return tx.privilegedAccessRequest.findUniqueOrThrow({ where: { id: entry.id } });
      });
      return { request: publicRequest(result) };
    } catch (error) { return fail(reply, error); }
  });

  app.post("/privileged/requests/:id/cancel", async (request, reply) => {
    try {
      oidcOnly();
      const auth = await authenticateSession(request);
      const now = new Date();
      const id = identifier((request.params as { id?: unknown }).id);
      const changed = await db.$transaction(async tx => {
        const entry = await tx.privilegedAccessRequest.findFirst({
          where: { id, siteId: auth.actor.siteId },
        });
        if (!entry) throw new AccessError(404, "Privilege request not found at this site.");
        if (entry.requestedById !== auth.actor.id && entry.targetUserId !== auth.actor.id) {
          throw new AccessError(403, "Only the requester or beneficiary may cancel.");
        }
        if (entry.status !== "PENDING" &&
            !(entry.status === "APPROVED" && entry.kind === "TEMP_PERMISSION")) {
          throw new AccessError(409, "This approval cannot be cancelled.");
        }
        const claimed = await tx.privilegedAccessRequest.updateMany({
          where: { id: entry.id, status: entry.status },
          data: { status: "CANCELLED", effectiveUntil: now },
        });
        if (claimed.count !== 1) throw new AccessError(409, "Approval changed concurrently.");
        await writeAuditEvent(tx, {
          siteId: entry.siteId, actorId: auth.actor.id,
          action: "PRIVILEGE_CANCELLED", entityType: "PrivilegedAccessRequest",
          entityId: entry.id, requestId: request.id,
          metadata: { previousStatus: entry.status, targetUserId: entry.targetUserId },
        });
        return tx.privilegedAccessRequest.findUniqueOrThrow({ where: { id: entry.id } });
      });
      return { request: publicRequest(changed) };
    } catch (error) { return fail(reply, error); }
  });
}
