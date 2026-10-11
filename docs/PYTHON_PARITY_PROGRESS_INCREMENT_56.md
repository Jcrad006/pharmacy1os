# Python parity increment 56 — site-wide synthetic Third Party operational exception queue

Follows [Increment 55](PYTHON_PARITY_PROGRESS_INCREMENT_55.md) in draft [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43).

## Implemented
- New **read-only** `ThirdPartyExceptionQueue.snapshot` combines two important operational workstreams for the authenticated pharmacy site: every manually injected test rejection **without a completed test retry**, and every synthetic rebill replacement fill still awaiting physical rescan or pharmacist review.
- Test-hold states distinguish **OPEN_TEST_REJECTION** (needs pharmacist resolution), **CLEARED_AWAITING_RETRY** (resolution completed but no explicit pharmacist synthetic retry), and **RECONCILIATION_REQUIRED** (unexpected fill status or no longer matching test coverage). A cleared mock hold is *never* labelled as a real paid or accepted claim.
- Replacement states distinguish **REPLACEMENT_RESCAN_REQUIRED** and **REPLACEMENT_PHARMACIST_REVIEW**, validating previous fill retirement, attempt number, claim IDs, and zero active paid positions in immutable COB history.
- Includes bounded cursor-like offset paging (1–50 rows, maximum offset 10,000), status filtering, pharmacy-site access and privacy-minimized patient/Rx/coverage identifiers without member IDs, raw requests or response messages. Historical event request+response digests are validated before a work item is surfaced.
- Synthetic-only endpoint `GET /api/third-party/exception-queue?status=ALL&limit=25&offset=0`, plus the native Third Party menu action **Site-Wide Third Party Exception Queue**. These are worklist observations, not real payer requests, printer commands or dispense authorizations.
- Tests: test reject → pharmacist clear → explicit local retry; multiple outstanding holds with stable paging/filtering; cross-site and API disabled protections; anomalous fill status requiring reconciliation; rebill fresh-rescan through review lifecycle; altered historical mock response fails closed. No database migration.

## Remaining parity gaps
This improves original Third Party workflow **navigation and status visibility**. It does not implement NCPDP claim exchange, real payer reject/resubmit activity, actual financial settlement, or a production-grade interactive Qt claims grid. Counts are page-scoped and exceptions are synthetic-only. Keep the PR draft.
