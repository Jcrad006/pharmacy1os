import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { hashSecret } from "../src/security/sessions.js";

process.env.AUTH_MODE = "oidc";
process.env.ALLOW_DEV_IDENTITY = "true"; // Synthetic user selectors must be ignored.
process.env.AUTH_SESSION_SECRET = "stage-3m2-test-auth-secret-0123456789abcdefghijkl";
process.env.OIDC_ISSUER = "http://localhost:4999/realms/test";
process.env.OIDC_CLIENT_ID = "pharmacy1os-test";
process.env.OIDC_REDIRECT_URI = "http://localhost:3001/api/auth/callback";
process.env.WEB_ORIGIN = "http://localhost:5173";

const app = buildApp();
const site1 = "site-demo-001";
const site2 = "site-demo-002";
const adminId = "admin-3m2-" + randomUUID();
const techId = "tech-3m2-" + randomUUID();
const picId = "pic-3m2-" + randomUUID();
const outsideId = "outside-3m2-" + randomUUID();
const createdIds: string[] = [];
const knownIds = [adminId, techId, picId, outsideId];
const adminToken = randomBytes(32).toString("hex");
const techToken = randomBytes(32).toString("hex");
const adminCookie = { cookie: "pharmacy1os_session=" + adminToken };
const techCookie = { cookie: "pharmacy1os_session=" + techToken };
let csrf = "";

async function makeSession(userId: string, siteId: string, token: string) {
  await db.authSession.create({
    data: {
      userId, siteId, sessionHash: hashSecret(token),
      mfaVerifiedAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 15 * 60_000),
      expiresAt: new Date(Date.now() + 8 * 3_600_000),
    },
  });
}

