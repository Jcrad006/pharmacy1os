# Python parity increment 49 — versioned, auditable synthetic COB payer attempts

Follows [Increment 48](PYTHON_PARITY_PROGRESS_INCREMENT_48.md), narrowing audit BL07/BL09 and preparing for repeated payer-position payments without erasing earlier claim history.

## Implemented

- New append-only models `SyntheticCobAttempt` and `SyntheticCobAttemptReversal` with unique original paid transaction, unique claim/attempt version, unique reversal transaction, immutable request SHA-256, site, claim, fill, COB coverage position, original actor/timestamp.
- In the existing synthetic claim preparation/reversal transaction, record the canonical `BILL` or `REVERSE` event **and** its versioned attempt/reversal link atomically. Attempt 1 is recorded for every new synthetic paid claim; no real payer communication and no repeated adjudication is enabled yet.
- New Alembic revision `a8c9f01d724b`, building two separate `py_*` tables and **backfilling existing original synthetic BILL/REVERSE events** from actual immutable transactions. Corrupt/orphan/duplicate predecessor records cause migration failure rather than inventing an authorization or falsely successful reversal. The original Prisma schema is untouched.
- `CobAttemptRegistry.history` reconciles claims with every original BILL/REVERSE event, original request SHA-256, claim position, physical and payer-intended quantity, payer name, site ID, contiguous version number, duplicate-active protection, and reversal ancestry. Missing mirror events fail closed. Returns only sandbox identifiers/statuses, not member IDs, real authorizations or payer receipts.
- Synthetic API `GET /api/third-party/fills/{fill_id}/cob-attempts` and Qt `View Versioned COB Claim Attempts` expose the immutable timeline.
- Tests: 3-position first-attempt lineage, 2-position full reversal/replay, idempotency, site authorization, hash/incomplete history corruption, database uniqueness enforcement, cash-only fills, and migration backfill of a database with prior local paid+reversed events; migrated PostgreSQL/SQLite checks remain required.

## Incomplete parity
This adds **versionable persistence** and validation but no live multi-attempt claim submission. `ClaimOperation` still has a per-claim unique operation rule, and the deterministic synthetic `BILL` key still permits only one paid event per claim. A later increment must carefully introduce a new per-attempt local billing event and selective reversal/re-adjudication state machine, ensuring no partial COB claims can pass pharmacist verification. The existing full-chain reversal/rescan path remains supported and fully audited. No live insurer, point-of-sale monetary calculation, or production dispensing. PR #43 remains draft.
