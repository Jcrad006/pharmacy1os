# Pharmacy1OS Python parity — Increment 67: nonblocking native recovery

**Branch:** `python-native-rewrite` · Draft PR #43 · **Date:** 2026-10-10  
**Baseline:** [October 10 parity audit](PYTHON_PARITY_AUDIT_2026-10-10.md) · **Prior work:** [Increment 66](PYTHON_PARITY_PROGRESS_INCREMENT_66.md)

## The gap closed in this increment

Increment 66 added encrypted, persistent local metadata for synthetic reviewed-edit receipts, but its Qt buttons called recovery HTTP lookups synchronously. Each receipt could consume a network timeout and freeze the event loop, compromising usability and increasing the chance of operators dismissing uncertain work.

This increment moves **only read-only reconciliation HTTP traffic** off the Qt UI thread while retaining server-verified receipts, staff/site isolation, non-retry safety, and main-thread-only local journal writes.

## Implementation

- **`ReviewedEditRecovery.prepare_lookup`** (Qt/main thread) reads up to 16 pending request/Rx UUID pairs from the encrypted journal and produces a frozen `RecoveryLookupBatch` with account/site/origin scope. A manual selection can target either a pending or already recorded entry.
- **`ReviewedEditRecovery.lookup_receipts`** (Qt worker thread) performs exclusively authenticated **GET** requests to the existing receipt endpoint, reporting a minimal tuple of `RECORDED`, `NOT_RECORDED`, or `LOOKUP_FAILED`. It **does not touch the local journal**, collect prescription text, use the database, or perform PATCH operations.
- **`ReviewedEditRecovery.apply_lookup`** (Qt/main thread) rechecks the currently signed-in staff/site/server origin, validates **all** returned UUID pairings and results before updating any journal entry, then marks only proven `RECORDED` outcomes. `NOT_RECORDED` and failed network reads remain PENDING and **never authorize an automatic retry**. Only an explicit operator acknowledgement deletes a locally confirmed record. The original `reconcile()` remains as a synchronous compatibility wrapper for CLI/tests, but the native Qt path does **not** use it.
- **`qt_recovery_worker.RecoveryLookupThread`** is a separate, testable Qt QThread containing only the read-only receipt lookup. Unexpected exceptions produce a redacted generic error signal; credentials, reviews, and notes are never emitted as error text.
- **`desktop_remote_preview`** queues startup and manual batch lookups on this QThread; blocks overlapping checks and temporarily disables the reviewed-Rx save control while a recovery lookup runs. On a requested window close, the window defers closing/logout and journal release until the read-only worker finishes, avoiding destruction of an active QThread. It keeps the journal locked by the originating workstation process and never marks receipts from the worker thread.

## Tests added

- **Pure network/journal handoff** `tests/test_workstation_recovery_async.py`: deliberately slow network read with concurrent main-thread access to pending journal state, no writes until results are applied, unrecorded stays pending, frozen request snapshot, account switch rejection, entire batch identity validation before any update, bounded lookup, and unexpected network errors.
- **Real headless Qt event-loop** `tests/test_qt_recovery_worker.py`: waits on a synthetic slow server from the worker and asserts that a main-thread Qt timer continues firing. Verifies worker error signal is redacted and contains no simulated sensitive review text.
- **CI**: `.github/workflows/python.yml` runs the real Qt worker regression alongside native prescription tests with `QT_QPA_PLATFORM=offscreen`.

## Remaining risks / explicit non-parity

This work addresses **UI responsiveness and recovery isolation**, not live pharmacy readiness or complete parity. The desktop still performs **other** synchronous authenticated reads and the single reviewed mutation, so network interruption can still briefly block those UI actions. A future pass should migrate all remote operations to cancel-safe worker queues and implement deadline/identity handling. The journal's encryption key remains next to it in 0600 local files; it is **not production KMS**. The pilot is Linux/macOS POSIX-specific, authenticated on **127.0.0.1 only**, uses fictitious records, and does not implement full TypeScript UI workflows or central remote-workstation TLS architecture.

No real patient information, prescribing, NCPDP claims, payments, controlled dispensing, or external eRx/fax integrations are permitted. Do not interpret passing CI as production safety or exact compatibility with the original 116 APIs / 58 Prisma models.

## Logical next step

Move **all** authenticated workstation API reads and writes off the Qt event loop while preserving server authorization, request receipts, and cancellation-safe operation. Continue differential TypeScript/Python endpoint and data crosswalk tests against the original 138-item audit without overclaiming complete parity.
