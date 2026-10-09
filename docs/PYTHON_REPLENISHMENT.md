# Python synthetic replenishment planning

The Python-native synthetic workstation now provides **advisory reorder planning** for
the existing product/NDC catalog. This module does not place orders, contact
wholesalers, touch live pharmacy data, or establish regulated purchasing rules.

A pharmacist or administrator configures per-site, per-product thresholds: a
minimum usable/projected quantity and a strictly greater target quantity.
Changes and disabling actions require a documented reason and create audit events.
Technicians and auditors may read their own pharmacy site's suggestions.

## Calculation

- Available = unexpired lot on-hand less reserved and quarantined quantity.
- Incoming = outstanding amounts on OPEN or PARTIAL purchase-order lines plus
  in-transit quantities destined for this pharmacy, excluding expired shipments.
- Projected = available + incoming.
- If projected is strictly **below** the minimum, suggested quantity is target
  minus projected. Equal-to-minimum stock is not flagged.
- **Recall and controlled products** show a review-required status and **zero**
  suggested quantity, even when physically short. Disabled policies do not
  produce suggestions.
- Historical POs that have been cancelled or received and transfers that have
  been received/cancelled are not double counted. Once a transfer is received,
  it moves from incoming to stock-on-hand.

This is a snapshot with no reservations or guarantee that inbound quantities
will arrive. A pharmacist must review stock, expiration, policy, supplier data,
clinical needs, recall/DSCSA status and actual ordering rules separately.

## Access

Use the native Qt **Supply Chain → Replenishment Planner** workflow to configure,
disable or review thresholds; or call the synthetic FastAPI routes (only when
explicitly enabled):

- `GET /api/inventory/replenishment?include_all=true`
- `POST /api/inventory/replenishment/policies` with
  `{"product_id":"...","minimum":"10","target":"50","reason":"..."}`
- `POST /api/inventory/replenishment/policies/{product_id}/disable` with
  `{"reason":"..."}`

New isolated Alembic revision `e2a9401f67c3` adds only
`py_reorder_policies`. The original Prisma tables remain untouched.
Existing synthetic SQLite databases may have the new table added via the
prototype `create_schema()` path; PostgreSQL instances use reviewed
Alembic execution.

## Still required before production

External supplier ordering/EDI, appropriate reorder economic logic, forecasting,
controlled substance ordering workflow, DSCSA and recall feeds, concurrency and
idempotency tests, tenant-enforced foreign keys, realistic quantities across
multiple packaging units, local timezone/expiration policy, inventory
reconciliation and native UI acceptance tests. This does not confer full Python
feature parity or authorization for dispensing/PHI.
