# Stage 3M.1 — Identity foundation (in progress)

**Scope:** First increment of Stage 3M from [PROGRESSION_MAP.md](PROGRESSION_MAP.md). This increment is **not a completed production security stage**. Pharmacy1OS remains a synthetic-data-only research/development prototype. Keep live pharmacy operations, real patient data, EPCS, claims and other regulated integrations disconnected.

## Delivered in this increment

- Two deliberately separate identity modes: existing **development-only** `x-dev-user` impersonation and `AUTH_MODE=oidc` for externally authenticated sessions. An OIDC-mode request **never** accepts the development identity header. Development identity is rejected outright in NODE_ENV=production.
- A constrained OpenID Connect (OIDC) authorization-code login using S256 PKCE, one-time state and nonce, no automatic signup, provider discovery bound to a configured issuer, RS256 JWKS signature validation, exact issuer/audience/nonce checks, and recent MFA assertions (`amr` or explicitly configured accepted `acr` values). An interactive login is requested on every login, including after lock.
- Random 256-bit bearer session token in an HttpOnly, SameSite=Lax cookie. Only its SHA-256 hash is stored in PostgreSQL. Database-backed revocation, 15-minute inactivity timeout, eight-hour absolute lifetime, and user account disabled checks on every protected API call.
- Unsafe-method CSRF HMAC challenge derived with a server-only session secret, plus Origin checks; cookie-controlled route access must pass both authentication and site-scoped role authorization.
- Additive staff `oidcSubject` binding (issuer is pinned in system config), `SiteRoleAssignment`, `AuthSession`, and one-time OIDC login attempt tables; migration backfills existing synthetic actors' current-site roles, with seed parity.
- Workstation sign-in/locked screen, authenticated identity display, explicit lock/sign-out, and an inactivity lock. Existing synthetic-staff UI is preserved **only** in development identity mode.
- Authenticated `/api/auth/site` switching only when an active membership at that exact site exists, with audit history; no privilege inheritance across sites.

## Configuration and bootstrap in a development environment

1. Configure a separate **test** OIDC realm with an authorization-code client that permits PKCE S256 and requests MFA. Keycloak is one example of a self-hosted OIDC implementation. Use test staff identities only.
2. Set `AUTH_MODE=oidc`, `ALLOW_DEV_IDENTITY=false`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_REDIRECT_URI` (exact registered URI ending `/api/auth/callback`). Set `AUTH_SESSION_SECRET` to at least 32 unpredictable bytes; store secrets outside Git. Set `WEB_ORIGIN` to the exact workstation origin. If the client is confidential, set `OIDC_CLIENT_SECRET` via secret management.
3. Require multifactor login in the IdP. The prototype accepts an ID token with `amr` containing `mfa`, `amr` containing both `pwd` and `otp`, or an `acr` matching a trusted value in `OIDC_MFA_ACR_VALUES`. An IdP declaring untrusted `acr` values must **not** be added. Tokens without a recent `auth_time` fail closed.
4. Manually provision the staff's *exact, unique OIDC subject* into `User.oidcSubject` and ensure an active matching `SiteRoleAssignment` (both tied to the designated staff user). There is no just-in-time self-registration. Treat manual provisioning as a temporary development-only process; admin enrollment, offboarding and independent approval workflows are **not** implemented.
5. Run the normal schema migration, seed, typecheck, and synthetic integration tests before use. HTTPS is mandatory except for local-loopback development. Never use real staff production credentials or PHI with this prototype.

### Auth endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/status` | Public mode information, no credentials |
| `GET /api/auth/login` | Begin interactive OIDC authentication |
| `GET /api/auth/callback` | Consume one-time state, exchange code, validate MFA and establish cookie |
| `GET /api/auth/me` | Current staff/site role and in-memory CSRF value |
| `POST /api/auth/logout` | Revoke active session and clear cookie |
| `POST /api/auth/lock` | Revoke session and require new interactive authentication |
| `POST /api/auth/site` | Switch to existing active site membership (audited) |

All workstation endpoints retain server-side authorization through the existing actor resolver; in OIDC mode it now requires a valid authenticated session, a current site membership, and role-specific permission. Authorization is rechecked for every request; disabling a user or grant denies subsequent access.

## Security review / known gaps

**No production startup:** `NODE_ENV=production` still fails closed unconditionally, even with `AUTH_MODE=production` and all environment values specified. Code and CI tests are not an authorization to handle real patient records.

Still required in Stage 3M: admin UI/API for explicit identity provisioning and lifecycle; named pharmacist-in-charge and inventory-specific roles; privilege override/elevation with expiry; designated second-person authorizations; account/group synchronization rules; provider-specific IdP conformance tests; login/endpoint rate limits and abuse monitoring; session lifecycle cleanup and retention; durable immutable security logs, escalation alerts and access review; stronger audit of failed auth events; proxy/TLS/headers and secret rotation runbooks; threat modeling, penetration test and **independent security review**.

Additional considerations before claiming production security: browser handling of cross-origin OIDC variations; verified deployment proxy trust configuration; token/key rotation behavior; interactive timeout and multiple open workstations; offline/desktop client boundaries; session concurrency / revocation in long-running operations; backup protection of authentication records; enterprise IdP logout semantics. Document and evaluate these as part of the remaining stage rather than silently assuming they are complete.
