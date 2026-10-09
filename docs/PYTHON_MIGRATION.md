# Python-native Pharmacy1OS migration

**Status: multi-module Python synthetic rewrite underway; no feature parity or production release.**

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
2. **Full user flows:** basic hold/resume/cancellation and quarantine/ledger now partly ported; still missing scheduled refills, transfer, nuanced emergency/partial completion, return-to-stock exceptions, clinician notes, advanced inventory (POs, recalls, transfers, cycle counts, traceability, planning), label printing hardware, GS1 parsing and scan device service.
3. **Financial integration:** payor profile versioning, actual NCPDP transport, payer reversal acknowledgments, multiple-payor COB ordering nuances, reconciliation, real POS tender and payments, refunds/voids/accounting.
4. **Documents:** core immutable vault, optional authenticated encryption, hashes, versioned visual annotation/provenance and simple synthetic SVG rendering are now partly ported; still missing structured change apply/review parity, scanner/PDF/TIFF UI, actual fax/eRx ingest, coordinated backup/restore, retention and complete multi-site durability.
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

## Second migration increment — documents, inventory ledger and lifecycle (2026-10-08)

**Synthetic Python implementation added on the same migration branch:**

- Native Python prescription source vault (`documents.py`): size/MIME allowlist, filesystem-exclusive original writes, source SHA-256, optional AES-256-GCM using the legacy `P1DV1` binary envelope (`magic + nonce + auth tag + ciphertext`), site authorization and checked reads; failures in metadata insertion remove newly created source files. Source files are NEVER rewritten by annotations.
- Separate `DocumentAnnotation` and `DocumentChange` tables, normalized opaque rectangle coordinates, required visual text plus change type/what/why, communication and prescriber provenance, and immutable historical rows with explicit `ACTIVE`/`SUPERSEDED` version state. **The annotation does not yet apply structured prescription changes.** The port does not claim complete equivalence with the existing TS prescription-change apply/review workflow.
- HTML-escaped synthetic electronic-prescription SVG rendering from structured fields, without live eRx transport, signature validation or source authentication. Direct arbitrary SVG uploads are blocked.
- New per-stock append-only `InventoryMovement` records with before/after snapshots and atomic inventory mutations during receiving, Product Fill reservation, pharmacist verification, return-to-stock, manual pharmacist adjustment, quarantine and release/disposal.
- Technician quarantine with a required reason; pharmacist-only release or disposal; hold disposition history and site checks. These are initial counterparts, **not a port of the original comprehensive recall/DSCSA/purchase-order/cycle-count/transfer services**.
- Synthetically safe prescription hold/resume/cancel transitions, including reservation release, reversals of synthetic claims, and return of unsold verified inventory when cancelled. Live payer reversals and regulated cancellation rules remain out of scope.
- New FastAPI endpoints for document upload/read/history/annotations, inventory movements/holds/adjustments and prescription hold/resume/cancel. The API remains disabled except in explicitly opted-in synthetic mode.
- Desktop buttons and a native Qt graphics-view annotation prototype for image/SVG formats, with drag-to-select opaque rectangles and separate prompted provenance. PDFs and TIFFs remain securely stored but do **not** have native page-annotation preview in the Python UI. PySide6 graphical testing remains outstanding.
- Dedicated negative-path tests for bad keys, tampered originals, tenant isolation, version supersession, unauthorized staff actions, over-reservation, irreversible stock disposal and claim reversal. **18 Python tests pass locally** (previous 7 plus 11 added).

### Explicit migration and deployment caveats

1. The SQLAlchemy `py_` tables are a distinct *prototype schema*. `create_all()` can create newly added tables on a synthetic database, but no Alembic migration or legacy Prisma data import has been performed. No use with real PHI.
2. Filesystem and SQL commits are not a distributed atomic transaction. Failed SQL writes perform best-effort file cleanup; crash-reconciliation, coordinated backup/restore, retention, orphan detection and a write lease are **not** implemented. Keep the original TypeScript coordinated-vault backup subsystem until equivalent durability is demonstrated.
3. Optional encryption without a configured key is only a synthetic demonstration setting. A production design must require encryption, controlled key management and tested recovery. Legacy on-disk `P1DV1` envelope compatibility is format-level only; a cross-language round-trip fixture has not been executed.
4. SQLite stock locking, multi-workstation concurrency, idempotent commands, service restart behavior, and direct cross-site relational constraints have not been demonstrated as production safe. Current balance checks do not replace PostgreSQL locking, triggers and independent concurrency tests.
5. The initial Python domain is **not** feature-equivalent with the TypeScript application. No old modules or old database tables have been removed; do not merge/replace the TypeScript application yet.
6. Existing Python local tests cover the listed synthetic behavior; they do not establish clinical suitability, compliance, external claims or hardware readiness.

## Third increment — Python inventory operations (synthetic)

A further isolated Python port implements purchase orders, cross-site transfers,
cycle counts, and recall quarantine/follow-up. The authoritative TypeScript system
still remains unchanged.

| Workstream | Implemented in Python | Important deferred parity |
| --- | --- | --- |
| Purchase orders | Unique per-site references, multiple product lines, partial receipts by lot/expiration, invoice records, over-receipt rejection, cancellation authority and audit | Wholesaler EDI, invoice matching, reorder policy, authoritative supplier catalog, robust retries/idempotency |
| Transfers | Source shipment from uncommitted usable stock, in-transit record, destination receipt with lot/expiration, origin cancellation with ledger restoration, site-specific authorization | Two-person custody, shipping proof, serial/DSCSA trace linkage, actual carrier discrepancies, PostgreSQL concurrency drills |
| Cycle counts | Physical count entry, submission, independent pharmacist reconciliation/rejection, movement-sequence stale-count rejection, transaction-atomic multi-line validation | Full count-session management, handheld hardware, stock-position segmentation, comprehensive scheduled reconciliation |
| Recalls | NDC/product or specific-lot cases, automatic quarantine of usable stock and subsequently received/returned stock, pharmacist verification/sale/scan block, persistent quarantine after closure, synthetic sold-fill exposure links | Patient outreach tasks, recall notices from trading partners, DSCSA product-level verification, controlled clinical review |

