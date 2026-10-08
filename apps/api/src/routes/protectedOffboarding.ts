import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError } from "../security/devIdentity.js";
import { authenticateSession } from "../security/sessions.js";

const REQUEST_LIFETIME_MS = 10 * 60_000;
const RECENT_MFA_MS = 5 * 60_000;
const highTrust = ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE"] as const;

function requireOidc() {
  if (process.env.AUTH_MODE !== "oidc" || process.env.NODE_ENV === "production") {
    throw new AccessError(404, "Not found.");
  }
}
function freshMfa(mfaDate: Date) {
  const elapsed = Date.now() - mfaDate.getTime();
  if (elapsed < -60_000 || elapsed > RECENT_MFA_MS)
    throw new AccessError(403, "Protected offboarding requires a recent multifactor login.");
}
function validId(raw: unknown) {
  if (typeof raw !== "string" || !raw || raw.length > 128)
    throw new AccessError(400, "Invalid target or offboarding request identifier.");
  return raw;
}
function note(raw: unknown, field: string) {
  if (typeof raw !== "string" || raw.trim().length < 10 ||
      raw.trim().length > 500 || /[\x00-\x1f\x7f]/.test(raw))
    throw new AccessError(400, field + " must contain 10–500 printable characters.");
  return raw.trim();
}
function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AccessError)
    return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2002", "P2034"].includes(error.code))
    return reply.code(409).send({ error: "A concurrent staff security change occurred. Refresh and retry." });
  throw error;
}
function shape(entry: {
  id: string; siteId: string; targetUserId: string; requestedById: string;
  reviewedById: string | null; status: string; reason: string;
  reviewNote: string | null; createdAt: Date; reviewDeadlineAt: Date;
  reviewedAt: Date | null;
}) {
  return {
    id: entry.id, siteId: entry.siteId, targetUserId: entry.targetUserId,
    requestedById: entry.requestedById, reviewedById: entry.reviewedById,
    status: entry.status, reason: entry.reason, reviewNote: entry.reviewNote,
    createdAt: entry.createdAt.toISOString(),
    reviewDeadlineAt: entry.reviewDeadlineAt.toISOString(),
    reviewedAt: entry.reviewedAt?.toISOString() ?? null,
  };
}

// Recheck every site and both staff principals at decision-time; do not
// trust role or site scope from a request snapshot.
async function activeProtectedGrants(
  tx: Prisma.TransactionClient,
  targetId: string,
  selectedSiteId: string,
) {
  const target = await tx.user.findUnique({
    where: { id: targetId }, select: { active: true, oidcSubject: true },
  });
  if (!target?.active || !target.oidcSubject)
    throw new AccessError(409, "Protected account is unavailable.");
  const grants = await tx.siteRoleAssignment.findMany({
    where: { userId: targetId, active: true },
    select: { siteId: true, role: true },
  });
  if (!grants.some(g => g.siteId === selectedSiteId))
    throw new AccessError(404, "Protected staff member does not belong to this site.");
  if (!grants.some(g => highTrust.includes(g.role as typeof highTrust[number])))
    throw new AccessError(409, "Account does not currently hold protected authority.");
  return grants;
}

async function requireAllSites(
  tx: Prisma.TransactionClient,
  actorId: string,
  role: "ADMIN" | "PHARMACIST_IN_CHARGE",
  siteIds: string[],
) {
  const actor = await tx.user.findUnique({
    where: { id: actorId }, select: { active: true, oidcSubject: true },
  });
  if (!actor?.active || !actor.oidcSubject)
    throw new AccessError(403, "Authorization principal is no longer active.");
  const count = await tx.siteRoleAssignment.count({
    where: { userId: actorId, role, active: true, siteId: { in: siteIds } },
  });
  if (count !== siteIds.length)
    throw new AccessError(403, role + " authority is required at every affected pharmacy.");
}

