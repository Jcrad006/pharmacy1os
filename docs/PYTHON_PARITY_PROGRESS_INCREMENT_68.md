# Pharmacy1OS — Python parity Increment 68: asynchronous workstation API and reviewed edits

**Branch:** `python-native-rewrite` · draft PR #43 · **Date:** October 11, 2026. Extends [Increment 67](PYTHON_PARITY_PROGRESS_INCREMENT_67.md) and the [October 10 refreshed parity audit](PYTHON_PARITY_AUDIT_2026-10-10.md).

## Scope and implementation

This increment addresses the native PySide6 UI responsiveness portion of UI02–UI03 and the safe-client aspects of PL03/PL11. It does **not** establish certified feature parity or a production networked pharmacy.

1. **Restricted `qt_workstation_worker.WorkstationRequestThread`:** an off-main-thread Qt worker with a typed dispatcher for only `queue`, `detail`, `audit`, `edit_context`, and `submit_review`. No raw URLs or generic method dispatch, no direct database access, no payer/fill/inventory/POS commands. Worker errors expose an HTTP status or generic error category, never captured SIGs, review notes or source content. The worker clears its copy of request arguments on completion.
2. **Native prescription browsing:** Qt queue refresh, status/sort searches, prescription detail and redacted audit history now run through this worker, returning results to explicit queued main-thread slots. The desktop coalesces an overlapping queue refresh rather than dispatching parallel requests through the same authenticated session. Other operations are ignored while a network request is in progress. No phantom or optimistic prescription write is shown.
3. **Two-stage reviewed-edit workflow:** an initial authenticated `edit_context` GET opens the original SIG/quantity/refill review dialog. After documentation and proposed changes, a **second off-thread GET** checks the version, workflow status and all previously displayed values. Only after a pharmacist confirms does the **main Qt thread** fsync a new UUIDv4 into the encrypted local request journal. If that pre-send write fails, no PATCH is launched.
4. **Off-thread idempotent mutation:** a single `submit_review` PATCH runs in a worker using the recorded request ID. The existing server independently authorizes the actor, locks the prescription, checks status/version and stores the edit/audit/receipt atomically. **No automatic retry** occurs if the network times out or a response is lost. A successful server reply is correlated with the exact request ID, and only the UI thread marks its journal entry RECORDED. Uncertain receipts remain PENDING for server GET-only reconciliation.
5. **Lifecycle safety:** request completion is applied only after the Qt worker emits `finished`—avoiding nested modal dialogs while a worker is alive. Closing the workstation during network processing is deferred; queued clinical submissions are discarded when a close is requested, and already journaled requests remain for later reconciliation. Receipt recovery and general workstation API workers cannot overlap. If an authenticated session expires, local editing controls remain disabled.

## Added coverage

- New `tests/test_qt_workstation_worker.py` exercises actual Qt GUI-thread timer progress during a delayed queue GET, queued delivery to UI-thread slots, permitted detail/audit/editor reads, exactly-one reviewed PATCH on simulated lost response, redacted failures, and denial of unapproved operations. Runs in offscreen Qt CI.
- Real local-socket tests in `tests/test_remote_preview.py` verify journal-before-PATCH semantics, independent server-side readback and refusal to confirm an unrelated request receipt.
- Existing `tests/test_workstation_recovery_async.py`, `tests/test_qt_recovery_worker.py` and PostgreSQL transaction tests continue to cover request receipt reconciliation and idempotency.
- The native Qt GitHub Actions job includes both receipt-lookup and broader workstation request-worker tests.

## Explicit limits and next steps

- The **initial login and final logout** currently use synchronous local HTTP; only the active native prescription queue/detail/audit/edit-context/review-PATCH flows were moved to workers. Other Qt screens in the original independent desktop remain local-service-driven. Startup authentication, progress UI, cancellation and device operations need further architecture work.
- There is **no cancellation of an already-dispatched reviewed PATCH**; closing simply defers until its bounded request completes, avoiding unsafe cancellation or duplicate submission.
- The pilot remains restricted to a **localhost-only synthetic API** with fictional patient/prescription data, separate local metadata encryption key and POSIX journal locking. It is not production TLS, KMS, multi-computer deployment, EPCS, eRx, live NCPDP or physical dispensing.
- This increment does not rescore the 138-item audit because adding guarded client transport is not proof of TypeScript field-level, endpoint or UI parity.

**Next proposed step:** Move startup/exit session traffic to a similarly bounded worker, implement a proper Qt end-to-end multi-step test with mocked workstation dialogs and interrupted network, and continue API/data-model differential parity work.
