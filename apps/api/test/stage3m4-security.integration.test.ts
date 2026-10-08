import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { hashSecret } from "../src/security/sessions.js";
import { checkAuthLoginThrottle, networkFingerprint } from "../src/security/securityMonitoring.js";
import type { FastifyRequest } from "fastify";

process.env.AUTH_MODE = "oidc";
process.env.ALLOW_DEV_IDENTITY = "true";
process.env.AUTH_SESSION_SECRET = "stage-3m4-unit-tests-0123456789abcdef0123456789abcdef";
process.env.OIDC_ISSUER = "http://localhost:4999/realms/test";
process.env.OIDC_CLIENT_ID = "pharmacy1os-test";
process.env.OIDC_REDIRECT_URI = "http://localhost:3001/api/auth/callback";
process.env.WEB_ORIGIN = "http://localhost:5173";

const app = buildApp();
const site1 = "site-demo-001";
const site2 = "site-demo-002";
const adminId = "3m4-admin-" + randomUUID();
const picId = "3m4-pic-" + randomUUID();
const techId = "3m4-tech-" + randomUUID();
const outsiderId = "3m4-outside-" + randomUUID();
const subjects = [
  { id: adminId, siteId: site1, role: "ADMIN" },
  { id: picId, siteId: site1, role: "PHARMACIST_IN_CHARGE" },
  { id: techId, siteId: site1, role: "TECHNICIAN" },
  { id: outsiderId, siteId: site2, role: "PHARMACIST_IN_CHARGE" },
] as const;
const ids = subjects.map(s => s.id);
const cookies = new Map<string,string>();
const csrf = new Map<string,string>();
let otherSiteToken = "";

async function addSession(userId: string, siteId: string) {
  const token = randomBytes(32).toString("hex");
  const row = await db.authSession.create({
    data: { userId, siteId, sessionHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 8 * 3_600_000),
      idleExpiresAt: new Date(Date.now() + 15 * 60_000),
      mfaVerifiedAt: new Date() },
  });
  return { token, id: row.id };
}
function api(user: string, method: "GET" | "POST", path: string, data?: unknown) {
  return app.inject({
    method, url: path,
    headers: { cookie: cookies.get(user)!,
      ...(method === "POST" ? { "x-csrf-token": csrf.get(user)!,
        "content-type": "application/json" } : {}) },
    ...(data === undefined ? {} : { payload: JSON.stringify(data) }),
  });
}

beforeAll(async () => {
  await app.ready();
  for (const person of subjects) {
    await db.user.create({
      data: { id: person.id, siteId: person.siteId, role: person.role,
        displayName: "Synthetic " + person.role,
        active: true, oidcSubject: person.id },
    });
    await db.siteRoleAssignment.create({
      data: { userId: person.id, siteId: person.siteId, role: person.role },
    });
    const session = await addSession(person.id, person.siteId);
    cookies.set(person.id, "pharmacy1os_session=" + session.token);
  }
  await db.siteRoleAssignment.create({
    data: { userId: techId, siteId: site2, role: "CASHIER" },
  });
  otherSiteToken = (await addSession(techId, site2)).token;
  for (const { id } of subjects) {
    const me = await api(id, "GET", "/api/auth/me");
    expect(me.statusCode).toBe(200);
    csrf.set(id, me.json().csrfToken);
  }
});
afterAll(async () => {
  await db.staffCredentialReview.deleteMany({ where: { targetUserId: { in: ids } } });
  await db.privilegedAccessRequest.deleteMany({
    where: { OR: [{ targetUserId: { in: ids } }, { requestedById: { in: ids } }] },
  });
  await db.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
  await db.authSession.deleteMany({ where: { userId: { in: ids } } });
  await db.siteRoleAssignment.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await app.close();
  await db.$disconnect();
});

describe("Stage 3M.4 independent test-only credential review", () => {
  let reviewId = "";

  it("requires the administrator to submit site-specific non-authoritative evidence", async () => {
    const payload = {
      targetUserId: techId, role: "PHARMACIST",
      authority: "Synthetic licensing reference",
      evidenceReference: "SYNTHETIC-EVIDENCE-123",
      rationale: "Review recorded for test-only demonstration",
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    };
    expect((await api(techId, "POST", "/api/credentials/reviews", payload)).statusCode).toBe(403);
    expect((await api(adminId, "POST", "/api/credentials/reviews", {
      ...payload, targetUserId: outsiderId,
    })).statusCode).toBe(404);
    const created = await api(adminId, "POST", "/api/credentials/reviews", payload);
    expect(created.statusCode).toBe(201);
    reviewId = created.json().review.id;
    expect(created.json().review.status).toBe("PENDING");
    expect(JSON.stringify(created.json())).not.toContain("SYNTHETIC-EVIDENCE-123");
    const listed = await api(adminId, "GET", "/api/credentials/reviews");
    expect(listed.statusCode).toBe(200);
    expect(listed.json().automaticAuthorityVerification).toBe(false);
  });

  it("rejects self-approval, the requester as reviewer and cross-site review", async () => {
    const data = { decision: "TEST_ATTESTED",
      note: "Reviewed synthetic evidence without contacting a real authority" };
    expect((await api(adminId, "POST", "/api/credentials/reviews/" + reviewId + "/decision", data)).statusCode).toBe(403);
    expect((await api(outsiderId, "POST", "/api/credentials/reviews/" + reviewId + "/decision", data)).statusCode).toBe(404);
    const attested = await api(picId, "POST", "/api/credentials/reviews/" + reviewId + "/decision", data);
    expect(attested.statusCode).toBe(200);
    expect(attested.json().review.status).toBe("TEST_ATTESTED");
    expect((await api(picId, "POST", "/api/credentials/reviews/" + reviewId + "/decision", data)).statusCode).toBe(409);
    const persisted = await db.staffCredentialReview.findUniqueOrThrow({ where: { id: reviewId } });
    expect(persisted.submittedById).toBe(adminId);
    expect(persisted.reviewedById).toBe(picId);
  });
});

