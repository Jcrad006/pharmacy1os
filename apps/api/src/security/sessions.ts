import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { User } from "@prisma/client";
import { db } from "../db.js";
import { roleHasPermission, type Permission, type Role } from "./roles.js";
import { AccessError } from "./devIdentity.js";

const IDLE_MINUTES = 15;
const SESSION_HOURS = 8;

export function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function sessionCookieName() {
  return process.env.OIDC_REDIRECT_URI?.startsWith("https://")
    ? "__Host-pharmacy1os-session"
    : "pharmacy1os_session";
}

export function readCookie(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers.cookie ?? "";
  for (const pair of raw.split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function csrfFor(sessionHash: string) {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new AccessError(503, "Session signing secret is not configured.");
  }
  return createHmac("sha256", secret).update("csrf:v1:" + sessionHash).digest("hex");
}

export type AuthenticatedSession = {
  actor: User;
  sessionId: string;
  sessionHash: string;
  csrfToken: string;
  expiresAt: Date;
};

export async function authenticateSession(
  request: FastifyRequest,
  permission?: Permission,
): Promise<AuthenticatedSession> {
  const token = readCookie(request, sessionCookieName());
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new AccessError(401, "Authentication required.");
  }
  const sessionHash = hashSecret(token);
  const session = await db.authSession.findUnique({
    where: { sessionHash },
    include: { user: true },
  });
  const now = new Date();
  if (
    !session || session.revokedAt || session.expiresAt <= now ||
    session.idleExpiresAt <= now || !session.user.active
  ) {
    throw new AccessError(401, "Session expired, locked or revoked.");
  }
  const grant = await db.siteRoleAssignment.findUnique({
    where: { userId_siteId: { userId: session.userId, siteId: session.siteId } },
  });
  if (!grant?.active) {
    throw new AccessError(403, "No active role for this site.");
  }
  if (permission && !roleHasPermission(grant.role as Role, permission)) {
    throw new AccessError(403, "Insufficient permissions.");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const provided = request.headers["x-csrf-token"];
    const expected = csrfFor(sessionHash);
    const tokenHeader = Array.isArray(provided) ? provided[0] : provided;
    if (!tokenHeader || !/^[a-f0-9]{64}$/.test(tokenHeader) ||
        !timingSafeEqual(Buffer.from(tokenHeader), Buffer.from(expected))) {
      throw new AccessError(403, "CSRF validation failed.");
    }
    const origin = request.headers.origin;
    const allowedOrigin = process.env.WEB_ORIGIN;
    if (origin && (!allowedOrigin || origin !== allowedOrigin)) {
      throw new AccessError(403, "Origin validation failed.");
    }
  }
  // Atomic active-session update prevents a session revoked concurrently
  // with this request from being refreshed back into an active state.
  const updated = await db.authSession.updateMany({
    where: {
      id: session.id,
      revokedAt: null,
      expiresAt: { gt: now },
      idleExpiresAt: { gt: now },
    },
    data: {
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + IDLE_MINUTES * 60_000),
    },
  });
  if (updated.count !== 1) throw new AccessError(401, "Session no longer active.");
  return {
    actor: { ...session.user, siteId: session.siteId, role: grant.role },
    sessionId: session.id,
    sessionHash,
    csrfToken: csrfFor(sessionHash),
    expiresAt: session.expiresAt,
  };
}

export async function createAuthenticatedSession(userId: string, siteId: string, authenticatedAt: Date) {
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const created = await db.authSession.create({
    data: {
      userId, siteId, sessionHash: hashSecret(token),
      mfaVerifiedAt: authenticatedAt,
      idleExpiresAt: new Date(now.getTime() + IDLE_MINUTES * 60_000),
      expiresAt: new Date(now.getTime() + SESSION_HOURS * 3_600_000),
    },
  });
  return { token, session: created };
}

export async function revokeSession(sessionId: string) {
  return db.authSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserSessions(userId: string) {
  return db.authSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
