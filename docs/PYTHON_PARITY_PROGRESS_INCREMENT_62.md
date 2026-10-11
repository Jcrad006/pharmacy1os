# Python Parity Increment 62 — Separate-process authenticated loopback workstation

**Audit priority:** [October 10 updated audit](PYTHON_PARITY_AUDIT_2026-10-10.md), specifically PL03, PL04, PL07, PL11, UI02 and UI03. Branch `python-native-rewrite` / draft [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43).

## Delivered

- Added `LocalSessionWorkstationClient`: a **separate-process, stdlib HTTP** read-only client for an authenticated Python session API; supports synthetic login, `/api/auth/me`, bounded Rx queue, Rx detail, redacted audit events, and logout. It **never imports** SQLAlchemy or directly opens a workstation database.
- Enforces exact **127.0.0.1 only** HTTP origin, explicit unprivileged port, no URL credentials/path/query, no environment proxies, no HTTP redirects, 1 MiB JSON response size cap, 3-second default timeout, bearer token only in private client memory and automatic session clearing on HTTP 401. Never uses `x-demo-staff-id`, and never accepts mutating workflow commands.
- Added `pharmacy1os-loopback-desktop`: a PySide6 read-only queue/detail/audit window launched independently of the Python API process, with F1 refresh, F2 search focus, F3 detail, F4 audit and synthetic account login. It cannot scan, prepare, adjudicate, sell or write database records. Existing `pharmacy1os-desktop` and its local synthetic SQLite flows remain unchanged.
- Added `pharmacy1os-loopback-server`: a deliberately opt-in **localhost only** session-mode FastAPI launcher. Requires an Alembic-head synthetic SQLite/PostgreSQL database with correctly mapped schema and a previously enrolled offline synthetic account. No schema auto-create, public bind, demo headers, CORS or network service discovery.
- Added a real-socket Uvicorn loopback transport integration suite: synthetic login, per-site Rx isolation, server-side changes visible after refresh, API detail/audit projections, logout and revoked-token handling, forbidden off-host origins, invalid paths and disconnected server behavior.

## Isolated SQLite development walkthrough

From `python/` with Python 3.12+, using an **unused, synthetic-only** absolute SQLite path:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[desktop,test]'
export PHARMACY1OS_SYNTHETIC_DEMO=1
export PHARMACY1OS_DATABASE_URL="sqlite+pysqlite:////tmp/pharmacy1os-loopback-synthetic.sqlite3"
pharmacy1os-db upgrade
python -c 'import os; from pharmacy1os.service import PharmacyService; db=PharmacyService(os.environ["PHARMACY1OS_DATABASE_URL"]); print("Synthetic site ID:", db.bootstrap_demo()["site_id"]); db.engine.dispose()'
pharmacy1os-auth initial-admin --site-id YOUR_PRINTED_SITE_UUID --username pilot.admin --confirm SYNTHETIC_OFFLINE_ONLY
export PHARMACY1OS_LOCAL_SESSION_API=1
pharmacy1os-loopback-server
```

In a second terminal, with the same Python package and `PHARMACY1OS_SYNTHETIC_DEMO=1`:

```bash
pharmacy1os-loopback-desktop
```

You must first create some fictional records through the existing synthetic service or authorized development process; the new read-only window does not generate or edit patients.

## Distinct processes and database ownership

```
Qt read-only workstation (no DB)  ->  127.0.0.1:8008 (session API)
                                        |
                                 Python PharmacyService
                                        |
                            Migrated synthetic SQLite/PostgreSQL
```

The server process owns all database access. A second local Qt process can read the same freshly updated synthetic records through the API. PostgreSQL tests cover separate domain sessions but this is **not yet a remotely networked pharmacy client**. Port remains loopback only. The localhost-only HTTP bearer scheme must **never** be repurposed to a shared network; remote workstation deployment requires reviewed TLS, endpoint/identity verification, secure secrets, network hardening, proper authorization and much broader test coverage.

## Still required to close parity

1. Migrate actual authenticated **mutating** desktop workflows to server-side API commands with optimistic version checks, idempotent request IDs, stale-window prompts, complete mutation/audit and transaction fault tests.
2. Establish validated PostgreSQL server deployments, separation of backup/document storage, operational recovery and concurrency under crashes and disconnects.
3. Build per-screen native Qt interaction tests, Rx event/label source comparison, and the 116-endpoint old/new contract suite plus the 58-model data conversion harness.
4. Later and separately: actual production identity/TLS, payer/eRx/fax, printer/terminal hardware, regulatory checks and clinical validation.

**No parity re-rating is claimed by this increment. No PHI, production use, real payer transmission or dispensing.**
