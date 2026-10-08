import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { db } from "../src/db.js";
import { verifyOidcIdToken } from "../src/security/oidc.js";
import { hashSecret } from "../src/security/sessions.js";

process.env.AUTH_MODE = "oidc";
process.env.ALLOW_DEV_IDENTITY = "true"; // Must have NO effect in OIDC mode.
process.env.AUTH_SESSION_SECRET = "stage-3m-session-key-0123456789abcdef0123456789abcdef";
process.env.OIDC_ISSUER = "http://localhost:4999/realms/test";
process.env.OIDC_CLIENT_ID = "pharmacy1os-test";
process.env.OIDC_REDIRECT_URI = "http://localhost:3001/api/auth/callback";
process.env.WEB_ORIGIN = "http://localhost:5173";

const app = buildApp();
const token = randomBytes(32).toString("hex");
const siteId = "site-demo-001";
const userId = "user-stage3m-" + randomUUID();
let sessionId: string;

beforeAll(async () => {
  await app.ready();
  await db.user.create({
    data: {
      id: userId, siteId, displayName: "Stage3M Staff",
      role: "TECHNICIAN", active: true, oidcSubject: "stage3m-" + userId,
    },
  });
  await db.siteRoleAssignment.create({
    data: { userId, siteId, role: "TECHNICIAN" },
  });
  const session = await db.authSession.create({
    data: {
      sessionHash: hashSecret(token), userId, siteId,
      idleExpiresAt: new Date(Date.now() + 15 * 60_000),
      expiresAt: new Date(Date.now() + 8 * 3_600_000),
      mfaVerifiedAt: new Date(),
    },
  });
  sessionId = session.id;
});

afterAll(async () => {
  await db.authSession.deleteMany({ where: { userId } });
  await db.siteRoleAssignment.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
  await app.close();
  await db.$disconnect();
});

const cookie = { cookie: "pharmacy1os_session=" + token };

describe("Stage 3M first security boundary", () => {
  it("rejects synthetic impersonation even when its legacy flag is enabled", async () => {
    const response = await app.inject({
      method: "GET", url: "/api/patients",
      headers: { "x-dev-user": "dev-admin" },
    });
    expect(response.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/dev/users" })).statusCode).toBe(404);
  });

  it("requires a valid server session and returns an in-memory CSRF token", async () => {
    const noSession = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(noSession.statusCode).toBe(401);
    const response = await app.inject({
      method: "GET", url: "/api/auth/me", headers: cookie,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({
      siteId, role: "TECHNICIAN", displayName: "Stage3M Staff",
    });
    expect(response.json().csrfToken).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces CSRF and the origin on writes", async () => {
    const missing = await app.inject({
      method: "POST", url: "/api/auth/site", headers: cookie,
      payload: { siteId },
    });
    expect(missing.statusCode).toBe(403);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: cookie });
    const csrf = me.json().csrfToken as string;
    const wrongOrigin = await app.inject({
      method: "POST", url: "/api/auth/site",
      headers: { ...cookie, "x-csrf-token": csrf, origin: "https://evil.example.invalid" },
      payload: { siteId },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    const allowed = await app.inject({
      method: "POST", url: "/api/auth/site",
      headers: { ...cookie, "x-csrf-token": csrf, origin: process.env.WEB_ORIGIN! },
      payload: { siteId },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("rejects permission elevation and site switching to nonmembers", async () => {
    const backups = await app.inject({
      method: "GET", url: "/api/system/backups", headers: cookie,
    });
    expect(backups.statusCode).toBe(403);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: cookie });
    const crossSite = await app.inject({
      method: "POST", url: "/api/auth/site",
      headers: { ...cookie, "x-csrf-token": me.json().csrfToken },
      payload: { siteId: "site-demo-002" },
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it("invalidates a locked or revoked session server-side", async () => {
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: cookie });
    const locked = await app.inject({
      method: "POST", url: "/api/auth/lock",
      headers: { ...cookie, "x-csrf-token": me.json().csrfToken },
    });
    expect(locked.statusCode).toBe(200);
    const blocked = await app.inject({ method: "GET", url: "/api/auth/me", headers: cookie });
    expect(blocked.statusCode).toBe(401);
    const session = await db.authSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.revokedAt).not.toBeNull();
  });
});

describe("OIDC signature, claims and MFA", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const jwks = { keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] };
  function signed(override: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "RS256", kid: "test-key" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({
      iss: process.env.OIDC_ISSUER,
      sub: "real-staff-subject",
      aud: process.env.OIDC_CLIENT_ID,
      exp: now + 300, iat: now, auth_time: now,
      nonce: "good-nonce", amr: ["pwd", "otp"],
      ...override,
    })).toString("base64url");
    const payload = header + "." + claims;
    return payload + "." + sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url");
  }

  it("accepts valid RS256 OIDC assertions with PKCE-bound nonce and recent MFA", () => {
    expect(verifyOidcIdToken(signed(), jwks, "good-nonce").subject).toBe("real-staff-subject");
  });

  it("rejects forged signature, stale authentication, wrong audience or nonce, and password-only assertions", () => {
    expect(() => verifyOidcIdToken(signed(), { keys: [] }, "good-nonce")).toThrow();
    expect(() => verifyOidcIdToken(signed(), jwks, "wrong-nonce")).toThrow();
    expect(() => verifyOidcIdToken(signed({ aud: "attacker" }), jwks, "good-nonce")).toThrow();
    expect(() => verifyOidcIdToken(signed({ amr: ["pwd"] }), jwks, "good-nonce")).toThrow();
    expect(() => verifyOidcIdToken(signed({ auth_time: 1 }), jwks, "good-nonce")).toThrow();
    const parts = signed().split(".");
    parts[2] = (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1);
    expect(() => verifyOidcIdToken(parts.join("."), jwks, "good-nonce")).toThrow();
  });
});
