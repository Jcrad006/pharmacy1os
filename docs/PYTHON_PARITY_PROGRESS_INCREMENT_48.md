# Python parity increment 48 — selective COB safety preflight and complete open-issue lookup

Builds on [Increment 47](PYTHON_PARITY_PROGRESS_INCREMENT_47.md) in draft [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43).

## Implemented
- New read-only `CobCorrectionPlanner.plan` validates an intact two-to-four payer chain before selective correction. For selected position `N` it returns downstream-first reverse order `last → N`, replay dependency order `N → last`, untouched upstream positions, exact original BILL transaction IDs, masked/synthetic-safe data, and explicit `action_enabled=false`. Validates pharmacy boundaries, prepared-only state, chronological claim/coverage positions, original paid-request SHA-256, quantities, payer names, missing/duplicate/reversed transactions, and unprinted test labels.
- Native Third Party menu exposes the plan, and synthetic FastAPI adds `GET /api/third-party/fills/{fill_id}/cob-correction-plan?target_position=N`.
- Pharmacist `verify` now refuses inconsistent claim statuses or local reversal transactions on an otherwise prepared fill, before consuming inventory. This prevents dangerous manual or corrupted intermediate payer states from reaching READY.
- Third Party activity and issue queues no longer infer active claim status solely from the last 300 transactions. Reversal/clear/retry links for visible rows are fetched from full site-scoped history. A separate, site-scoped SQL NOT EXISTS query returns up to 100 **currently open** mock rejection issues even if their original events are far older than the recent activity page; adds a truncation flag.
- Added synthetic regression tests for plan ordering (1–4), permissions, API gates, tampered paid requests, printed labels, reversed claims blocking verification, and rejection history beyond the 300-event activity cap. No schema migration required.

## Limits and next step
This is a prerequisite **planner only**, not executed per-position re-adjudication. Python's original Claim/ClaimOperation transaction model cannot yet safely represent repeated paid/reversed cycles per payer position; adding a partial-reversal button before a versioned immutable transaction model would leave non-reversible or incorrectly paid claims. Next increment should add versioned COB payer attempts and an atomic selective reprocess lifecycle, with PostgreSQL concurrency and fail-closed verification. None of this is a real payer transaction, printer confirmation, or clinical/professional validation. Keep draft; never process real prescriptions.
