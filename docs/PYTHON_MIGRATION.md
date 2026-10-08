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

## Third migration increment — advanced inventory operations (2026-10-08)

The Python rewrite now includes **synthetic development counterparts** for purchase orders, intersite inventory transfers, physical cycle counts and recalls in `pharmacy1os/inventory_advanced.py`, backed by SQLAlchemy tables and FastAPI/Qt interfaces. Legacy TypeScript code and the live-shaped Prisma schema remain untouched.

### Converted functionality

- **Purchase orders:** one or more unique products per order; partial and complete receipts by NDC/lot/expiration; invoice references and append-only receipt/movement/audit records; over-receipt prevention and pharmacist-only cancellation of remaining unreceived quantities. Canceling an order does not undo quantities already received.
- **Site transfers:** pharmacist-controlled outgoing shipments and cancellations, technician receipt at the destination site, preservation of product/lot/expiration provenance, single terminal disposition, per-site audit and stock movements. Transfers cannot ship reserved, quarantined or recalled stock; a canceled in-transit shipment restores the source stock and re-quarantines affected units if a recall became active during transit.
- **Cycle counts:** technician/inventory-staff counts, immutable baseline and movement-count capture, submitted review state, all-or-nothing pharmacist review, stale snapshot rejection, and explicit prohibition on reducing on-hand below reserved plus quarantined quantities.
- **Product recalls:** NDC-wide or lot-specific site-scoped recall cases; quarantine of available stock; explicit blocking during Product Fill, final verification, and Ready-fill checkout; automatic quarantine of newly received, canceled-transfer and unsold returned units; pharmacist closure with quarantine retained until separately reviewed; historical READY/SOLD fill-exposure linkage.
- **Qt workstation:** new F11 `Supply Chain` work area, with basic dialogs for orders, transfers, counts and recalls. Qt still requires hands-on graphical testing; compilation alone is not a working-hardware validation.
- **FastAPI:** synthetic CRUD/workflow routes for these four domains. Production API remains blocked without real authentication; header-selected demo identities are not secure identities.
- **Synthetic demo schema upgrade:** SQLite `create_schema()` now recognizes the one new nullable `py_inventory_holds.recall_id` column and upgrades a *synthetic-only* local database. No old Prisma/PostgreSQL schema is migrated.

### Verification and gaps

The synthetic Python regression suite has **32 passing tests** on this increment, covering order and transfer safety, stale counts, recall gating and exposure history, user/site isolation, API, and the earlier dispensing/document functionality. Python modules compile. **PySide6 was not installed in the build container**, so the native GUI has not received a runtime smoke test. No PostgreSQL concurrent-client/load or migration testing has been performed.

This is **not full parity** with the TypeScript inventory system: supplier receiving discrepancy workflows, locations/stock positions, FEFO planning, purchase-order idempotency, advanced custody event records, serialized DSCSA traceability, and all external/hardware integrations remain outstanding. In particular, SQLite demo transaction behavior does not establish race-free production operation or regulatory compliance. Use only synthetic data; do not merge over the working TypeScript application.
