# Python parity increment 39 — native prescription detail and reviewed editing

**Branch:** `python-native-rewrite`; continues [Increment 38](PYTHON_PARITY_PROGRESS_INCREMENT_38.md).
**Reference:** the original `PrescriptionDetail.tsx` and RX05, RX06, RX16, PL07, UI03 and UI13 in the [baseline parity audit](PYTHON_PARITY_AUDIT_2026-10-08.md).

## Implemented

- Replaced the prescription-detail and audit JSON message boxes with a resizable native Qt dialog. It displays patient/Rx identity, medication, source reference, refill usage, prescription fields, fill attempts, physical NDC/lot/expiration/quantity sources, synthetic claims, bottle labels, bag/bin custody, and an audit table.
- Added a pharmacist-reviewed editor for all ten existing editable Python prescription fields. Drug, prescribed NDC and prescriber changes can be saved together; NDC choices follow the selected drug. Optional dates can be cleared. The previous single-field prompt could not clear a date or apply related drug/NDC corrections together.
- Retained the service's role/site checks, expected-version check and PostgreSQL row lock, immutable source fields, fill-history prohibition, pending schedule/transfer guards, and DUR reset. The editor resolves the current session actor before saving; identity changes or deactivation clear the form and block the save. Stale-version failures retain proposed values without silently advancing the expected version. Reload/close asks before discarding unsaved edits.
- Added form edit history with field-level before/after values, version, reviewer name/role, time and review note. General edits and document-backed structured-change application events now appear in the Rx audit timeline and influence its audit-derived queue order. Free-text audit metadata remains omitted.
- Connected the Dashboard to directory search, status filtering (including `ON_HOLD`) and oldest/newest activity ordering. Double-click opens detail. Actions that previously ran off the single-row toolbar are available in a More actions menu.
- Fixed the two failed Increment 38 CI assertions without changing their expected behavior. Removed the duplicate prescription-detail GET handler: existing Python snake_case fields remain at the top level and the newer camelCase projection stays under `prescription`. Raw electronic messages are omitted from both. GET and PATCH share the `{rx_id}` OpenAPI path template.
- Added offscreen PySide6 interaction tests, a dedicated native CI job, and a PostgreSQL two-workstation edit race test. The race must persist exactly one edit/version and reject the other stale version.

## Verification

- Full local suite: **319 passed, 8 PostgreSQL-only skipped**, before the extra PostgreSQL race case was added. Final focused rerun: **30 passed, 9 PostgreSQL-only skipped**, covering native widgets, reviewed edits/history, directory/HTTP contracts and structured-change audit linkage.
- Offscreen workstation smoke checking exercised real startup, the overflow action menu, Dashboard status/name filtering and native detail/edit controls. The Dashboard and dialog were rendered and inspected. This is Linux offscreen acceptance, not physical Windows/macOS/scanner testing.
- Python compilation and diff checks passed. **No schema change** is introduced. The PostgreSQL workflow verifies the existing migrated schema and runs the new concurrent-edit case.
- Consult GitHub Actions on the committed branch for Python 3.12/3.13, native Qt, PostgreSQL, repository CI and CodeQL acceptance; newly queued jobs are not assumed to have passed.

## Audit progress and remaining work

| Audit item | Progress | Remaining gap |
|---|---|---|
| RX05 | Native search, status and activity order | True modification timestamps, pagination and production-scale queries |
| RX06 | Multi-field native editing, clearable dates, conflict handling | Original/Python differential contracts and broader lifecycle/concurrency acceptance |
| RX16 / UI03 | Structured detail, fill tables, audit and form edit history | Scan, preparation, clinical, document and custody actions remain separate workbench actions |
| PL07 | Existing Python detail contract restored alongside nested projection | Not a drop-in implementation of all 116 Fastify routes |
| UI13 | Native prescription interactions run in CI | Full dispensing journey, accessibility, supported-OS, scanner/printer and installer acceptance |

Audit order still uses recorded events, not an invented `updated_at`. The timeline includes Rx/fill and general/structured applied edits; other clinical, inventory and document events have separate histories. Form edit history covers general reviewed form edits; document-backed changes retain their detailed provenance in the document workflow.

Next: integrate the remaining native prescription-detail workflows and port original per-fill billing/day-supply controls, while retaining biologic/controlled-workflow, migration and concurrency gaps in the plan. Baseline audit counts remain historical rather than a recalculated completion percentage.

**The rewrite remains incomplete and synthetic-only.** No legacy Prisma conversion, live integration or release cutover is introduced. The draft PR remains the continuation point.
