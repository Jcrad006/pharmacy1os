# Pharmacy1OS Python — synthetic-session authentication increment

**Development/test-only. Do not deploy with real patient records or to a shared network.**

The previous API accepted `x-demo-staff-id` as an impersonation header. Existing automated legacy tests still call `create_app(synthetic_enabled=True)` in explicitly labeled **demo mode**. A new opt-in `create_app(..., auth_mode="session", synthetic_enabled=True)` removes that shortcut for every protected endpoint. All existing FastAPI workflow routers reuse one verified `Actor` derived from the bearer session and validated against current staff role, site and active status on every request.

## Model

- One site-scoped username/password credential per active `py_staff` row. Usernames unique case-insensitively, normalized lowercase. Passwords use per-user random salts and scrypt; the database never stores cleartext passwords.
- Cryptographically random bearer secrets with only SHA-256 digests stored. Sessions expire at eight hours, have a 30-minute idle cutoff, and are revoked on logout, password rotation, and deactivation; each request rejects sessions when staff role or site no longer matches the login snapshot. The service uses database transactions, with `FOR UPDATE` when PostgreSQL supports it.
- After five incorrect passwords, the account is blocked for 15 minutes with a persistent failed-attempt counter. Login rejects nonexistent users with a generic error. These are simple synthetic safeguards, **not** distributed rate limiting, MFA, secure identity proofing, device binding, TLS termination, centralized logging, or hardened production auth.
- Only a synthetic `ADMIN` can enroll or disable other staff accounts. One-time initial admin enrollment requires an offline CLI, an already migrated isolated absolute-path SQLite DB and explicit safety confirmation; no HTTP bootstrap or self-registration route.
- New tables `py_auth_credentials` and `py_auth_sessions`, on additive Alembic revision `a7e4c129ad67`. Legacy TypeScript/Prisma tables are never touched.

## Synthetic operator flow

Prepare a **synthetic** SQLite database with Alembic migrations, a synthetic site and test staff. Stop the demo server, then:

```bash
export PHARMACY1OS_SYNTHETIC_DEMO=1
export PHARMACY1OS_DATABASE_URL=sqlite+pysqlite:////absolute/path/to/synthetic.sqlite3
pharmacy1os-auth initial-admin --site-id <site-uuid> --username operator.admin --confirm SYNTHETIC_OFFLINE_ONLY
```

The CLI reads the password twice from a non-echoing terminal; do not pass it on the command line. The bootstrap action is permitted only if **no** synthetic credentials have been enrolled. API session mode is activated programmatically with `create_app(..., synthetic_enabled=True, auth_mode="session")`; the normal `pharmacy1os-api` development entry point stays demo mode pending explicit integration.

`POST /api/auth/login` accepts username/password and returns a bearer token for a synthetic test user. Pass `Authorization: Bearer <token>` to all workflow endpoints. `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/password`, `POST /api/auth/admin/enroll`, and `POST /api/auth/admin/disable/{staff_id}` are provided. Authentication errors return generic `401`; admin access failures return `403`. The client must keep the bearer token private and discard it on logout.

## Not yet production ready

No production credential lifecycle, MFA, password reset, transport TLS/certificates, identity federation, audit-event tamper protection, device trust, HIPAA security risk analysis, or hardened/validated Qt session storage. Existing synthetic workstation identity selection and demo API header mode remain deliberately labeled as untrusted. Authorization must eventually be verified under concurrent PostgreSQL workstations before migration of real users or dispensing operations.
