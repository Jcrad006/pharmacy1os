# Python parity increment 42 — pre-verification reversal and fresh-rescan rebilling

**Branch:** `python-native-rewrite`. Extends [Increment 41](PYTHON_PARITY_PROGRESS_INCREMENT_41.md). Baseline audit targets **BL09**, **BL10**, **FL07** and **FL16** (partial; no production claims, hardware or original API contract parity).

## Changes

- New pharmacist-only `ClaimRebillService.restart` accepts the original fill and the exact expected 1–4 synthetic paid claim IDs in coordination order, plus a documented 12–1000-character reason. Locks the fill/prescription/claims/stock for PostgreSQL and rejects stale claim lists, second attempts, wrong sites, or invalid status.
- **Atomic reversal and replacement**: append reversal provenance for each synthetic claim; release all original physical stock reservations from the exact allocated bin; append allocation resolution; void unprinted synthetic label jobs; close unsold partial obligation and original inventory demand; mark the original attempt RETURNED and create a new PRODUCT_FILL attempt with the **same logical fill number**. New attempt has no sources, billed NDC, labels or claims; technician must scan physical products again and prepare mock claims. Claims/history/labels on original fill remain immutable and traceable.
- A new site-scoped `py_synthetic_rebill_links` row links original and replacement fill IDs, original reversed claim IDs, reviewer, reason and timestamp. Unique constraints prevent multiple replacement links; migration `c4b51a72d290` is isolated to the synthetic `py_*` track.
- Fail closed for print output-attempt history, prior verification or sale, malformed original claim operation provenance, linked emergency/completion fills or a concurrent active fill. Actual external payer reversal, paper label recovery, and production receipt are **not** claimed.
- FastAPI synthetic-only `POST /api/billing/fills/{fill_id}/restart-for-rebill`, read-only `GET /api/billing/fills/{fill_id}/rebill-lineage`, and native Qt Third Party restart/lineage actions.
- Regression tests: old/new COB history, distinct fill+claim IDs, physical vs authorized quantities, tracked location release, old jobs voided, role/site/stale-list/print guards, rollback if new attempt fails, synthetic-gated API. PostgreSQL row-lock behavior needs explicit CI.

## Important limits

This is **pre-verification** only; previously printed synthetic labels deliberately block automatic restart. It is not a claim retry against a live payer. This does not claim completed BL09/BL10 parity, original Prisma data conversion, certified inventory/label safety or production readiness. **Keep PR #43 draft and do not merge into production.**
