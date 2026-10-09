# Python parity increment 22 — synthetic claim transactions and rejection workspace

**Branch:** `python-native-rewrite`. **Reference baseline:** [138-feature audit](PYTHON_PARITY_AUDIT_2026-10-08.md) and [Increment 21](PYTHON_PARITY_PROGRESS_INCREMENT_21.md). The original TypeScript program remains untouched. All payer interactions described below are **local synthetic test operations**, not real pharmacy billing.

## Changes made

1. **Permanent request/response ledger** — `py_sandbox_claim_transactions`, represented by `SandboxClaimTransaction`, stores site, fill, optional claim/payer/coverage reference, original transaction reference, operation, simulated outcome, request and response snapshots, request SHA-256, unique idempotency key and authenticated development actor ID. These are append-only in the domain service. Hashes detect request alteration when records are read; this is **not** a cryptographic chain, immutable/WORM database or production audit guarantee.
2. **Synthetic billing events** — Every new sandbox `PAID_SYNTHETIC` claim made by `prepare_for_review` records a `BILL` event containing the selected NDC, coverage and payer identities (or explicitly unlinked legacy metadata), full payer-intended quantity, physical quantity, source lots and current payer profile snapshot. The response explicitly has **no real payment authorization, adjudicated amount or patient responsibility**. Reversal records a separate `REVERSE` event pointing to the original `BILL` event. Old synthetic claims missing the new history are marked as legacy/unlinked, not backfilled with fabricated provenance.
3. **Rejection workbench** — A pharmacist/admin may inject a clearly named `TEST_70`, `TEST_75` or `TEST_79` **development-only rejection** against a selected patient's coverage. A duplicate idempotency key with an identical request returns the first record; conflicting content is rejected. Unresolved `TEST_REJECT` events block *both* new coverage-linked and legacy sandbox fill preparation before any new labels or paid synthetic claims are created. A pharmacist/admin can add a separate `TEST_RESOLVE` event with a documented review note. This **clears a local test hold only**; it never marks the claim approved by an insurer.
4. **Stable payer-profile links** — Existing `PayerBillingProfile` revisions can now optionally record `payer_id`. A supplied ID must refer to an active payer at the same pharmacy site with the matching name. When a canonical payer exists, billing looks for an active payer-ID-bound profile first; old name-only profiles remain accepted for historical synthetic compatibility. No legacy payer profile is silently assigned to a payer.
5. **Native desktop and FastAPI** — The Third Party Qt page exposes a synthetic rejection queue, deliberate simulated rejection injection, pharmacist-reviewed test hold clearance and request/response history alongside previous payer/coverage actions. FastAPI includes:
   - `GET /api/fills/{fill_id}/claim-transactions`
   - `GET /api/third-party/test-rejections`
   - `POST /api/third-party/test-rejections`
   - `POST /api/third-party/test-rejections/{rejection_id}/clear`
   The existing profile-creation route accepts an optional `payer_id`.
6. **Migration and schema registration** — Additive Alembic revision `e48f2d6a47cb`, following `d1c21b5981aa`, adds the ledger and nullable payer-ID profile FK. All new tables begin with `py_`; no legacy Prisma tables are changed. `db_cli.verify_mapped_schema` now imports **all extension SQLAlchemy models**, correcting a discovery gap in previously incomplete schema checks. SQLite creates the nullable FK inline because generic ALTER CONSTRAINT is unsupported.
7. **Regression tests** — `python/tests/test_claim_transactions.py` exercises complete paid/reversed event lineage, reject/clear holds before labels, pharmacist authorization and site isolation, idempotency, request SHA protection, legacy name-only path, payer-bound profile selection and synthetic API gating.

## Audit gap impact

| Original gap | Increment 22 advancement | Still missing |
|---|---|---|
| BL03 payer billing profiles | Canonical payer ID linkage; versioned rule records | Original complete payer rule set and administrative forms |
| BL06 rejection queue and retry | Simulated reject queue and audited pharmacist local hold resolution | Genuine adapter-driven claim rejects, coverage correction, submission retries |
| BL07 claim request/response | Snapshots and audit of every *new* local synthetic bill/reversal; null real authorization/payment fields | Full original ClaimTransaction data, authorization/reject response semantics, certified transport |
| BL09 manual reversal | Append-only local reversal linked to original synthetic payment via existing RTS/cancel flows | Independent payer-switch reversal and rebilling |
| BL11 external outbox | No work in this increment | Genuine outbox/idempotent network adapter |
| UI07 insurer/rejection workspace | Qt buttons and readouts for local simulated rejects | Full original React form parity |

## Critical safety boundaries

- **No live NCPDP switch, insurance eligibility lookup, COB payment coordination, prior authorization, payer-specific rejection parsing or real payment calculation.** All event types explicitly say synthetic.
- An operator manually injecting a test rejection is **not** evidence an insurer rejected anything. Clearing the hold is **not** an approval.
- The ledger does not store raw patient coverage member identifiers or DOB in its request/response JSON. Existing `ClaimCoverageSnapshot` stores an internal synthetic member-ID snapshot for historical reconciliation; API representation masks those identifiers.
- Database `create_all` creates fresh synthetic schemas only; existing SQLite deployments need reviewed Alembic upgrades and backups. Never point tools at a live pharmacy or legacy Prisma database.
- The original TypeScript implementation is preserved and the Python rewrite **still fails overall full-parity acceptance**.

## Next parity priorities

1. Introduce a deterministic *external-adapter interface* with a fake payer that rejects/accepts by fixture (instead of manual injection), then stage and resume entire coordinated synthetic COB; design safe per-coverage retry/reversal snapshots before any real switch.
2. Rebuild warehouse location, stock-position, inventory allocation/FEFO, open demand/backorders and inventory exception/reconciliation entities.
3. Complete data migration and test vectors from Prisma, full native Qt screen parity and production security/hardware boundaries.

**CI sign-off:** Consult the exact latest branch commit's Python 3.12/3.13 and PostgreSQL/SQLite workflow outcomes before declaring this increment green.
