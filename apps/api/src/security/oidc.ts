import { createPublicKey, randomBytes, verify } from "node:crypto";
import { AccessError } from "./devIdentity.js";
import { hashSecret } from "./sessions.js";

type OidcClaims = {
  iss?: unknown; sub?: unknown; aud?: unknown; azp?: unknown;
  exp?: unknown; iat?: unknown; nbf?: unknown; nonce?: unknown;
  auth_time?: unknown; amr?: unknown; acr?: unknown;
};

export function oidcEnabled() {
  return process.env.AUTH_MODE === "oidc";
}

export function oidcConfig() {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
  const clientId = process.env.OIDC_CLIENT_ID;
  const redirectUri = process.env.OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !redirectUri) {
    throw new AccessError(503, "OIDC issuer, client ID and callback URI are required.");
  }
  for (const urlText of [issuer, redirectUri]) {
    let parsed: URL;
    try { parsed = new URL(urlText); } catch {
      throw new AccessError(503, "Invalid OIDC URL configuration.");
    }
    if (parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) &&
          process.env.NODE_ENV !== "production")) {
      throw new AccessError(503, "OIDC requires HTTPS except loopback development.");
    }
  }
  if (!redirectUri.endsWith("/api/auth/callback")) {
    throw new AccessError(503, "OIDC callback URI must end with /api/auth/callback.");
  }
  return { issuer, clientId, redirectUri };
}

type ProviderMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok) throw new AccessError(503, "Identity provider is unavailable.");
  return response.json();
}

function validProviderUrl(value: unknown, issuer: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const issuerUrl = new URL(issuer);
    return url.protocol === issuerUrl.protocol && url.origin === issuerUrl.origin &&
      !url.username && !url.password;
  } catch { return false; }
}

export async function oidcMetadata(): Promise<ProviderMetadata> {
  const { issuer } = oidcConfig();
  const metadata = await getJson(issuer + "/.well-known/openid-configuration") as Partial<ProviderMetadata>;
  if (metadata?.issuer !== issuer ||
      !validProviderUrl(metadata.authorization_endpoint, issuer) ||
      !validProviderUrl(metadata.token_endpoint, issuer) ||
      !validProviderUrl(metadata.jwks_uri, issuer)) {
    throw new AccessError(503, "Identity-provider discovery is not trusted.");
  }
  return metadata as ProviderMetadata;
}

function decodeSegment(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new AccessError(401, "Invalid identity token.");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Invalid");
    return parsed as Record<string, unknown>;
  } catch { throw new AccessError(401, "Invalid identity token."); }
}

export function verifyOidcIdToken(
  compact: string, jwks: unknown, expectedNonce: string, nowSeconds = Math.floor(Date.now() / 1000),
): { subject: string; authenticatedAt: Date } {
  const { issuer, clientId } = oidcConfig();
  const segments = compact.split(".");
  if (segments.length !== 3) throw new AccessError(401, "Invalid identity token.");
  const [head64, body64, sig64] = segments;
  const header = decodeSegment(head64!);
  const claims = decodeSegment(body64!) as OidcClaims;
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid ||
      (header.typ !== undefined && header.typ !== "JWT")) {
    throw new AccessError(401, "Unsupported identity-token signature.");
  }
  const keys = (jwks as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) throw new AccessError(401, "Invalid provider signing keys.");
  const key = keys.find((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") return false;
    const jwk = candidate as Record<string, unknown>;
    return jwk.kid === header.kid && jwk.kty === "RSA" &&
      (!jwk.use || jwk.use === "sig") && (!jwk.alg || jwk.alg === "RS256") &&
      typeof jwk.n === "string" && typeof jwk.e === "string";
  });
  if (!key) throw new AccessError(401, "Provider signing key unavailable.");
  try {
    const publicKey = createPublicKey({ key, format: "jwk" });
    if (!verify("RSA-SHA256", Buffer.from(head64 + "." + body64), publicKey,
      Buffer.from(sig64!, "base64url"))) {
      throw Error("Bad signature");
    }
  } catch { throw new AccessError(401, "Identity-token signature failed."); }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || typeof claims.sub !== "string" || !claims.sub ||
      !audience.includes(clientId) ||
      (audience.length > 1 && claims.azp !== clientId) ||
      typeof claims.exp !== "number" || claims.exp <= nowSeconds ||
      typeof claims.iat !== "number" || claims.iat > nowSeconds + 60 ||
      nowSeconds - claims.iat > 600 ||
      (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 60) ||
      claims.nonce !== expectedNonce) {
    throw new AccessError(401, "Identity-token claims failed validation.");
  }
  // A new login always requires interactive authentication and a recent MFA
  // assertion. Never equate a password-only login or a role claim with MFA.
  const amr = Array.isArray(claims.amr) ? claims.amr : [];
  const acrValues = (process.env.OIDC_MFA_ACR_VALUES ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const mfa = amr.includes("mfa") || (amr.includes("pwd") && amr.includes("otp")) ||
    (typeof claims.acr === "string" && acrValues.includes(claims.acr));
  if (!mfa || typeof claims.auth_time !== "number" ||
      claims.auth_time > nowSeconds + 60 || nowSeconds - claims.auth_time > 300) {
    throw new AccessError(403, "Recent multifactor authentication is required.");
  }
  return { subject: claims.sub, authenticatedAt: new Date(claims.auth_time * 1000) };
}

export function randomUrlToken() {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string) {
  return Buffer.from(hashSecret(verifier), "hex").toString("base64url");
}

export async function redeemAuthorizationCode(code: string, verifier: string, nonce: string) {
  const metadata = await oidcMetadata();
  const { clientId, redirectUri } = oidcConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (process.env.OIDC_CLIENT_SECRET) body.set("client_secret", process.env.OIDC_CLIENT_SECRET);
  const response = await fetch(metadata.token_endpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body, signal: AbortSignal.timeout(5000), redirect: "error",
  });
  if (!response.ok) throw new AccessError(401, "Identity-provider authorization failed.");
  const tokens = await response.json() as { id_token?: unknown };
  if (typeof tokens.id_token !== "string") throw new AccessError(401, "Missing identity token.");
  const jwks = await getJson(metadata.jwks_uri);
  return verifyOidcIdToken(tokens.id_token, jwks, nonce);
}
