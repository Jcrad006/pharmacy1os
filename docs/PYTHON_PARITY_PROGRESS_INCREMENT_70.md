# Pharmacy1OS — Increment 70: first executable Fastify-to-Python API parity baseline

**Baseline:** [October 10, 2026 feature audit](PYTHON_PARITY_AUDIT_2026-10-10.md) · **Original TypeScript main:** `1c7ae6e2e21288f1d95c69d53de99674180bd594` · **Target:** `python-native-rewrite` · Synthetic-only, not a clinical release.

## Concrete behavior corrected: GET /health

The original Fastify `apps/api/src/routes/health.ts` returns `200 / status: ok` only when its database probe succeeds and there is **no unresolved document-vault restore marker**. Otherwise it returns `503 / status: degraded`, with the keys `service`, `timestamp`, and `checks.database` / `checks.documentVaultRecoveryRequired`.

Until this increment, Python's `GET /health` always reported `status: ok`, even when the backing database could not be reached. That was a measurable behavioral divergence and could hide an unready synthetic server.

- `python/pharmacy1os/health_contract.py` now performs an actual database `SELECT 1` and checks the TypeScript-compatible local vault recovery marker `.coordination/restore-recovery-required.json` **by presence, including a malformed or unreadable marker**.
- The Python probe additionally detects its own unresolved **offline SQLite restore rehearsal journals** (`.pharmacy1os-recovery-*.json` next to the SQLite database file), and degrades on unsafe/unreadable recovery-marker paths. It does not clear or repair recovery state.
- `python/pharmacy1os/api.py` now returns the appropriate HTTP **200** or **503** with the original Fastify-shaped health fields, plus the original Python-specific `synthetic_only` and `enabled` booleans. Health remains accessible when the synthetic application API is gated off; that does *not* enable patient-facing endpoints.
- `python/tests/test_original_health_contract.py` tests normal responses, inaccessible databases, original recovery markers, Python interrupted recovery journals, symlinked coordination, disabled API status, and TypeScript-source contract assertions.

**Limit:** This provides a narrower health compatibility check, **not** the original TypeScript's complete backup/restore writer-lease coordination protocol or production readiness monitoring. It is deliberately synthetic-only.

## Permanent original API baseline and automated inventory

All **116 HTTP method/path registrations** from the 16 original TypeScript `apps/api/src/routes/*.ts` modules are frozen in `python/parity/fastify_routes_baseline.json`, with their source filename and original commit SHA.

`python/pharmacy1os/parity_inventory.py` performs two deterministic checks:

1. Re-extract the original `app.get/post/put/patch/delete` registrations from the TypeScript sources still present in the rewrite branch. The extraction **must exactly match the frozen 116-route inventory**, preventing silent baseline drift.
2. Inspect the *actual running FastAPI route registrations*, normalize only `/api` prefix and path parameter names, and distinguish `PATH_AND_METHOD_ONLY` matches from `NO_SAME_PATH_METHOD` gaps. The report also includes Python-only signatures. **A path match is NOT a request/response, permission, database, business-rule, or side-effect parity claim**.

Use from `python/` after installing the synthetic development dependencies:

```bash
python -m pharmacy1os.parity_inventory > original_python_route_crosswalk.json
python -m pytest -q tests/test_fastify_endpoint_manifest.py tests/test_original_health_contract.py
```

The CLI prints a JSON structural crosswalk, not patient information. The tests verify the frozen manifest and a small set of known matching and missing endpoints, including original system backup endpoints **not yet represented by equivalent Python API operations**.

## Remaining work

- Design true **golden request/response fixtures** for each route category with deterministic invented data on both runtimes. Route registration alone cannot establish functional equivalence.
- Crosswalk all **58 Prisma models** and migrations to the Python schema; no in-place transfer from the original database is currently supported.
- Audit high-impact missing HTTP workflows such as `/system/backups`, receiving, payer claims, POS and the original prescription status transitions. Keep unsafe external/regulated operations blocked until independently reviewed.
- Continue independent Python-native Qt E2E and PostgreSQL concurrency tests; no current source audit supersedes the original October 10 scores without a full reassessment.

**Safety:** No production usage, real patient data, insurer or prescriber network connectivity, regulated dispensing, or workflow certification. All tests are synthetic. The route inventory is intentionally conservative.
