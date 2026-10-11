# Python parity increment 23 — physical inventory locations, reconciled stock positions and FEFO advisory

**Audit reference:** [TypeScript-to-Python parity matrix](PYTHON_PARITY_AUDIT_2026-10-08.md).  
**Branch:** `python-native-rewrite`. No changes to the original TypeScript/Prisma implementation.

## New Python functionality

- **InventoryLocation**: site-scoped physical shelves, bins, receiving, refrigeration, quarantine, freezers, safes and other location types. Fields include unique site code and optional barcode, default receiving/dispensing flags and temperature-range *metadata* (not monitored sensors). Default selections and location creation are role controlled.
- **InventoryStockPosition**: explicit available, reserved and quarantined physical units at each stock location. Positions are separately reconciled to existing `Stock.on_hand`, `Stock.reserved` and `Stock.quarantined`:
  `sum(position.available) = on_hand - reserved - quarantined`;
  `sum(position.reserved) = reserved`;
  `sum(position.quarantined) = quarantined`.
- **Opt-in activation**: A pharmacist must identify an active nonquarantine location and provide a physical-count attestation to activate per-lot tracking. A lot with outstanding reserved or quarantined stock cannot be activated. Existing historic lots are **not silently assigned an invented location**. In the isolated synthetic schema, `py_stock.location_tracking_enabled` defaults to `false`.
- **Atomic stock-movement integration**: once activated, the existing `record_movement` now mirrors each receipt, reserve/release, pharmacist dispense, quarantine, disposition, return and manual adjustment onto location positions inside the same database transaction. A discrepancy raises and rolls back rather than allowing aggregate and physical positions to diverge. `InventoryPositionEvent` stores append-only source/destination, quantity, state, actor, reason and event type. Concurrent PostgreSQL stock-row locking is reused in main source scan, verification and adjustment workflows; broader multi-workstation fault tests are still needed.
- **Explicit physical relocation**: move only free/available units between active site-owned nonquarantine locations. Reserved or quarantined stock is excluded; aggregate lot totals remain unchanged. Cross-site moves are rejected.
- **Product Fill scan**: scanning can now specify a location ID when tracking is active, reserving from that precise physical position. The native Qt scanner prompts the operator to confirm the source location for tracked stock. Existing untracked synthetic workflows still scan as before; a location cannot be supplied until activated.
- **FEFO advisory**: returns usable, unexpired, reconciled physical positions for a product sorted by expiration, then default dispensing location. Supports minimum remaining shelf life. **Read-only**, with no automatic source allocation or substitution policy.
- **FastAPI and Qt**: location registration/listing, initial stock reconciliation, stock-position inspection, physical relocation and FEFO review are exposed through `/api/inventory/locations*` and `/api/inventory/fefo` endpoints and a native Inventory workstation page. All functions remain synthetic-only and site/role-gated.

## Alembic migration

`f29a4d5c38a1` follows `e48f2d6a47cb`. It creates:

- `py_inventory_locations`
- `py_inventory_stock_positions`
- `py_inventory_position_events`
- `py_stock.location_tracking_enabled` (defaults to false)

No historical location values are fabricated. No Prisma tables are altered. Existing synthetic databases require an audited Alembic upgrade after backup; `create_all` does **not** add missing columns to existing tables.

## Audit impact

| Original audit capability | New status | Remaining for parity |
|---|---|---|
| IN12: Physical inventory locations and barcodes | Core Python record + native input/listing | Complete React field editor, temperature device validation |
| IN13: Stock positions and relocation | Opt-in reconciled positions + audited available-unit moves | Full original `AVAILABLE/QUARANTINED` state contract; migration of historical locations |
| IN14: Location-aware FEFO | Read-only FEFO recommendation implemented | Actual fill-linked `InventoryAllocation`, FEFO enforcement/override and reconciliation |
| IN03: Inventory movements | Physical-event mirror added | Original full transaction cost/reference/source contracts |
| UI08: Inventory architecture | Basic native forms added | Full inventory architecture and exception-management screen parity |
| IN15–IN18 | Not closed | Demand/backorder, as-of, persistent inventory exceptions and receiving discrepancies |

## Test coverage added

`python/tests/test_inventory_locations.py` covers physical baseline attestation, nonnegative positions, site isolation, available-only moves, exact scanned location reservations, receipt/verification and quarantine/disposition mirroring, FEFO ordering, source expiry handling, existing untracked behavior, role guards and API synthetic gating.

**Verification:** CI results should be reported only after the GitHub runs against the new commit complete; green from an earlier code revision is not sufficient.

## Limitations

- No automated FEFO selection or allocation for prescriptions; this implementation **does not yet match** original `InventoryAllocation` lineage.
- No physical location scanning hardware integration or measured cold-chain temperature validation.
- No existing shelf records can be trusted merely because a stock lot has a positive quantity. Physical initialization requires a documented count.
- Controlled/biologic/NTI/cold-chain fills remain blocked as previously specified.
- Not for live patient/insurance data or actual pharmacy dispensing.

## Next audit-driven development increment

Complete fill-bound physical allocations (including split manufacturers and partial fills), explicit release/consume/return lineage and FEFO selection policies, with PostgreSQL simultaneous-pick tests. Then port the original inventory demand/backorder, receiving discrepancy and persistent exception subsystems. Other unresolved domains include full Prisma data migration, validated clinical safeguards, payer networking and native workstation release packaging.
