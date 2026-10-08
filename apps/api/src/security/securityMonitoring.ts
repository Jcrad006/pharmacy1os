import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { AccessError } from "./devIdentity.js";
import { authenticateSession, hashSecret, readCookie, sessionCookieName } from "./sessions.js";

// Never trust an unconfigured X-Forwarded-For value. Fastify is configured
// with trustProxy=false; a reverse proxy will appear as a single peer until
// an explicitly verified deployment-specific trust policy is installed.
export function networkFingerprint(request: FastifyRequest) {
  const key = process.env.AUTH_SESSION_SECRET;
  if (!key || Buffer.byteLength(key, "utf8") < 32) return null;
  const day = new Date().toISOString().slice(0, 10);
  return createHmac("sha256", key).update(day + ":" + request.ip).digest("hex");
}

// Persistent abuse signal for development: distributed/atomic admission
// limits and IdP-side throttling are separate production requirements.
export async function checkAuthLoginThrottle(request: FastifyRequest) {
  const fingerprint = networkFingerprint(request);
  if (!fingerprint) throw new AccessError(503, "Security monitoring secret unavailable.");
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
  const attempts = await db.securityEvent.count({
    where: {
      kind: "AUTH_LOGIN_STARTED",
      networkHash: fingerprint,
      occurredAt: { gte: fiveMinutesAgo },
    },
  });
  if (attempts >= 10) throw new AccessError(429, "Login request limit reached.");
  await db.securityEvent.create({
    data: {
      siteId: null, kind: "AUTH_LOGIN_STARTED",
      requestPath: "/api/auth/login", httpStatus: 302,
      networkHash: fingerprint,
    },
  });
}

export function registerSecurityMonitoring(app: FastifyInstance) {
  app.addHook("onResponse", async (request, reply) => {
    if (process.env.AUTH_MODE !== "oidc") return;
    if (![401, 403, 429].includes(reply.statusCode)) return;
    const pathTemplate = request.routeOptions.url ?? "";
    if (!pathTemplate.startsWith("/api/")) return;
    const kind = reply.statusCode === 401 ? "AUTH_REJECTED" :
      reply.statusCode === 403 ? "ACCESS_DENIED" : "AUTH_RATE_LIMITED";
    const rawToken = readCookie(request, sessionCookieName());
    let siteId: string | null = null;
    try {
      if (rawToken && /^[a-f0-9]{64}$/.test(rawToken)) {
        const session = await db.authSession.findUnique({
          where: { sessionHash: hashSecret(rawToken) },
          select: { siteId: true },
        });
        siteId = session?.siteId ?? null;
      }
      await db.securityEvent.create({
        data: {
          kind, siteId,
          requestPath: pathTemplate.slice(0, 160),
          httpStatus: reply.statusCode,
          networkHash: networkFingerprint(request),
        },
      });
    } catch (error) {
      // Security-event persistence is best effort in this prototype; record
      // diagnostics without turning an access denial into a 500 or exposing PII.
      app.log.error({ err: error }, "Security monitoring write failed");
    }
  });
}

export async function securityMonitoringRoutes(app: FastifyInstance) {
  app.get("/security/events", async (request, reply) => {
    try {
      if (process.env.AUTH_MODE !== "oidc") throw new AccessError(404, "Not found.");
      const auth = await authenticateSession(request);
      if (auth.actor.role !== "ADMIN") throw new AccessError(403, "Administrator access required.");
      const since = new Date(Date.now() - 24 * 3_600_000);
      const [events, siteFailures, unattributedLoginFailures] = await Promise.all([
        db.securityEvent.findMany({
          where: {
            siteId: auth.actor.siteId, occurredAt: { gte: since },
            kind: { in: ["AUTH_REJECTED", "ACCESS_DENIED", "AUTH_RATE_LIMITED"] },
          },
          orderBy: { occurredAt: "desc" }, take: 100,
          select: { id: true, kind: true, requestPath: true,
            httpStatus: true, occurredAt: true },
        }),
        db.securityEvent.count({
          where: { siteId: auth.actor.siteId, occurredAt: { gte: since },
            kind: { in: ["AUTH_REJECTED", "ACCESS_DENIED", "AUTH_RATE_LIMITED"] } },
        }),
        db.securityEvent.count({
          where: { siteId: null, occurredAt: { gte: since }, kind: "AUTH_REJECTED" },
        }),
      ]);
      return {
        windowHours: 24,
        siteFailures,
        unattributedLoginFailures,
        events: events.map(e => ({ ...e, occurredAt: e.occurredAt.toISOString() })),
        note: "Security log is best effort in the prototype, not a tamper-evident production audit.",
      };
    } catch (error) {
      if (error instanceof AccessError)
        return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