function request(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  return app.inject({
    method, url,
    headers: {
      ...adminCookie,
      ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-csrf-token": csrf } : {}),
    },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

beforeAll(async () => {
  await app.ready();
  for (const [id, siteId, role] of [
    [adminId, site1, "ADMIN"],
    [techId, site1, "TECHNICIAN"],
    [picId, site1, "PHARMACIST_IN_CHARGE"],
    [outsideId, site2, "TECHNICIAN"],
  ] as const) {
    await db.user.create({
      data: { id, siteId, role, displayName: "Stage3M2 " + role,
        oidcSubject: id, active: true },
    });
    await db.siteRoleAssignment.create({ data: { userId: id, siteId, role } });
  }
  await makeSession(adminId, site1, adminToken);
  await makeSession(techId, site1, techToken);
  csrf = (await app.inject({
    method: "GET", url: "/api/auth/me", headers: adminCookie,
  })).json().csrfToken;
});

afterAll(async () => {
  const ids = [...knownIds, ...createdIds];
  await db.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
  await db.authSession.deleteMany({ where: { userId: { in: ids } } });
  await db.siteRoleAssignment.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await app.close();
  await db.$disconnect();
});

describe("Stage 3M.2 site staff access lifecycle", () => {
  it("requires an MFA-backed staff-manager session, not x-dev-user or a technician", async () => {
    const anonymous = await app.inject({
      method: "GET", url: "/api/staff", headers: { "x-dev-user": "dev-admin" },
    });
    expect(anonymous.statusCode).toBe(401);
    const tech = await app.inject({
      method: "GET", url: "/api/staff", headers: techCookie,
    });
    expect(tech.statusCode).toBe(403);
    const manager = await request("GET", "/api/staff");
    expect(manager.statusCode).toBe(200);
  });

  it("sees only site staff and never returns raw OIDC subjects", async () => {
    const response = await request("GET", "/api/staff");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.staff.some((item: { id: string }) => item.id === adminId)).toBe(true);
    expect(body.staff.some((item: { id: string }) => item.id === outsideId)).toBe(false);
    expect(JSON.stringify(body)).not.toContain(outsideId);
    expect(JSON.stringify(body)).not.toContain("oidcSubject");
  });

  it("provisions a routine role, blocks privileged escalation and duplicate identity", async () => {
    const subject = "stage-3m2-" + randomUUID();
    const input = { displayName: "Synthetic Casey", oidcSubject: subject, role: "TECHNICIAN" };
    const created = await request("POST", "/api/staff", input);
    expect(created.statusCode).toBe(201);
    const member = created.json().staff as { id: string; role: string; active: boolean };
    expect(member).toMatchObject({ role: "TECHNICIAN", active: true });
    createdIds.push(member.id);
    const grant = await db.siteRoleAssignment.findUniqueOrThrow({
      where: { userId_siteId: { userId: member.id, siteId: site1 } },
    });
    expect(grant.role).toBe("TECHNICIAN");
    expect((await request("POST", "/api/staff", input)).statusCode).toBe(409);
    for (const highTrust of ["ADMIN", "PHARMACIST", "PHARMACIST_IN_CHARGE"]) {
      const attempt = await request("POST", "/api/staff", {
        displayName: "Danger", oidcSubject: "bad-" + randomUUID(), role: highTrust,
      });
      expect(attempt.statusCode).toBe(403);
    }
  });

  it("disallows self-role changes, cross-site edits, and PIC role assignment changes", async () => {
    const listing = (await request("GET", "/api/staff")).json();
    const admin = listing.staff.find((item: { id: string }) => item.id === adminId);
    expect((await request("PATCH", "/api/staff/" + adminId + "/role", {
      role: "CASHIER", expectedUpdatedAt: admin.updatedAt,
    })).statusCode).toBe(403);
    expect((await request("PATCH", "/api/staff/" + outsideId + "/role", {
      role: "CASHIER", expectedUpdatedAt: new Date().toISOString(),
    })).statusCode).toBe(404);
    const pic = listing.staff.find((item: { id: string }) => item.id === picId);
    expect((await request("PATCH", "/api/staff/" + picId + "/role", {
      role: "TECHNICIAN", expectedUpdatedAt: pic.updatedAt,
    })).statusCode).toBe(403);
    expect((await request("PATCH", "/api/staff/" + picId + "/site-access", {
      active: false, expectedUpdatedAt: pic.updatedAt,
    })).statusCode).toBe(403);
  });

  it("changes a routine site role with optimistic concurrency, audit, and session invalidation", async () => {
    const targetId = createdIds[0]!;
    const sessionToken = randomBytes(32).toString("hex");
    await makeSession(targetId, site1, sessionToken);
    const listing = (await request("GET", "/api/staff")).json();
    const target = listing.staff.find((item: { id: string }) => item.id === targetId);
    const changed = await request("PATCH", "/api/staff/" + targetId + "/role", {
      role: "INVENTORY_MANAGER", expectedUpdatedAt: target.updatedAt,
    });
    expect(changed.statusCode).toBe(200);
    const stale = await request("PATCH", "/api/staff/" + targetId + "/role", {
      role: "CASHIER", expectedUpdatedAt: target.updatedAt,
    });
    expect(stale.statusCode).toBe(409);
    const session = await db.authSession.findUniqueOrThrow({
      where: { sessionHash: hashSecret(sessionToken) },
    });
    expect(session.revokedAt).not.toBeNull();
    const rejected = await app.inject({
      method: "GET", url: "/api/auth/me",
      headers: { cookie: "pharmacy1os_session=" + sessionToken },
    });
    expect(rejected.statusCode).toBe(401);
    const events = await db.auditEvent.findMany({
      where: { actorId: adminId, action: "STAFF_SITE_ROLE_CHANGED", entityType: "SiteRoleAssignment" },
    });
    expect(events.some(e => e.metadata && JSON.stringify(e.metadata).includes("INVENTORY_MANAGER"))).toBe(true);
  });

  it("suspends and restores site access but requires a new login", async () => {
    const targetId = createdIds[0]!;
    const member = (await request("GET", "/api/staff")).json().staff.find(
      (item: { id: string }) => item.id === targetId,
    );
    const token = randomBytes(32).toString("hex");
    await makeSession(targetId, site1, token);
    const disabled = await request("PATCH", "/api/staff/" + targetId + "/site-access", {
      active: false, expectedUpdatedAt: member.updatedAt,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().assignment.active).toBe(false);
    const blocked = await app.inject({
      method: "GET", url: "/api/auth/me",
      headers: { cookie: "pharmacy1os_session=" + token },
    });
    expect(blocked.statusCode).toBe(401);
    const updated = (await request("GET", "/api/staff")).json().staff.find(
      (item: { id: string }) => item.id === targetId,
    );
    const restored = await request("PATCH", "/api/staff/" + targetId + "/site-access", {
      active: true, expectedUpdatedAt: updated.updatedAt,
    });
    expect(restored.statusCode).toBe(200);
    const oldStillRevoked = await db.authSession.findUniqueOrThrow({
      where: { sessionHash: hashSecret(token) },
    });
    expect(oldStillRevoked.revokedAt).not.toBeNull();
  });

  it("revokes sessions only at the manager's site and protects the manager's own session", async () => {
    const targetId = createdIds[0]!;
    await db.siteRoleAssignment.create({
      data: { userId: targetId, siteId: site2, role: "CASHIER" },
    });
    const tokenHere = randomBytes(32).toString("hex");
    const tokenThere = randomBytes(32).toString("hex");
    await makeSession(targetId, site1, tokenHere);
    await makeSession(targetId, site2, tokenThere);
    expect((await request("POST", "/api/staff/" + adminId + "/sessions/revoke", {})).statusCode).toBe(403);
    const result = await request("POST", "/api/staff/" + targetId + "/sessions/revoke", {});
    expect(result.statusCode).toBe(200);
    expect(result.json().revokedSessions).toBe(1);
    const here = await db.authSession.findUniqueOrThrow({
      where: { sessionHash: hashSecret(tokenHere) },
    });
    const there = await db.authSession.findUniqueOrThrow({
      where: { sessionHash: hashSecret(tokenThere) },
    });
    expect(here.revokedAt).not.toBeNull();
    expect(there.revokedAt).toBeNull();
  });
});
