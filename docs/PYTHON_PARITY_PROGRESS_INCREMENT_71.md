# Pharmacy1OS Python parity — Increment 71: restricted prescription status transition

**Branch:** `python-native-rewrite` · Draft [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43) · **Date:** October 11, 2026. Continues [Increment 70](PYTHON_PARITY_PROGRESS_INCREMENT_70.md) and the [October 10 audit](PYTHON_PARITY_AUDIT_2026-10-10.md).

## Direct comparison with the original TypeScript source

Original `apps/api/src/routes/prescriptions.ts` registers **`PATCH /prescriptions/:id/status`**, with a broad, role-dependent transition graph from `apps/api/src/workflow/prescriptionWorkflow.ts`. The original handler also handles product/inventory reservations, DUR issues, claim checks, pharmacist verification, refill state and controlled POS pickup guards. The prior Python API had dedicated hold, resume and cancellation actions, but **no original-style status PATCH endpoint**.

Directly exposing generic transitions in Python would risk bypassing these workflow-specific protections. Increment 71 instead introduces a deliberately **restricted, audited subset**. It is **partial compatibility**, not full TypeScript behavior.

## Implemented

- `python/pharmacy1os/prescription_status_parity_api.py` registers `PATCH /api/prescriptions/{rx_id}/status`, with the existing actor/site permission dependency and a typed request with `status`, documented `reason`, `expected_version`/`expectedVersion`, and `expected_status`/`expectedStatus`. These are **mandatory**, deliberately stricter than the original TypeScript status-only request. Unknown fields, booleans masquerading as version numbers, missing reasons and stale data fail closed.
- Only three classes of transitions are accepted: **(1) documented hold to `ON_HOLD`, (2) documented cancellation to `CANCELLED` with the Python lifecycle's existing inventory/claim/schedule safeguards, and (3) resume from `ON_HOLD` to the *exact previously held status*.** All other transitions are refused with HTTP 409. Notably, **READY → SOLD, PHARMACIST_REVIEW → READY, PRODUCT_FILL → PHARMACIST_REVIEW**, and generic `TRANSFERRED` cannot use this endpoint. Clients must use separately authorized fill, pharmacist verification, transfer, and POS workflows.
- `LifecycleService` now locks the site-owned prescription row inside its transaction (PostgreSQL `FOR UPDATE`), checks both stored workflow status and version against optional caller-supplied preconditions, and increments `Prescription.version` on **hold, resume and cancel**. These protections also apply to existing dedicated Python lifecycle methods even when the caller does not pass expected state. The existing domain service retains responsibility for stock reservation, claims, safety blocks and audit.
- Returns `{ "prescription": ... }` using the established read-only `PrescriptionDirectory` projection, excluding raw electronic prescription payloads and retaining synthetic-only restrictions.
- `tests/test_prescription_status_original_contract.py` proves documented hold/exact resume/cancellation with monotonically increasing versions, stale version/status refusal, site/role denial, invalid payload rejection, camelCase preconditions, no duplicate audit, and **no shortcuts around POS or pharmacist verification**.
- Real PostgreSQL test `test_parallel_status_hold_vs_cancel_obeys_row_lock_and_stale_version` in `tests/test_postgres_rx_idempotency.py` submits two competing status changes concurrently and requires one commit, one stale refusal and one audit entry. `tests/test_fastify_endpoint_manifest.py` now includes the method/path for this original Fastify route.

## Explicit remaining mismatches

**This endpoint is NOT fully equivalent to the original.** The TypeScript controller accepts many more status changes with extensive context-specific side effects and has a status-only body. Python's stricter payload is an intentional safety incompatibility. A matching HTTP verb/path in the structural route inventory must **not** be rescored as full behavioral parity.

No historical Prisma data was migrated; all work remains in the isolated `py_*` synthetic schema. No actual prescribing, NCPDP claims, hardware printing, controlled substances, clinical review, payment, or production dispensing is authorized. PostgreSQL concurrency tests exercise a disposable synthetic database only.

## Next steps

Continue detailed behavioral comparisons for original Fastify prescription queue/details, fill creation and status-dependent billing/product source guards. Expand deterministic TypeScript/Python response contract fixtures and 58-model Prisma crosswalk without weakening pharmacist checks. Validate GitHub CI for this increment before considering the limited adapter tested; do not update the 138-item feature audit without a full reassessment.