describe("Stage 3M.4 cross-site workforce suspension", () => {
  it("blocks self, ordinary staff, cross-site, and high-trust offboarding", async () => {
    const payload = { reason: "Synthetic full organization offboarding request" };
    expect((await api(adminId, "POST", "/api/staff/" + adminId + "/global-suspend", payload)).statusCode).toBe(403);
    expect((await api(picId, "POST", "/api/staff/" + techId + "/global-suspend", payload)).statusCode).toBe(403);
    expect((await api(adminId, "POST", "/api/staff/" + picId + "/global-suspend", payload)).statusCode).toBe(403);
    expect((await api(adminId, "POST", "/api/staff/" + outsiderId + "/global-suspend", payload)).statusCode).toBe(404);
  });

  it("globally suspends ordinary staff, revokes every site's sessions and permissions, and audits", async () => {
    const notOrgAdmin = await api(adminId, "POST", "/api/staff/" + techId + "/global-suspend", {
      reason: "Cannot revoke access at sites where admin has no role",
    });
    expect(notOrgAdmin.statusCode).toBe(403);
    await db.siteRoleAssignment.create({
      data: { userId: adminId, siteId: site2, role: "ADMIN" },
    });
    await db.privilegedAccessRequest.create({
      data: {
        siteId: site1, targetUserId: techId, requestedById: techId, reviewedById: picId,
        kind: "TEMP_PERMISSION", status: "APPROVED",
        requestedPermission: "inventory:correct",
        reason: "Synthetic stock change request",
        reviewNote: "Approved by independent demo leader",
        reviewedAt: new Date(), reviewDeadlineAt: new Date(Date.now() + 10 * 60_000),
        effectiveUntil: new Date(Date.now() + 15 * 60_000),
      },
    });
    const response = await api(adminId, "POST", "/api/staff/" + techId + "/global-suspend", {
      reason: "Synthetic employee departed all affiliated pharmacies",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      globallySuspended: true, affectedSites: 2,
      revokedSessions: 2, cancelledPrivileges: 1,
    });
    const user = await db.user.findUniqueOrThrow({ where: { id: techId } });
    expect(user.active).toBe(false);
    const grants = await db.siteRoleAssignment.findMany({ where: { userId: techId } });
    expect(grants.every(g => g.active === false)).toBe(true);
    expect((await api(techId, "GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me",
      headers: { cookie: "pharmacy1os_session=" + otherSiteToken } })).statusCode).toBe(401);
    const approval = await db.privilegedAccessRequest.findFirstOrThrow({
      where: { targetUserId: techId, kind: "TEMP_PERMISSION" },
    });
    expect(approval.status).toBe("CANCELLED");
    expect((await api(adminId, "POST", "/api/staff/" + techId + "/global-suspend", {
      reason: "Cannot repeat a completed suspension action",
    })).statusCode).toBe(404);
    const history = await db.auditEvent.findFirst({
      where: { actorId: adminId, action: "STAFF_GLOBAL_SUSPENSION", entityId: techId },
    });
    expect(history).toBeTruthy();
  });
});

describe("Stage 3M.4 security denial monitoring", () => {
  it("records site-scoped denials and does not disclose network fingerprints", async () => {
    const denied = await app.inject({ method: "GET", url: "/api/staff",
      headers: { cookie: cookies.get(picId)! } });
    expect(denied.statusCode).toBe(200);
    const crossSite = await api(outsiderId, "GET", "/api/staff");
    expect(crossSite.statusCode).toBe(200); // PIC may manage their own site.
    const forbidden = await api(picId, "POST", "/api/staff/" + adminId + "/global-suspend", {
      reason: "Unauthorized privileged staff suspension attempt",
    });
    expect(forbidden.statusCode).toBe(403);
    const admin = await api(adminId, "GET", "/api/security/events");
    expect(admin.statusCode).toBe(200);
    expect(admin.json().siteFailures).toBeGreaterThanOrEqual(1);
    expect(admin.json().events.some((e: { kind: string }) => e.kind === "ACCESS_DENIED")).toBe(true);
    expect(JSON.stringify(admin.json())).not.toContain("networkHash");
    expect((await api(picId, "GET", "/api/security/events")).statusCode).toBe(403);
  });
});


describe("Stage 3M.4 test-OIDC abuse monitoring", () => {
  it("counts only pseudonymized peer fingerprints and blocks excess login starts", async () => {
    const remote = "192.0.2." + (Math.floor(Math.random() * 200) + 1);
    const fake = { ip: remote } as FastifyRequest;
    const fingerprint = networkFingerprint(fake);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain(remote);
    try {
      for (let i = 0; i < 10; i++) await checkAuthLoginThrottle(fake);
      await expect(checkAuthLoginThrottle(fake))
        .rejects.toMatchObject({ statusCode: 429 });
      const records = await db.securityEvent.findMany({
        where: { networkHash: fingerprint, kind: "AUTH_LOGIN_STARTED" },
      });
      expect(records).toHaveLength(10);
      expect(JSON.stringify(records)).not.toContain(remote);
    } finally {
      await db.securityEvent.deleteMany({
        where: { networkHash: fingerprint, kind: "AUTH_LOGIN_STARTED" },
      });
    }
  });
});
