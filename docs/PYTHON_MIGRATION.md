# Python-native Pharmacy1OS migration

**Status: initial runnable synthetic migration slice. Not a full port or production release.**

The current TypeScript/React/Fastify/Prisma system remains the authoritative implementation until module-by-module equivalence is shown. This Python implementation is an isolated replacement track; it does not modify existing records. No patient PHI, live dispensing, controlled-substance processing, claim transport, or real-world pharmacy use is permitted.

## Target architecture

- **Python desktop:** PySide6/Qt with native widgets and F1–F10 workstation routing; no Chromium, React, JavaScript runtime, or localhost API required for interactive work.
- **Python core:** service layer, explicit role checks, audited transactional state changes, decimal quantities, independent API/GUI boundaries.
- **API:** FastAPI adapter, deliberately disabled by default; synthetic development actor headers **are not authentication**.
- **Persistence:** SQLAlchemy schema under isolated `py_` tables. The proof-of-concept uses local SQLite; production target remains PostgreSQL plus reviewed Alembic migrations and migration/rollback tooling. It is not yet compatible with the existing Prisma tables.
- **Testing:** pytest synthetic domain/API contract tests; eventually property, concurrency, hardware, PostgreSQL, GUI, and failure-injection suites.

## Implemented in this slice

- Native PySide6 desktop launcher, route shortcuts and data listings, functional registration/receiving/prescription/dispensing actions.
- Synthetic patients and providers; drug catalog with multi-NDC products and corrected/registered product barcodes.
- Receiving and on-hand/reserved stock accounting with database constraints.
- Prescription entry, Data Entry → DUR progression, date-rule checks, high-severity synthetic DUR gate, role checks.
- Up to four physical sources per fill, valid NDC/lot/expiry matching to selected drug, quantity reservation and verification.
- Fully distinct bottle-label records by physical source; highest quantity first.
- Synthetic coordination-of-benefits claims with up to four payer entries; synthetic full-billed quantity for partials (not a verified live-payer requirement).
- Pharmacist-only final verification; Will Call bag/bin staging; identity/signature/bag-confirmed pickup; unsold return-to-stock reversing sandbox claims, retaining prior attempt history.
- Append-only action audit events and per-site queue segregation in Python service.
- FastAPI routes for the implemented flows; fail-closed when synthetic demo mode isn't enabled.

## **Still missing; DO NOT claim parity**

1. **Database compatibility:** migration of all Prisma schema tables (including legacy data preservation, constraints, indexes, triggers, site scoping) into SQLAlchemy/Alembic; correct transactional locking and multi-client PostgreSQL behavior.
2. **Full user flows:** scheduled refills, holds/resume/cancellation/transfer, nuanced emergency/partial completion, return-to-stock exceptions, clinician notes, sophisticated inventory operations (POs, recalls, transfers, cycle counts, quarantine, traceability, inventory planning), label printing hardware, GS1 parsing and scan device service.
3. **Financial integration:** payor profile versioning, actual NCPDP transport, payer reversal acknowledgments, multiple-payor COB ordering nuances, reconciliation, real POS tender and payments, refunds/voids/accounting.
4. **Documents:** immutable prescription vault, encryption/hashes, provenance-rich visual annotations, fax/eRx message ingestion/rendering, durable backup/restore and retention.
5. **Production identity:** secure OIDC/MFA, site-scoped roles, sessions/revocation, staff lifecycle, two-person approvals, audit integrity, rate limits/TLS/secrets/monitoring.
6. **Clinical/compliance:** policy-engine validation and human professional review, EPCS, controlled inventory, North Carolina-specific legal rules, DSCSA, production claims/legal readiness.
7. **Formal engineering:** security threat model, dependency locking/SBOM, GUI automation, fault/concurrency load testing, packaging/installer code-signing, migration verification, deployment/restore drills.

These are mandatory migration phases, not enhancements that can be skipped. The `3M` security work on the TypeScript mainline should not be overwritten or conflated with this isolated Python branch.

## Run the synthetic Python preview

```bash
cd python
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[desktop,test]'
PHARMACY1OS_SYNTHETIC_DEMO=1 pharmacy1os-desktop
pytest -q
```

The desktop writes **synthetic-only** data to `~/.pharmacy1os/synthetic/pharmacy1os.sqlite3` and provides role-switching demo identities. Role-switching is intentionally insecure, so **do not use with real patient information**.

For an optional local development API:

```bash
PHARMACY1OS_SYNTHETIC_DEMO=1 pharmacy1os-api
```

The API listens only on `127.0.0.1:8008` and is disabled unless the explicit development flag is set. It uses `x-demo-staff-id` only for synthetic test fixtures. Production authentication is not implemented.

## Release gates for replacing legacy modules

For each legacy module: preserve a documented API/domain contract; port edge cases including negative paths; compare synthetic results against the existing implementation; run database, GUI and concurrency tests; conduct pharmacist review of safety-sensitive transitions; migrate/rollback data on a disposable PostgreSQL copy. Only then remove the corresponding TypeScript/React code. Keep the existing app intact until all covered workflows pass.
