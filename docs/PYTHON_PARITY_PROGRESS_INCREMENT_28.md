# Python parity increment 28 — persistent site inventory exceptions

**Branch:** `python-native-rewrite`. Continues [increment 27](PYTHON_PARITY_PROGRESS_INCREMENT_27.md), [feature audit](PYTHON_PARITY_AUDIT_2026-10-08.md) issue IN17.

## Migrated Python safety register

Persistent site-scoped `InventoryExceptionRecord` plus append-only `InventoryExceptionEvent` and explicit role-controlled refresh. Existing Python objects detect: low available stock versus configured reorder policies, near-expiry/expired lots, location position imbalances, stale reservations (24h), transfers in transit (48h), outstanding purchase orders (3 days), and uncovered demand. This is an *advisory synthetic board*; real pharmacy detection thresholds require policy review.

- `GET /api/inventory/exceptions` lists saved findings **without mutating state**. Unlike the original TS GET, mutation only occurs on explicit `POST /api/inventory/exceptions/refresh` (inventory permission).
- `POST /api/inventory/exceptions/{id}/acknowledge` requires inventory permission and a documented note. `POST .../{id}/resolve` requires pharmacist/admin correction permission and documented resolution. `GET .../{id}/events` returns permanent event history.
- Repeated refresh deduplicates by site/fingerprint and retains acknowledgements. When a monitored condition disappears, its open/acknowledged record is automatically resolved with event evidence; when it reappears, its record reopens, also with an event. An unresolved condition can reopen a previously manually closed alert. These transitions do **not** touch stock or generate purchase orders.
- Qt Inventory screen adds viewing, refresh, acknowledgement, resolution and per-case audit history.

Alembic revision `e41cd17a9203` follows `c9218a7db125` and creates only separate `py_*` tables. No original Prisma records touched, no historic alert cases fabricated. Downgrade intentionally blocked to retain audit events.

**Still missing / deliberately not inferred:** original TS acquisition-cost warnings (there is no Python receipt unit-cost ledger), site-configurable alert time thresholds, dedicated physical-shortage detection, financial valuation, full equivalence to TS detection behavior, notification automation, clinical safety certification, real patient use. IN17 moves from absent to partially implemented. Tests cover creation, de-duplication, acknowledgement preservation, auto-close/reopen, cross-site denial and API synthetic mode. CI status must be checked on the final commit.
