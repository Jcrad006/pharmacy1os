# Python parity increment 27 — immutable-ledger as-of inventory quantity

**Branch:** `python-native-rewrite`. Continues [increment 26](PYTHON_PARITY_PROGRESS_INCREMENT_26.md) and the [feature-parity audit](PYTHON_PARITY_AUDIT_2026-10-08.md), gap IN16.

The original Prisma `projectBalanceAsOf` aggregates dated inventory transaction deltas. This Python port computes **on-hand, reserved, quarantined and available** quantities for a site-owned stock lot at a requested timezone-aware timestamp. It uses only the synthetic append-only `py_inventory_movements` ledger.

## Integrity rules

- Before returning *any* history, verify all movement before/after JSON snapshots form a zero-origin consecutive chain and agree with each corresponding three-part Decimal delta.
- Fail closed when history has been pruned, was not imported from legacy system, has been tampered with, or does not reconcile to the current stock balance. Unknown or non-timezone-aware timestamps also fail.
- Enforce the actor's site read permission. As-of lookup never changes stock, quarantine, reservations, receipt status or billing.
- Report `recorded_acquisition_cost = null` explicitly: the existing Python movement ledger does not track this original TypeScript accounting field. No historical costs are fabricated.
- This is a lot balance reconstruction, not a stock-location historical allocation, acquisition valuation, or cross-legacy forensic accounting process.

FastAPI route: `GET /api/inventory/balances/{stock_id}/as-of?at=2026-10-08T19:00:00-04:00`; omit `at` for now. Native PySide6 Inventory page provides a read-only historical report.

No database migration required: the new service reads existing movement records. Tests verify receipt/quarantine/adjustment, timezone validation, cross-site rejection, tampered ledger and synthetic API gate.

**IN16 partial**: Core historical quantity projection converted; equivalent acquisition cost, legacy ledger import and operational clock-order verification remain outstanding. Overall feature parity and production release gates remain open.