**Integrity boundary:** A stock transfer, PO receipt, quarantine action, or cycle-count
reconciliation produces movements in the same transaction as its balance change.
All protected mutations require the synthetic site/role permissions. Real
multi-user concurrent safety is **not established** by SQLite tests; the SQLAlchemy
select-for-update calls require a PostgreSQL target, DB-level idempotency,
transaction isolation review, and race/load/fault tests before release.

**Local demo schema compatibility:** `create_schema` creates new `py_` inventory
tables and adds the nullable `recall_id` reference to an existing SQLite
`py_inventory_holds` demo table if absent. This is a narrow synthetic upgrade,
**not an Alembic migration or a conversion of any legacy Prisma data**. Never
point it at a production pharmacy database. The initial Python schema and this
version must ultimately be handled by reviewed, reversible Alembic changes.

**UI/API:** The F9 native Qt inventory screen exposes a supply-chain operations
dialog (POs, transfers, cycle counts, recall cases). Matching FastAPI development
routes are provided. The Qt window has passed Python compilation but not an
interactive display/hardware smoke test in this environment.

**Verification:** `python -m pytest -q` ran 29 synthetic tests successfully
(including 11 additional inventory tests). All Python source modules compiled.
No live claim service, external eRx, prescribing legal rules, authentication,
EPCS, DSCSA certification, shared-network deployment, or real PHI permitted.

## Seventh Python increment — scheduled fills and synthetic payer profiles (2026-10-08)

Ported transaction-bound scheduling/refill review, an explicit due-date/DUR safety gate, per-site schedule idempotency, versioned per-payer billing profiles, physical source/NDC claim snapshots, and append-only application-level synthetic paid/reversed claim events. New isolated Alembic revisions follow the provider-directory migration; FastAPI endpoints and Qt controls are included. This is **NOT** a full Python conversion or production release. See `PYTHON_SCHEDULING_BILLING.md` for functionality, limitations, and test evidence. Continue preserving the TypeScript reference and legacy Prisma records.


## Tenth Python increment — synthetic refill eligibility and sale timestamps (2026-10-08)

Added `pharmacy1os/date_rules.py` and a separate audited, site-scoped date-policy service, new sale-time events from both single-fill checkout and multi-fill POS, FastAPI endpoints, and native Qt controls. A pharmacist may configure a minimum 0–365-day synthetic interval between fills and must record the reason. The start-fill transaction, scheduled-fill creation/starting, pharmacist verification, pickup and active-fill resumption all reevaluate eligibility. Existing expiry and do-not-fill-before rules remain. A previously SOLD fill without a verified pickup timestamp now blocks interval-based refill processing until the record has been safely reconciled; the program never invents a historic sale time.

Additive Alembic revision `84a672dc47f0` creates only Python-owned `py_*` tables. Data in the original TypeScript/Prisma application is untouched. Local pure-rule validation passed; full GitHub Python/PostgreSQL regression checks are required. See `PYTHON_DATE_RULES.md`.

**Not full parity or safe for clinical production**: native desktop UI has not passed hands-on GUI validation, clocks/timezones need pharmacy-local policy design, old data must be migrated/validated, and no legal/payer or controlled-substance refill timing is inferred. Production identity, dispensing concurrency, hardware, eRx, payer communications, and regulated backup/recovery remain unfinished.


## Python offline synthetic backup and vault integrity (2026-10-08)

Implemented a **new, offline-only** Python CLI for isolated SQLite test databases and immutable prescription document sources. It captures a SQLite backup-API snapshot, verifies and copies raw stored vault payloads, produces and HMAC-signs a manifest, and only publishes the stage after self-verification. It refuses corrupted/missing/orphaned documents, unexpected links, and ambiguous/invalid source metadata; encrypted sources remain encrypted in the backup. The CLI requires a signing secret and explicit operator confirmation that application writers are stopped.

**This does not implement production recovery**, online/write-coordinated backups, PostgreSQL `pg_dump`, offsite key custody, a restore operation or a live HTTP backup route. Never point it at real pharmacy data. See `docs/PYTHON_BACKUP_INTEGRITY.md` for operator usage, data boundaries, and limitations.


## Offline synthetic PostgreSQL archive & new-path SQLite recovery rehearsal (2026-10-08)

Added `pharmacy1os-postgres-backup create/verify` for local **synthetic-only** PostgreSQL databases containing only Python-managed `py_*` tables and Alembic metadata, with exported REPEATABLE READ snapshots for `pg_dump --format=custom`, separate immutable document-vault hashes, signed HMAC manifest, and `pg_restore --list` catalog validation. Offline application shutdown is still mandatory: DB snapshot sharing alone does not coordinate filesystem writes. A compatible PostgreSQL client is required and neither passwords nor encryption keys are stored in the archive.

Added `pharmacy1os-recovery rehearse` to verify a prior **SQLite** archive and create a completely separate, unused database file and vault directory; it uses no-clobber file creation and a recovery journal. It refuses active or pre-existing destinations and provides no PostgreSQL restore, no in-place rollback and no production recovery capability. Never use real patient data. See `docs/PYTHON_POSTGRES_BACKUP_AND_RECOVERY.md` for constraints and commands. GitHub CI must confirm Python tests and PostgreSQL snapshot sharing.
