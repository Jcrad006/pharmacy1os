import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { hashSecret } from "../src/security/sessions.js";

process.env.AUTH_MODE = "oidc";
process.env.ALLOW_DEV_IDENTITY = "true";
process.env.AUTH_SESSION_SECRET = "stage3m5-protected-workforce-tests-0123456789abcdef";
process.env.OIDC_ISSUER = "http://localhost:4999/realms/test";
process.env.OIDC_CLIENT_ID = "pharmacy1os-test";
process.env.OIDC_REDIRECT_URI = "http://localhost:3001/api/auth/callback";
process.env.WEB_ORIGIN = "http://localhost:5173";
const app = buildApp();
const a = "site-demo-001";
const b = "site-demo-002";
const admin = "3m5-admin-" + randomUUID();
const pic = "3m5-pic-" + randomUUID();
const target = "3m5-target-" + randomUUID();
const outside = "3m5-outside-" + randomUUID();
const users = [admin, pic, target, outside];
const tokens = new Map<string, string>();
const csrf = new Map<string, string>();
let secondSiteSession: string;
const now = () => new Date();

async function identity(id: string, siteId: string, role: "ADMIN" | "PHARMACIST_IN_CHARGE" | "PHARMACIST") {
  await db.user.create({
    data: { id, displayName: "3M5 " + role, active: true,
      oidcSubject: id, role, siteId },
  });
  await grant(id, siteId, role);
  const token = randomBytes(32).toString("hex");
  tokens.set(id, token);
  await session(id, siteId, token);
}
async function grant(id: string, siteId: string, role: "ADMIN" | "PHARMACIST_IN_CHARGE" | "PHARMACIST") {
  await db.siteRoleAssignment.create({ data: { userId: id, siteId, role } });
}
async function session(userId: string, siteId: string, token: string) {
  await db.authSession.create({
    data: { userId, siteId, sessionHash: hashSecret(token),
      mfaVerifiedAt: now(), expiresAt: new Date(Date.now() + 8 * 3600000),
      idleExpiresAt: new Date(Date.now() + 15 * 60000) },
  });
}
function api(actor: string, method: "GET" | "POST", path: string, payload?: unknown) {
  return app.inject({
    method, url: path,
    headers: {
      cookie: "pharmacy1os_session=" + tokens.get(actor),
      ...(method === "POST" ? { "content-type": "application/json", "x-csrf-token": csrf.get(actor)! } : {}),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}
const review = (decision: "APPROVED" | "DENIED") => ({
  decision, note: "Independently reviewed synthetic protected offboarding evidence",
});
const reason = "Approved documented departure of a synthetic protected employee";

beforeAll(async () => {
  await app.ready();
  await identity(admin, a, "ADMIN");
  await identity(pic, a, "PHARMACIST_IN_CHARGE");
  await identity(target, a, "ADMIN");
  await identity(outside, b, "PHARMACIST");
  await grant(admin, b, "ADMIN");
  await grant(pic, b, "PHARMACIST_IN_CHARGE");
  await grant(target, b, "PHARMACIST_IN_CHARGE");
  secondSiteSession = randomBytes(32).toString("hex");
  await session(target, b, secondSiteSession);
  for (const id of users) {
    const me = await api(id, "GET", "/api/auth/me");
    expect(me.statusCode).toBe(200);
    csrf.set(id, me.json().csrfToken);
  }
});
afterAll(async () => {
  await db.privilegedAccessRequest.deleteMany({
    where: { OR: [
      { targetUserId: { in: users } },
      { requestedById: { in: users } },
      { reviewedById: { in: users } },
    ] },
  });
  await db.protectedOffboardingRequest.deleteMany({
    where: { OR: [{ targetUserId: { in: users } }, { requestedById: { in: users } }] },
  });
  await db.auditEvent.deleteMany({ where: { actorId: { in: users } } });
  await db.authSession.deleteMany({ where: { userId: { in: users } } });
  await db.siteRoleAssignment.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await app.close();
  await db.$disconnect();
});

describe("Stage 3M.5 protected organization-wide offboarding", () => {
  it("rejects unauthenticated and self-offboarding requests", async () => {
    const anonymous = await app.inject({ method: "POST", url: "/api/protected-offboarding",
      headers: { "x-dev-user": "dev-admin", "content-type": "application/json" },
      payload: JSON.stringify({ targetUserId: target, reason }),
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await api(admin, "POST", "/api/protected-offboarding", {
      targetUserId: admin, reason,
    })).statusCode).toBe(403);
    expect((await api(pic, "POST", "/api/protected-offboarding", {
      targetUserId: target, reason,
    })).statusCode).toBe(403);
    expect((await api(admin, "POST", "/api/protected-offboarding", {
      targetUserId: outside, reason,
    })).statusCode).toBe(404);
  });

  it("enforces administrator grants at all sites and recent MFA", async () => {
    await db.siteRoleAssignment.update({
      where: { userId_siteId: { userId: admin, siteId: b } },
      data: { active: false },
    });
    expect((await api(admin, "POST", "/api/protected-offboarding", {
      targetUserId: target, reason,
    })).statusCode).toBe(403);
    await db.siteRoleAssignment.update({
      where: { userId_siteId: { userId: admin, siteId: b } },
      data: { active: true },
    });
    const s = await db.authSession.findUniqueOrThrow({
      where: { sessionHash: hashSecret(tokens.get(admin)!) },
    });
    await db.authSession.update({
      where: { id: s.id }, data: { mfaVerifiedAt: new Date(Date.now() - 8 * 60000) },
    });
    expect((await api(admin, "POST", "/api/protected-offboarding", {
      targetUserId: target, reason,
    })).statusCode).toBe(403);
    await db.authSession.update({
      where: { id: s.id }, data: { mfaVerifiedAt: now() },
    });
  });

  it("requires independent reviewer, permits denial, prevents duplicate/replay", async () => {
    const created = await api(admin, "POST", "/api/protected-offboarding", {
      targetUserId: target, reason,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().request.id as string;
    expect((await api(admin, "POST", "/api/protected-offboarding", {
      targetUserId: target, reason,
    })).statusCode).toBe(409);
    expect((await api(admin, "POST", "/api/protected-offboarding/" + id + "/review",
      review("APPROVED"))).statusCode).toBe(403);
    expect((await api(outside, "POST", "/api/protected-offboarding/" + id + "/review",
      review("APPROVED"))).statusCode).toBe(403);
    const denied = await api(pic, "POST", "/api/protected-offboarding/" + id + "/review",
      review("DENIED"));
    expect(denied.statusCode).toBe(200);
    expect(denied.json().request.status).toBe("DENIED");
    expect((await db.user.findUniqueOrThrow({ where: { id: target } })).active).toBe(true);
    expect((await api(pic, "POST", "/api/protected-offboarding/" + id + "/review",
      review("APPROVED"))).statusCode).toBe(409);
  });

  it("cancels a pending request, and rejects a stale approval deadline", async () => {
    const request1 = await api(admin, "POST", "/api/protected-offboarding", {
      targetUserId: target, reason,
    });
    expect(request1.statusCode).toBe(201);
    const id1 = request1.json().request.id;
    expect((await api(pic, "POST", "/api/protected-offboarding/" + id1 + "/cancel",
      {})).statusCode).toBe(403);
    expect((await api(admin, "POST", "/api/protected-offboarding/" + id1 + "/cancel",
      {})).statusCode).toBe(200);
    const request2 = await api(admin, "POST", "/api/protected-offboarding", {
      targetUserId: target, reason,
    });
    expect(request2.statusCode).toBe(201);
    const id2 = request2.json().request.id as string;
    const row = await db.protectedOffboardingRequest.findUniqueOrThrow({ where: { id: id2 } });
    await db.protectedOffboardingRequest.update({
      where: { id: id2 },
      data: { reviewDeadlineAt: new Date(row.createdAt.getTime() + 1) },
    });
    expect((await api(pic, "POST", "/api/protected-offboarding/" + id2 + "/review",
      review("APPROVED"))).statusCode).toBe(409);
    expect((await db.user.findUniqueOrThrow({ where: { id: target } })).active).toBe(true);
  });

  it("requires reviewer authority at every site; approval atomically revokes all target access", async () => {
    const created = await api(admin, "POST", "/api/protected-offboarding", {
      targetUserId: target, reason,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().request.id as string;
    await db.siteRoleAssignment.update({
      where: { userId_siteId: { userId: pic, siteId: b } },
      data: { active: false },
    });
    expect((await api(pic, "POST", "/api/protected-offboarding/" + id + "/review",
      review("APPROVED"))).statusCode).toBe(403);
    await db.siteRoleAssignment.update({
      where: { userId_siteId: { userId: pic, siteId: b } },
      data: { active: true },
    });
    // The departing principal may have been a previous reviewer for an
    // outstanding elevation; cancellation must prevent trust from surviving.
    const elevated = await db.privilegedAccessRequest.create({
      data: {
        siteId: b, targetUserId: outside, requestedById: outside,
        reviewedById: target, kind: "TEMP_PERMISSION", status: "APPROVED",
        requestedPermission: "inventory:correct",
        reason: "Legacy synthetic permission approved before departure",
        reviewNote: "Temporary grant subject to approver departure",
        reviewedAt: now(), reviewDeadlineAt: new Date(Date.now() + 5 * 60000),
        effectiveUntil: new Date(Date.now() + 10 * 60000),
      },
    });
    const approved = await api(pic, "POST", "/api/protected-offboarding/" + id + "/review",
      review("APPROVED"));
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      request: { status: "APPROVED" }, revokedSessions: 2, disabledSites: 2,
      cancelledPrivileges: 1,
    });
    expect((await db.privilegedAccessRequest.findUniqueOrThrow({ where: { id: elevated.id } })).status)
      .toBe("CANCELLED");
    const user = await db.user.findUniqueOrThrow({ where: { id: target } });
    expect(user.active).toBe(false);
    expect((await db.siteRoleAssignment.findMany({ where: { userId: target } }))
      .every(g => !g.active)).toBe(true);
    expect((await api(target, "GET", "/api/auth/me")).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me",
      headers: { cookie: "pharmacy1os_session=" + secondSiteSession } })).statusCode).toBe(401);
    expect((await api(pic, "POST", "/api/protected-offboarding/" + id + "/review",
      review("APPROVED"))).statusCode).toBe(409);
    const audit = await db.auditEvent.findFirst({
      where: { action: "PROTECTED_OFFBOARD_APPROVED", entityId: id, actorId: pic },
    });
    expect(audit).toBeTruthy();
  });
});
