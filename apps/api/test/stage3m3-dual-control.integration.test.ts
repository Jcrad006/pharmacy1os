import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { hashSecret, authenticateSession } from "../src/security/sessions.js";

process.env.AUTH_MODE = "oidc";
process.env.ALLOW_DEV_IDENTITY = "true";
process.env.ENABLE_SYNTHETIC_ROLE_GRANTS = "true";
process.env.AUTH_SESSION_SECRET = "stage-3m3-test-secret-abcdefghijklmnopqrstuv012345";
process.env.OIDC_ISSUER = "http://localhost:4999/realms/test";
process.env.OIDC_CLIENT_ID = "pharmacy1os-test";
process.env.OIDC_REDIRECT_URI = "http://localhost:3001/api/auth/callback";
process.env.WEB_ORIGIN = "http://localhost:5173";

const app = buildApp();
const site = "site-demo-001";
const otherSite = "site-demo-002";
const adminId = "stage3m3-admin-" + randomUUID();
const picId = "stage3m3-pic-" + randomUUID();
const technicianId = "stage3m3-tech-" + randomUUID();
const outsiderId = "stage3m3-outsider-" + randomUUID();
const staff = [
  { id: adminId, siteId: site, role: "ADMIN" },
  { id: picId, siteId: site, role: "PHARMACIST_IN_CHARGE" },
  { id: technicianId, siteId: site, role: "TECHNICIAN" },
  { id: outsiderId, siteId: otherSite, role: "PHARMACIST_IN_CHARGE" },
] as const;
const cookies = new Map<string, string>();
const csrf = new Map<string, string>();

async function createStaff(user: typeof staff[number]) {
  await db.user.create({
    data: {
      id: user.id, siteId: user.siteId, role: user.role,
      displayName: "3M3 " + user.role, active: true, oidcSubject: user.id,
    },
  });
  await db.siteRoleAssignment.create({
    data: { userId: user.id, siteId: user.siteId, role: user.role },
  });
  const token = randomBytes(32).toString("hex");
  cookies.set(user.id, "pharmacy1os_session=" + token);
  await db.authSession.create({
    data: {
      userId: user.id, siteId: user.siteId, sessionHash: hashSecret(token),
      expiresAt: new Date(Date.now() + 8 * 3_600_000),
      idleExpiresAt: new Date(Date.now() + 15 * 60_000),
      mfaVerifiedAt: new Date(),
    },
  });
}

function api(actorId: string, method: "GET" | "POST", path: string, input?: unknown) {
  return app.inject({
    method, url: path,
    headers: {
      cookie: cookies.get(actorId)!,
      ...(method === "POST" ? {
        "x-csrf-token": csrf.get(actorId)!, "content-type": "application/json",
      } : {}),
    },
    ...(input === undefined ? {} : { payload: JSON.stringify(input) }),
  });
}
function mockRequest(userId: string): FastifyRequest {
  return {
    method: "GET",
    headers: { cookie: cookies.get(userId) },
  } as unknown as FastifyRequest;
}

beforeAll(async () => {
  await app.ready();
  for (const u of staff) await createStaff(u);
  for (const u of staff) {
    const result = await api(u.id, "GET", "/api/auth/me");
    expect(result.statusCode).toBe(200);
    csrf.set(u.id, result.json().csrfToken);
  }
});
afterAll(async () => {
  const ids = staff.map(u => u.id);
  await db.privilegedAccessRequest.deleteMany({
    where: { OR: [
      { requestedById: { in: ids } }, { targetUserId: { in: ids } },
    ] },
  });
  await db.auditEvent.deleteMany({ where: { actorId: { in: ids } } });
  await db.authSession.deleteMany({ where: { userId: { in: ids } } });
  await db.siteRoleAssignment.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await app.close();
  await db.$disconnect();
});

