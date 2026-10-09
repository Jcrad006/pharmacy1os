# Python parity increment 26 — receiving discrepancy investigation

**Branch:** `python-native-rewrite`. Continues [increment 25](PYTHON_PARITY_PROGRESS_INCREMENT_25.md) and the [feature-parity audit](PYTHON_PARITY_AUDIT_2026-10-08.md), finding IN18.

## Converted from the original TypeScript feature

- Site-scoped receiving discrepancies for short shipments, overages, wrong or damaged products, lot/expiry or invoice mismatches, duplicate/unexpected shipments and other cases.
- Links to site-owned purchase order, PO line and receipt, with matching lineage enforced. Product references, optional nonnegative expected/observed unit quantities and an external evidence reference are supported. Invalid category, cross-site links, excessive numeric precision and unrecorded products fail closed.
- Technician/admin/pharmacist users with inventory permission may report cases; pharmacist/admin stock-correction permission is required to resolve. All authenticated roles with site read permission can inspect the register/history. An open case cannot be resolved twice.
- Immutable created/resolved events, actor IDs, timestamps and application audit log entries.
- Optional resolution link to a **previously recorded** `MANUAL_ADJUST` stock movement; it must be on the same site and **exact receipt stock** and cannot be reused for another discrepancy.
- **Important:** Opening and resolving cases never directly modifies stock, approves a receipt or automatically releases a damaged product. Physical stock correction is a separate audited action and must be reviewed. Linking a prior correction provides evidence, not a transactionally coupled correction.
- FastAPI: `GET/POST /api/inventory/discrepancies`, `GET /api/inventory/discrepancies/{id}/events` and `POST /api/inventory/discrepancies/{id}/resolve`. The native PySide6 Receiving screen offers report, list, pharmacist resolution and history prompts.

## Persistence and migration

A new Alembic revision `c9218a7db125` adds only `py_receiving_discrepancies` and `py_receiving_discrepancy_events` to the separate synthetic `py_*` schema, after `a5e618d4b92f`. No Prisma records are changed and no historical discrepancies are fabricated. Downgrade is intentionally blocked to retain investigation evidence. Back up synthetic DBs and run reviewed Alembic upgrade.

## Verification and remaining gaps

Tests added in `test_receiving_discrepancies.py`: evidence/stock immutability, resolution permissions, unique adjustment proof, site and PO lineage, quantity limits, API opt-in, event history. CI success must be checked at the commit; these are synthetic acceptance tests, not a validated clinical workflow.

**IN18** is now **partially converted**: Original TS does not verify the integrity and site of every relationship; the Python port adds stricter checks. Exact original JSON compatibility, advanced shipment-document capture and real-world supplier claims remain outstanding. **IN17** persistent inventory exceptions, **IN16** as-of historical balances, **IN14** FEFO policy enforcement and **IN20** DSCSA serialized-package handling remain open. Full system parity and production readiness are not established.
