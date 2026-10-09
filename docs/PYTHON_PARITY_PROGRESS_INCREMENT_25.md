# Python parity increment 25 — inventory demand and backorder reconciliation

**Branch:** `python-native-rewrite`; reference [feature parity audit](PYTHON_PARITY_AUDIT_2026-10-08.md) (IN15) and [increment 24](PYTHON_PARITY_PROGRESS_INCREMENT_24.md). All records are synthetic. Original TypeScript/Prisma remains preserved.

## Python behavior ported from the original

1. **InventoryDemand + append-only history.** SQLAlchemy `InventoryDemand` records pharmacy site, drug, optional exact NDC, linked fill (unique when supplied), source (`FILL`, `COMPLETION`, `MANUAL`, `REORDER`), required/available physical quantities, status (`OPEN`, `READY`, `FULFILLED`, `CANCELLED`), needed-by date, documentation, creator and timestamps. `InventoryDemandEvent` persists create, availability-change, physical-quantity edit, fulfillment and cancellation transitions, retaining before/after status and source actor.
2. **Fill lifecycle.** A newly started synthetic fill now automatically receives an advisory demand for its **physical** target quantity, not the insurance billed quantity. A completed partial gets an independent `COMPLETION` demand. An in-progress partial interruption amends the active demand's physical target; an Rx cancellation cancels any unfulfilled demand. A pharmacist-verified fill marks the demand `FULFILLED` after actual stock consumption; unsold return-to-stock does not invent a new prescription requirement or erase historical fulfillment.
3. **No duplicate forecast.** Reconciliation processes non-reorder OPEN/READY patient/manual demand in deterministic needed-by and creation order, deducting hypothetical available units **once** from a shared drug-level pool. Partial coverage is reported as `OPEN` with the covered portion. `REORDER` requests independently compare stock without appropriating patient demand.
4. **Eligibility boundaries.** Usable stock counts only site-owned, active NDCs, nonexpired lots, with no active product-wide or matching lot recall; reserved and quarantined units are excluded. A dispense-as-written demand is NDC-specific and cannot use another manufacturer. Unit quantities are exact Decimal values. These are **advisory forecasts**, not physical allocations, FEFO enforcement, legal product substitution, or a guarantee that any stock will still be available when scanned.
5. **Stock movement integration.** The existing `record_movement` workflow (receipt, source reserve, release, quarantine, adjustment, verification) refreshes outstanding demand snapshots in the same transaction. Users may explicitly run audited reconciliation at the site/drug level.
6. **Role/site and native UI.** Read-only queue/history requires site read permission. Manual/reorder creation, manual cancellation and explicit reconcile require stock-workflow permission; fill-linked demands cannot be cancelled outside their Rx lifecycle. Native PySide6 Inventory page now includes a demand/backorder queue, documented manual and reorder requests, reconciliation, cancellation and event history.
7. **API**:
   - `GET /api/inventory/demands` (optional `drug_id`)
   - `GET /api/inventory/demands/{demand_id}/events`
   - `POST /api/inventory/demands/manual`
   - `POST /api/inventory/demands/reconcile`
   - `POST /api/inventory/demands/{demand_id}/cancel`

## Migration

Alembic revision **`a5e618d4b92f`**, after **`f7a42b6d9f10`**, adds only `py_inventory_demands` and `py_inventory_demand_events` with indexes, FKs, unique-fill ownership and status/source/quantity checks. There are **no changes to existing Prisma tables** and no fabrication of demands for historic fills. Existing synthetic databases need backup and a reviewed versioned upgrade.

## Audit progress versus unresolved items

- **IN15 inventory demand/backorders:** Core persistent Python records, lifecycle and conservative reconciliation implemented. Full original cross-subsystem reorder policy integration, due-by scheduling semantics and exact TS model parity still **partial**.
- **IN14 FEFO:** Still read-only advisory rather than policy-controlled pick/override.
- **IN16 historical as-of ledger**, **IN17 persistent exception handling**, **IN18 receiving discrepancy** and **IN20 serialized-package/DSCSA scaffold**: not closed.
- UI: native Qt has basic queue/forms, not full original React workspace field parity.
- Concurrent SQLite development behavior is not a sufficient substitute for PostgreSQL contention testing of every path. No real pharmacy safety/compliance claims.

## Tests

`test_inventory_demands.py` checks no duplicate phantom coverage across two patient fills, automated receipt/quarantine/reservation refresh, pharmacist fulfillment, cancellation, physical partial target, DAW-specific NDC need, independent reorder, site isolation, immutable history and API synthetic gating. `test_database_migrations.py` also asserts no historic fill is retroactively linked to invented inventory demand. GitHub Actions must pass at the final branch commit before this increment is considered verified.

## Next development

Port persistent `ReceivingDiscrepancy` with authorization, evidence and resolution linkage to receipt adjustments, followed by `InventoryException` lifecycle and as-of quantity projections. Prioritize pharmacist-reviewed reconciliation and manufacturer/lot/expiry controls; do not promote demo records to live operating data.
