import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError } from "../security/devIdentity.js";
import { authenticateSession } from "../security/sessions.js";

const MFA_FRESH_MS = 5 * 60_000;
const MAX_REVIEW_DAYS = 90; // Test-only, NEVER a board-defined validity duration.

function oidcOnly() {
  if (process.env.AUTH_MODE !== "oidc" || process.env.NODE_ENV === "production")
    throw new AccessError(404, "Not found.");
}

function identifier(raw: unknown) {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 128)
    throw new AccessError(400, "Invalid staff or review identifier.");
  return raw;
}
function validateText(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== "string" || value.trim().length < min ||
      value.trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new AccessError(400, label + " must contain " + min + "–" + max + " characters.");
  return value.trim();
}
function freshMfa(date: Date, now = new Date()) {
  const delta = now.getTime() - date.getTime();
  if (delta < -60_000 || delta > MFA_FRESH_MS)
    throw new AccessError(403, "A recent multifactor sign-in is required.");
}
function respondError(reply: FastifyReply, error: unknown) {
  if (error instanceof AccessError) return reply.code(error.statusCode).send({ error: error.message });
  if (error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2002", "P2034"].includes(error.code))
    return reply.code(409).send({ error: "Concurrent change; refresh and retry." });
  throw error;
}
function publicReview(entry: {
  id: string; targetUserId: string; submittedById: string;
  reviewedById: string | null; role: string; status: string;
  authority: string; evidenceReference: string; rationale: string;
  reviewNote: string | null; expiresAt: Date; createdAt: Date; reviewedAt: Date | null;
}) {
  return {
    id: entry.id, targetUserId: entry.targetUserId,
    submittedById: entry.submittedById, reviewedById: entry.reviewedById,
    role: entry.role, status: entry.status,
    // Do not expose the source reference to other staff; it is an audit aid.
    authority: entry.authority, rationale: entry.rationale,
    reviewNote: entry.reviewNote, expiresAt: entry.expiresAt.toISOString(),
    createdAt: entry.createdAt.toISOString(),
    reviewedAt: entry.reviewedAt?.toISOString() ?? null,
  };
}

export async function workforceSecurityRoutes(app: FastifyInstance) {
  app.post("/staff/:id/global-suspend", async (request, reply) => {
    try {
      oidcOnly();
      const auth = await authenticateSession(request, "user:manage");
      if (auth.actor.role !== "ADMIN")
        throw new AccessError(403, "Only an organization administrator can initiate global suspension.");
      freshMfa(auth.mfaVerifiedAt);
      const userId = identifier((request.params as { id?: unknown }).id);
      if (userId === auth.actor.id)
        throw new AccessError(403, "Administrators cannot globally suspend themselves.");
      const input = request.body as { reason?: unknown } | null;
      const reason = validateText(input?.reason, "Offboarding reason", 10, 500);
      const result = await db.$transaction(async tx => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user?.active) throw new AccessError(404, "No active staff account.");
        const grants = await tx.siteRoleAssignment.findMany({ where: { userId } });
        if (!grants.some(g => g.siteId === auth.actor.siteId && g.active))
          throw new AccessError(404, "Staff member not found at this pharmacy.");
        if (grants.some(g =>
          ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE"].includes(g.role))) {
          throw new AccessError(403, "Protected professional/leader accounts require independent offboarding review.");
        }
        // A site administrator may not revoke an employee's *other* sites
        // unless independently granted administrator authority at every site.
        const targetSites = [...new Set(grants.filter(g => g.active).map(g => g.siteId))];
        const authorizedSites = await tx.siteRoleAssignment.count({
          where: {
            userId: auth.actor.id, siteId: { in: targetSites },
            active: true, role: "ADMIN",
          },
        });
        if (authorizedSites !== targetSites.length)
          throw new AccessError(403, "Global offboarding requires administrative authorization at every affected site.");
        const updated = await tx.user.updateMany({
          where: { id: userId, active: true },
          data: { active: false },
        });
        if (updated.count !== 1) throw new AccessError(409, "Staff account changed concurrently.");
        const siteGrants = await tx.siteRoleAssignment.updateMany({
          where: { userId, active: true },
          data: { active: false },
        });
        const sessions = await tx.authSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        const approvals = await tx.privilegedAccessRequest.updateMany({
          where: {
            targetUserId: userId,
            OR: [
              { status: "PENDING" },
              { status: "APPROVED", kind: "TEMP_PERMISSION" },
            ],
          },
          data: { status: "CANCELLED", effectiveUntil: new Date() },
        });
        await writeAuditEvent(tx, {
          siteId: auth.actor.siteId, actorId: auth.actor.id,
          action: "STAFF_GLOBAL_SUSPENSION", entityType: "User",
          entityId: userId, requestId: request.id,
          metadata: {
            reason, affectedSites: siteGrants.count,
            revokedSessions: sessions.count,
            cancelledPrivileges: approvals.count,
          },
        });
        return {
          globallySuspended: true, affectedSites: siteGrants.count,
          revokedSessions: sessions.count, cancelledPrivileges: approvals.count,
        };
      });
      return result;
    } catch (error) { return respondError(reply, error); }
  });

  app.get("/credentials/reviews", async (request, reply) => {
    try {
      oidcOnly();
      const auth = await authenticateSession(request, "user:manage");
      const entries = await db.staffCredentialReview.findMany({
        where: { siteId: auth.actor.siteId },
        orderBy: { createdAt: "desc" }, take: 100,
      });
      return { reviews: entries.map(publicReview), automaticAuthorityVerification: false };
    } catch (error) { return respondError(reply, error); }
  });

  app.post("/credentials/reviews", async (request, reply) => {
    try {
      oidcOnly();
      const auth = await authenticateSession(request, "user:manage");
      if (auth.actor.role !== "ADMIN")
        throw new AccessError(403, "Credential review submission requires an administrator.");
      freshMfa(auth.mfaVerifiedAt);
      const input = request.body as {
        targetUserId?: unknown; role?: unknown; authority?: unknown;
        evidenceReference?: unknown; rationale?: unknown; expiresAt?: unknown;
      } | null;
      const targetUserId = identifier(input?.targetUserId);
      if (targetUserId === auth.actor.id)
        throw new AccessError(403, "Self-attestation is prohibited.");
      if (input?.role !== "PHARMACIST" && input?.role !== "PHARMACIST_IN_CHARGE")
        throw new AccessError(403, "Only test pharmacist credential attestations are supported.");
      const role = input.role;
      const authority = validateText(input.authority, "Source authority", 5, 160);
      const evidenceReference = validateText(input.evidenceReference, "Evidence reference", 5, 240);
      const rationale = validateText(input.rationale, "Review rationale", 10, 500);
      if (typeof input.expiresAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(input.expiresAt))
        throw new AccessError(400, "Explicit test attestation expiration is required.");
      const expiresAt = new Date(input.expiresAt);
      const now = new Date();
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now ||
          expiresAt.getTime() > now.getTime() + MAX_REVIEW_DAYS * 86_400_000)
        throw new AccessError(400, "Test review expiration must fall within 90 days.");
      const entry = await db.$transaction(async tx => {
        const user = await tx.user.findUnique({ where: { id: targetUserId } });
        const grant = await tx.siteRoleAssignment.findUnique({
          where: { userId_siteId: { userId: targetUserId, siteId: auth.actor.siteId } },
        });
        if (!user?.active || !user.oidcSubject || !grant?.active)
          throw new AccessError(404, "No active, provisioned staff at this site.");
        const alreadyPending = await tx.staffCredentialReview.findFirst({
          where: { siteId: auth.actor.siteId, targetUserId, role, status: "PENDING" },
          select: { id: true },
        });
        if (alreadyPending) throw new AccessError(409, "A review is already pending.");
        const created = await tx.staffCredentialReview.create({
          data: {
            siteId: auth.actor.siteId, targetUserId, submittedById: auth.actor.id,
            role, authority, evidenceReference, rationale, expiresAt,
          },
        });
        await writeAuditEvent(tx, {
          siteId: auth.actor.siteId, actorId: auth.actor.id,
          action: "TEST_CREDENTIAL_REVIEW_SUBMITTED",
          entityType: "StaffCredentialReview", entityId: created.id,
          requestId: request.id,
          metadata: { targetUserId, role, authority, expiresAt: expiresAt.toISOString() },
        });
        return created;
      });
      return reply.code(201).send({ review: publicReview(entry) });
    } catch (error) { return respondError(reply, error); }
  });

  app.post("/credentials/reviews/:id/decision", async (request, reply) => {
    try {
      oidcOnly();
      const auth = await authenticateSession(request, "user:manage");
      if (auth.actor.role !== "PHARMACIST_IN_CHARGE")
        throw new AccessError(403, "Only a designated test-site PIC can review credential evidence.");
      freshMfa(auth.mfaVerifiedAt);
      const id = identifier((request.params as { id?: unknown }).id);
      const input = request.body as { decision?: unknown; note?: unknown } | null;
      if (input?.decision !== "TEST_ATTESTED" && input?.decision !== "REJECTED")
        throw new AccessError(400, "Decision must be TEST_ATTESTED or REJECTED.");
      const decision = input.decision;
      const note = validateText(input.note, "Review note", 10, 500);
      const result = await db.$transaction(async tx => {
        const entry = await tx.staffCredentialReview.findFirst({
          where: { id, siteId: auth.actor.siteId },
        });
        if (!entry) throw new AccessError(404, "Credential review not found at this site.");
        if (entry.status !== "PENDING" || entry.expiresAt <= new Date())
          throw new AccessError(409, "Credential review is closed or expired.");
        if (entry.submittedById === auth.actor.id || entry.targetUserId === auth.actor.id)
          throw new AccessError(403, "Submission and review must involve independent identities.");
        const user = await tx.user.findUnique({ where: { id: entry.targetUserId } });
        const grant = await tx.siteRoleAssignment.findUnique({
          where: { userId_siteId: { userId: entry.targetUserId, siteId: entry.siteId } },
        });
        if (!user?.active || !grant?.active)
          throw new AccessError(409, "Target account is no longer active.");
        const changed = await tx.staffCredentialReview.updateMany({
          where: { id: entry.id, status: "PENDING", expiresAt: { gt: new Date() } },
          data: {
            status: decision, reviewedAt: new Date(),
            reviewedById: auth.actor.id, reviewNote: note,
          },
        });
        if (changed.count !== 1)
          throw new AccessError(409, "Credential review already decided.");
        await writeAuditEvent(tx, {
          siteId: entry.siteId, actorId: auth.actor.id,
          action: "TEST_CREDENTIAL_" + decision,
          entityType: "StaffCredentialReview", entityId: id,
          requestId: request.id,
          metadata: { targetUserId: entry.targetUserId, role: entry.role },
        });
        return tx.staffCredentialReview.findUniqueOrThrow({ where: { id } });
      });
      return { review: publicReview(result) };
    } catch (error) { return respondError(reply, error); }
  });
}
