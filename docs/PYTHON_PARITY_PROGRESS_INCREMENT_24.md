# Python parity increment 24 — fill-linked physical allocation lifecycle

**Audit baseline:** [Full feature audit](PYTHON_PARITY_AUDIT_2026-10-08.md). Previous physical-location increment: [Increment 23](PYTHON_PARITY_PROGRESS_INCREMENT_23.md).

## Scope converted from TypeScript/Prisma

- Created `InventoryAllocation` / `InventoryAllocationEvent` SQLAlchemy models, persisted to `py_inventory_allocations` / `py_inventory_allocation_events`.
- Reservation is created only if an opt-in location-tracked stock lot is physically scanned **with an explicit, active, site-owned, nonquarantined physical location**. The source quantity and position must match. No allocations are fabricated for historical untracked fills.
- A pharmacist's fill verification confirms source allocation quantity/location and `ACTIVE` state, consumes the reserved units **at the original scanned position**, and records a `CONSUMED` event; cross-bin consumption is rejected.
- Cancelling an unverified fill releases `ACTIVE` allocations back to `AVAILABLE` at their original bin, recording `RELEASED`. Cancelling a verified/Ready fill returns units to default receiving as a new receipt, without undoing a historical consumed allocation.
- Stopping for an insufficient-stock partial fill releases and records the previous source allocation before deleting the obsolete `FillSource`. The released allocation remains with its original fill, stock, position and event lineage and a nullable `fill_source_id`; a fresh location-confirmed scan creates a new allocation for the smaller physical quantity.
- `record_movement(..., location_id=...)` now pins any negative state movement (including reserve consumption/release) to the specified site-owned bin, rather than consuming reserved stock from another location.
- Added `GET /api/inventory/fills/{fill_id}/allocations` with staff read permission/site isolation and a **View Fill / Physical Allocation History** native Qt action.
- Migration **`f7a42b6d9f10`**, after `f29a4d5c38a1`, creates the two additional Python tables and foreign keys. It has no destructive Prisma operations and does not retroactively assign original TypeScript allocations to Python.
- Regression tests in `python/tests/test_inventory_allocations.py` cover missing scanner confirmation, site/role checks, exact-bin reservation/consumption, unverified cancel release, partial-fill source invalidation and fresh allocation, wrong-bin tampering, API synthetic gating and historical untracked path.

## Parity limits explicitly not closed

The original TypeScript `InventoryAllocation` has additional reservation sources/policy/demand links and a detailed custody workflow. Python still needs:

1. Explicit FEFO policy decisions, overrides with pharmacist authorization, multi-lot allocation recommendations and full paper trail, rather than the current **read-only FEFO advice**.
2. Original `InventoryDemand` backorder and unallocated Rx demand reconciliation against stock location availability.
3. `ReceivingDiscrepancy`/inventory exception and acknowledgment/resolution workflows.
4. Legacy Prisma data-migration/cutover/rollback and native UI acceptance tests.
5. PostgreSQL contention tests for several technicians scanning the same location concurrently. Current stock-level locks are relevant but do not on their own prove all multi-workstation scenarios.

### Operational boundary

Synthetic implementation only. Do not use for live pharmacy stock, prescriptions, patient data or insurer adjudication. `py_stock.location_tracking_enabled` is opt-in after documented count. Historical `FillSource` without location tracking intentionally remains unlinked to `InventoryAllocation`; this is not a silent parity claim.

**CI verification:** Verify the branch head's GitHub Actions Python 3.12/3.13 and PostgreSQL/SQLite workflow results before claiming this increment tested end to end.