describe("Stage 3M.3 two-person privileged authorization", () => {
  it("rejects unsafe permissions and unauthorized third-party elevation", async () => {
    const spoofed = await app.inject({
      method: "POST", url: "/api/privileged/requests",
      headers: { "x-dev-user": "dev-admin", "content-type": "application/json" },
      payload: JSON.stringify({
        kind: "TEMP_PERMISSION", requestedPermission: "inventory:correct",
        reason: "Inventory reconciliation for testing",
      }),
    });
    expect(spoofed.statusCode).toBe(401);
    const bad = await api(technicianId, "POST", "/api/privileged/requests", {
      kind: "TEMP_PERMISSION", requestedPermission: "prescription:verify",
      reason: "Try bypassing pharmacist verification",
    });
    expect(bad.statusCode).toBe(403);
    const crossUser = await api(technicianId, "POST", "/api/privileged/requests", {
      kind: "TEMP_PERMISSION", requestedPermission: "inventory:correct",
      targetUserId: adminId, reason: "Unauthorized third-party request attempt",
    });
    expect(crossUser.statusCode).toBe(403);
  });

  it("requires a separate site leader and blocks self/beneficiary/cross-site review", async () => {
    const created = await api(technicianId, "POST", "/api/privileged/requests", {
      kind: "TEMP_PERMISSION", requestedPermission: "inventory:correct",
      reason: "Reconcile inventory discrepancy in test stock",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().request.id as string;
    await expect(authenticateSession(mockRequest(technicianId), "inventory:correct"))
      .rejects.toMatchObject({ statusCode: 403 });
    expect((await api(technicianId, "POST", "/api/privileged/requests/" + id + "/review", {
      decision: "APPROVED", note: "Attempting self approval of privilege",
    })).statusCode).toBe(403);
    expect((await api(outsiderId, "POST", "/api/privileged/requests/" + id + "/review", {
      decision: "APPROVED", note: "Attempt from a different pharmacy",
    })).statusCode).toBe(404);
    const deniedToOrdinary = await api(technicianId, "GET", "/api/privileged/requests");
    expect(deniedToOrdinary.statusCode).toBe(200);
    const outsiderList = await api(outsiderId, "GET", "/api/privileged/requests");
    expect(outsiderList.json().requests.some((r: { id: string }) => r.id === id)).toBe(false);
    const approved = await api(picId, "POST", "/api/privileged/requests/" + id + "/review", {
      decision: "APPROVED", note: "Approved for a synthetic inventory reconciliation",
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().request.status).toBe("APPROVED");
    await expect(authenticateSession(mockRequest(technicianId), "inventory:correct"))
      .resolves.toMatchObject({ actor: { id: technicianId, role: "TECHNICIAN" } });
    await expect(authenticateSession(mockRequest(technicianId), "prescription:verify"))
      .rejects.toMatchObject({ statusCode: 403 });
    const reviewerGrantKey = { userId_siteId: { userId: picId, siteId: site } };
    await db.siteRoleAssignment.update({ where: reviewerGrantKey, data: { active: false } });
    await expect(authenticateSession(mockRequest(technicianId), "inventory:correct"))
      .rejects.toMatchObject({ statusCode: 403 });
    await db.siteRoleAssignment.update({ where: reviewerGrantKey, data: { active: true } });
    const beforeExpiry = await db.privilegedAccessRequest.findUniqueOrThrow({ where: { id } });
    await db.privilegedAccessRequest.update({
      where: { id }, data: { effectiveUntil: new Date(Date.now() - 1000) },
    });
    await expect(authenticateSession(mockRequest(technicianId), "inventory:correct"))
      .rejects.toMatchObject({ statusCode: 403 });
    await db.privilegedAccessRequest.update({
      where: { id }, data: { effectiveUntil: beforeExpiry.effectiveUntil },
    });
    const repeat = await api(adminId, "POST", "/api/privileged/requests/" + id + "/review", {
      decision: "APPROVED", note: "Attempt to reuse decided approval",
    });
    expect(repeat.statusCode).toBe(409);
    const cancelled = await api(technicianId, "POST", "/api/privileged/requests/" + id + "/cancel", {});
    expect(cancelled.statusCode).toBe(200);
    await expect(authenticateSession(mockRequest(technicianId), "inventory:correct"))
      .rejects.toMatchObject({ statusCode: 403 });
    const audit = await db.auditEvent.findMany({
      where: { entityType: "PrivilegedAccessRequest", entityId: id },
    });
    expect(audit.map(e => e.action)).toEqual([
      "PRIVILEGE_APPROVAL_REQUESTED", "PRIVILEGE_APPROVED", "PRIVILEGE_CANCELLED",
    ]);
  });

  it("rejects expired, stale MFA and denied privileges; a denial never grants access", async () => {
    const staleSession = await db.authSession.findUniqueOrThrow({
      where: { sessionHash: hashSecret(cookies.get(technicianId)!.split("=")[1]!) },
    });
    await db.authSession.update({
      where: { id: staleSession.id }, data: { mfaVerifiedAt: new Date(Date.now() - 7 * 60_000) },
    });
    const stale = await api(technicianId, "POST", "/api/privileged/requests", {
      kind: "TEMP_PERMISSION", requestedPermission: "inventory:correct",
      reason: "Should not accept stale multifactor login",
    });
    expect(stale.statusCode).toBe(403);
    await db.authSession.update({
      where: { id: staleSession.id }, data: { mfaVerifiedAt: new Date() },
    });
    const created = await api(technicianId, "POST", "/api/privileged/requests", {
      kind: "TEMP_PERMISSION", requestedPermission: "inventory:correct",
      reason: "Pending request for explicit denial test",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().request.id as string;
    const denied = await api(picId, "POST", "/api/privileged/requests/" + id + "/review", {
      decision: "DENIED", note: "Insufficient synthetic justification provided",
    });
    expect(denied.statusCode).toBe(200);
    await expect(authenticateSession(mockRequest(technicianId), "inventory:correct"))
      .rejects.toMatchObject({ statusCode: 403 });
    const another = await api(technicianId, "POST", "/api/privileged/requests", {
      kind: "TEMP_PERMISSION", requestedPermission: "thirdparty:override",
      reason: "Synthetic claim exception test request",
    });
    expect(another.statusCode).toBe(201);
    const record = await db.privilegedAccessRequest.findUniqueOrThrow({
      where: { id: another.json().request.id },
    });
    await db.privilegedAccessRequest.update({
      where: { id: record.id },
      data: { reviewDeadlineAt: new Date(record.createdAt.getTime() + 1) },
    });
    const expired = await api(picId, "POST", "/api/privileged/requests/" + record.id + "/review", {
      decision: "APPROVED", note: "Cannot approve an expired request",
    });
    expect(expired.statusCode).toBe(409);
  });

  it("requires different authorized leaders for clinical/admin grants and revokes prior sessions", async () => {
    const grant = await db.siteRoleAssignment.findUniqueOrThrow({
      where: { userId_siteId: { userId: technicianId, siteId: site } },
    });
    const unauthorized = await api(technicianId, "POST", "/api/privileged/requests", {
      kind: "ROLE_GRANT", targetUserId: technicianId,
      requestedRole: "PHARMACIST", expectedAssignmentUpdatedAt: grant.updatedAt.toISOString(),
      reason: "Unsafe self promotion request",
    });
    expect(unauthorized.statusCode).toBe(403);
    const created = await api(adminId, "POST", "/api/privileged/requests", {
      kind: "ROLE_GRANT", targetUserId: technicianId,
      requestedRole: "PHARMACIST", expectedAssignmentUpdatedAt: grant.updatedAt.toISOString(),
      reason: "Synthetic independent pharmacist access review",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().request.id as string;
    expect((await api(adminId, "POST", "/api/privileged/requests/" + id + "/review", {
      decision: "APPROVED", note: "Administrator cannot approve their own request",
    })).statusCode).toBe(403);
    const approved = await api(picId, "POST", "/api/privileged/requests/" + id + "/review", {
      decision: "APPROVED", note: "Synthetic licensed-staff workflow demonstration only",
    });
    expect(approved.statusCode).toBe(200);
    expect((await db.siteRoleAssignment.findUniqueOrThrow({
      where: { userId_siteId: { userId: technicianId, siteId: site } },
    })).role).toBe("PHARMACIST");
    expect((await api(technicianId, "GET", "/api/auth/me")).statusCode).toBe(401);
  });
});