export async function protectedOffboardingRoutes(app: FastifyInstance) {
  app.get("/protected-offboarding", async (request, reply) => {
    try {
      requireOidc();
      const auth = await authenticateSession(request, "user:manage");
      if (!["ADMIN", "PHARMACIST_IN_CHARGE"].includes(auth.actor.role))
        throw new AccessError(403, "Site leader permission required.");
      const entries = await db.protectedOffboardingRequest.findMany({
        where: { siteId: auth.actor.siteId },
        orderBy: { createdAt: "desc" }, take: 100,
      });
      return { requests: entries.map(shape) };
    } catch (error) { return fail(reply, error); }
  });

  app.post("/protected-offboarding", async (request, reply) => {
    try {
      requireOidc();
      const auth = await authenticateSession(request, "user:manage");
      if (auth.actor.role !== "ADMIN")
        throw new AccessError(403, "An administrator must initiate protected offboarding.");
      freshMfa(auth.mfaVerifiedAt);
      const body = request.body as { targetUserId?: unknown; reason?: unknown } | null;
      const targetId = validId(body?.targetUserId);
      const reason = note(body?.reason, "Offboarding reason");
      if (targetId === auth.actor.id)
        throw new AccessError(403, "Self-offboarding is not authorized.");
      const entry = await db.$transaction(async tx => {
        const grants = await activeProtectedGrants(tx, targetId, auth.actor.siteId);
        const siteIds = grants.map(g => g.siteId);
        await requireAllSites(tx, auth.actor.id, "ADMIN", siteIds);
        const existing = await tx.protectedOffboardingRequest.findFirst({
          where: { targetUserId: targetId, status: "PENDING",
            reviewDeadlineAt: { gt: new Date() } }, select: { id: true },
        });
        if (existing) throw new AccessError(409, "A protected offboarding request is already pending.");
        const created = await tx.protectedOffboardingRequest.create({
          data: { siteId: auth.actor.siteId, targetUserId: targetId,
            requestedById: auth.actor.id, reason,
            reviewDeadlineAt: new Date(Date.now() + REQUEST_LIFETIME_MS) },
        });
        await writeAuditEvent(tx, {
          siteId: auth.actor.siteId, actorId: auth.actor.id,
          action: "PROTECTED_OFFBOARD_REQUESTED",
          entityType: "ProtectedOffboardingRequest",
          entityId: created.id, requestId: request.id,
          metadata: { targetUserId: targetId, affectedSites: siteIds },
        });
        return created;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return reply.code(201).send({ request: shape(entry) });
    } catch (error) { return fail(reply, error); }
  });

  app.post("/protected-offboarding/:id/review", async (request, reply) => {
    try {
      requireOidc();
      const auth = await authenticateSession(request, "user:manage");
      if (auth.actor.role !== "PHARMACIST_IN_CHARGE")
        throw new AccessError(403, "An independent site PIC must review protected offboarding.");
      freshMfa(auth.mfaVerifiedAt);
      const id = validId((request.params as { id?: unknown }).id);
      const body = request.body as { decision?: unknown; note?: unknown } | null;
      if (body?.decision !== "APPROVED" && body?.decision !== "DENIED")
        throw new AccessError(400, "Decision must be APPROVED or DENIED.");
      const decision = body.decision;
      const reviewNote = note(body.note, "Independent reviewer note");
      const result = await db.$transaction(async tx => {
        const entry = await tx.protectedOffboardingRequest.findFirst({
          where: { id, siteId: auth.actor.siteId },
        });
        if (!entry) throw new AccessError(404, "Offboarding review not found at this site.");
        if (entry.status !== "PENDING" || entry.reviewDeadlineAt <= new Date())
          throw new AccessError(409, "Review expired or already decided.");
        if (entry.requestedById === auth.actor.id || entry.targetUserId === auth.actor.id)
          throw new AccessError(403, "Requester and beneficiary cannot review this action.");
        const grants = await activeProtectedGrants(tx, entry.targetUserId, entry.siteId);
        const siteIds = grants.map(g => g.siteId);
        await requireAllSites(tx, entry.requestedById, "ADMIN", siteIds);
        await requireAllSites(tx, auth.actor.id, "PHARMACIST_IN_CHARGE", siteIds);
        const now = new Date();
        if (decision === "APPROVED") {
          // Do not disable the last active administrative or PIC principal.
          // Serializable isolation protects against concurrent write skew when
          // two different protected users are offboarded simultaneously.
          for (const grant of grants) {
            if (grant.role !== "ADMIN" && grant.role !== "PHARMACIST_IN_CHARGE") continue;
            const leaders = await tx.siteRoleAssignment.count({
              where: {
                siteId: grant.siteId, role: grant.role, active: true,
                user: { active: true },
              },
            });
            if (leaders <= 1)
              throw new AccessError(409, "Cannot suspend the last active " +
                grant.role + " at pharmacy " + grant.siteId + ".");
          }
        }
        const claim = await tx.protectedOffboardingRequest.updateMany({
          where: { id: entry.id, status: "PENDING", reviewDeadlineAt: { gt: now } },
          data: { status: decision, reviewedAt: now, reviewedById: auth.actor.id,
            reviewNote },
        });
        if (claim.count !== 1) throw new AccessError(409, "Another reviewer already decided.");
        let revokedSessions = 0, disabledSites = 0, cancelledPrivileges = 0;
        if (decision === "APPROVED") {
          const suspended = await tx.user.updateMany({
            where: { id: entry.targetUserId, active: true }, data: { active: false },
          });
          if (suspended.count !== 1) throw new AccessError(409, "Account changed during review.");
          const sites = await tx.siteRoleAssignment.updateMany({
            where: { userId: entry.targetUserId, active: true },
            data: { active: false },
          });
          disabledSites = sites.count;
          const sessions = await tx.authSession.updateMany({
            where: { userId: entry.targetUserId, revokedAt: null },
            data: { revokedAt: now },
          });
          revokedSessions = sessions.count;
          const privileges = await tx.privilegedAccessRequest.updateMany({
            where: {
              AND: [
                { OR: [
                  { targetUserId: entry.targetUserId },
                  { requestedById: entry.targetUserId },
                  { reviewedById: entry.targetUserId },
                ] },
                { OR: [
                  { status: "PENDING" },
                  { status: "APPROVED", kind: "TEMP_PERMISSION" },
                ] },
              ],
            },
            data: { status: "CANCELLED", effectiveUntil: now },
          });
          cancelledPrivileges = privileges.count;
          await tx.protectedOffboardingRequest.updateMany({
            where: {
              id: { not: entry.id }, status: "PENDING",
              OR: [
                { targetUserId: entry.targetUserId },
                { requestedById: entry.targetUserId },
              ],
            },
            data: { status: "CANCELLED" },
          });
        }
        await writeAuditEvent(tx, {
          siteId: entry.siteId, actorId: auth.actor.id,
          action: decision === "APPROVED" ? "PROTECTED_OFFBOARD_APPROVED" : "PROTECTED_OFFBOARD_DENIED",
          entityType: "ProtectedOffboardingRequest", entityId: entry.id,
          requestId: request.id,
          metadata: {
            targetUserId: entry.targetUserId,
            requesterId: entry.requestedById, reviewerId: auth.actor.id,
            affectedSites: siteIds, disabledSites,
            revokedSessions, cancelledPrivileges,
          },
        });
        return {
          request: await tx.protectedOffboardingRequest.findUniqueOrThrow({ where: { id } }),
          revokedSessions, disabledSites, cancelledPrivileges,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return {
        request: shape(result.request), revokedSessions: result.revokedSessions,
        disabledSites: result.disabledSites, cancelledPrivileges: result.cancelledPrivileges,
      };
    } catch (error) { return fail(reply, error); }
  });

  app.post("/protected-offboarding/:id/cancel", async (request, reply) => {
    try {
      requireOidc();
      const auth = await authenticateSession(request, "user:manage");
      const id = validId((request.params as { id?: unknown }).id);
      const entry = await db.$transaction(async tx => {
        const existing = await tx.protectedOffboardingRequest.findFirst({
          where: { id, siteId: auth.actor.siteId },
        });
        if (!existing) throw new AccessError(404, "Offboarding request not found.");
        if (existing.requestedById !== auth.actor.id)
          throw new AccessError(403, "Only the requester can cancel before review.");
        const claimed = await tx.protectedOffboardingRequest.updateMany({
          where: { id, status: "PENDING" }, data: { status: "CANCELLED" },
        });
        if (claimed.count !== 1) throw new AccessError(409, "Request already decided.");
        await writeAuditEvent(tx, {
          siteId: existing.siteId, actorId: auth.actor.id,
          action: "PROTECTED_OFFBOARD_CANCELLED",
          entityType: "ProtectedOffboardingRequest",
          entityId: id, requestId: request.id,
          metadata: { targetUserId: existing.targetUserId },
        });
        return tx.protectedOffboardingRequest.findUniqueOrThrow({ where: { id } });
      });
      return { request: shape(entry) };
    } catch (error) { return fail(reply, error); }
  });
}
