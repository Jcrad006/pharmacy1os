import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db.js";
import { writeAuditEvent } from "../audit.js";
import { AccessError } from "../security/devIdentity.js";
import {
  oidcEnabled, oidcConfig, oidcMetadata, pkceChallenge,
  randomUrlToken, redeemAuthorizationCode,
} from "../security/oidc.js";
import {
  authenticateSession, createAuthenticatedSession, hashSecret,
  readCookie, revokeSession, sessionCookieName,
} from "../security/sessions.js";

const STATE_COOKIE = "pharmacy1os_oidc_state";

function cookie(name: string, value: string, maxAge: number, httpOnly = true) {
  const secure = process.env.OIDC_REDIRECT_URI?.startsWith("https://");
  return name + "=" + value + "; Path=/; SameSite=Lax; Max-Age=" + maxAge +
    (httpOnly ? "; HttpOnly" : "") + (secure ? "; Secure" : "");
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof AccessError) return reply.code(error.statusCode).send({ error: error.message });
  throw error;
}

function requireMode() {
  if (!oidcEnabled()) throw new AccessError(404, "Not found.");
  oidcConfig();
  if (!process.env.AUTH_SESSION_SECRET ||
      Buffer.byteLength(process.env.AUTH_SESSION_SECRET, "utf8") < 32) {
    throw new AccessError(503, "AUTH_SESSION_SECRET requires 32 bytes.");
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.get("/auth/status", async () => ({
    mode: oidcEnabled() ? "oidc" : "development",
    syntheticOnly: true,
  }));

  app.get("/auth/login", async (_request, reply) => {
    try {
      requireMode();
      const { clientId, redirectUri } = oidcConfig();
      const provider = await oidcMetadata();
      const state = randomUrlToken();
      const verifier = randomUrlToken();
      const nonce = randomUrlToken();
      await db.oidcLoginAttempt.create({
        data: {
          stateHash: hashSecret(state), nonce, pkceVerifier: verifier,
          expiresAt: new Date(Date.now() + 5 * 60_000),
        },
      });
      const url = new URL(provider.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("code_challenge", pkceChallenge(verifier));
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("prompt", "login");
      url.searchParams.set("max_age", "300");
      return reply.header("Set-Cookie", cookie(STATE_COOKIE, state, 300))
        .code(302).header("Location", url.toString()).send();
    } catch (error) { return handleError(reply, error); }
  });

  app.get("/auth/callback", async (request, reply) => {
    try {
      requireMode();
      const query = request.query as { code?: string; state?: string; error?: string };
      if (query.error || !query.code || !query.state ||
          !/^[A-Za-z0-9_-]{40,64}$/.test(query.state) ||
          readCookie(request, STATE_COOKIE) !== query.state) {
        throw new AccessError(401, "Login flow failed.");
      }
      const stateHash = hashSecret(query.state);
      const attempt = await db.oidcLoginAttempt.findUnique({ where: { stateHash } });
      if (!attempt || attempt.consumedAt || attempt.expiresAt <= new Date()) {
        throw new AccessError(401, "Login flow expired or replayed.");
      }
      // Consume before token exchange; concurrent callbacks cannot reuse a state.
      const claimed = await db.oidcLoginAttempt.updateMany({
        where: { stateHash, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) throw new AccessError(401, "Login flow replayed.");
      const principal = await redeemAuthorizationCode(query.code, attempt.pkceVerifier, attempt.nonce);
      const user = await db.user.findUnique({ where: { oidcSubject: principal.subject } });
      if (!user?.active) throw new AccessError(403, "Staff account inactive or not provisioned.");
      const grant = await db.siteRoleAssignment.findUnique({
        where: { userId_siteId: { userId: user.id, siteId: user.siteId } },
      });
      if (!grant?.active) throw new AccessError(403, "No active site membership.");
      const { token, session } = await createAuthenticatedSession(user.id, grant.siteId, principal.authenticatedAt);
      await db.$transaction((tx) => writeAuditEvent(tx, {
        siteId: grant.siteId, actorId: user.id,
        action: "AUTH_LOGIN_MFA", entityType: "AuthSession", entityId: session.id,
        requestId: request.id,
      }));
      // Opaque cookie only; JWTs, access tokens, refresh tokens and MFA claims
      // are never returned to JavaScript or persisted.
      return reply.header("Set-Cookie", [
        cookie(STATE_COOKIE, "", 0),
        cookie(sessionCookieName(), token, 8 * 3600),
      ]).code(302).header("Location", process.env.WEB_ORIGIN ?? "/").send();
    } catch (error) { return handleError(reply, error); }
  });

  app.get("/auth/me", async (request, reply) => {
    try {
      requireMode();
      const auth = await authenticateSession(request);
      const site = await db.pharmacySite.findUnique({
        where: { id: auth.actor.siteId }, select: { name: true },
      });
      return {
        user: {
          id: auth.actor.id, externalAuthId: "authenticated", displayName: auth.actor.displayName,
          role: auth.actor.role, siteId: auth.actor.siteId, siteName: site?.name ?? "",
        },
        csrfToken: auth.csrfToken,
        expiresAt: auth.expiresAt.toISOString(),
      };
    } catch (error) { return handleError(reply, error); }
  });

  async function endSession(request: FastifyRequest, reply: FastifyReply, reason: string) {
    try {
      requireMode();
      const auth = await authenticateSession(request);
      await revokeSession(auth.sessionId);
      await db.$transaction((tx) => writeAuditEvent(tx, {
        siteId: auth.actor.siteId, actorId: auth.actor.id,
        action: reason, entityType: "AuthSession", entityId: auth.sessionId,
        requestId: request.id,
      }));
      return reply.header("Set-Cookie", cookie(sessionCookieName(), "", 0))
        .send({ locked: true });
    } catch (error) { return handleError(reply, error); }
  }
  app.post("/auth/logout", (request, reply) => endSession(request, reply, "AUTH_LOGOUT"));
  app.post("/auth/lock", (request, reply) => endSession(request, reply, "WORKSTATION_LOCK"));

  app.post("/auth/site", async (request, reply) => {
    try {
      requireMode();
      const auth = await authenticateSession(request);
      const body = request.body as { siteId?: string };
      if (!body?.siteId || body.siteId.length > 100) throw new AccessError(400, "Invalid site.");
      const grant = await db.siteRoleAssignment.findUnique({
        where: { userId_siteId: { userId: auth.actor.id, siteId: body.siteId } },
      });
      if (!grant?.active) throw new AccessError(403, "No site membership.");
      await db.$transaction(async tx => {
        await tx.authSession.updateMany({
          where: { id: auth.sessionId, revokedAt: null },
          data: { siteId: grant.siteId },
        });
        await writeAuditEvent(tx, {
          siteId: grant.siteId, actorId: auth.actor.id,
          action: "AUTH_SITE_SWITCH", entityType: "AuthSession", entityId: auth.sessionId,
          requestId: request.id, metadata: { fromSiteId: auth.actor.siteId },
        });
      });
      return { siteId: grant.siteId, role: grant.role };
    } catch (error) { return handleError(reply, error); }
  });
}
