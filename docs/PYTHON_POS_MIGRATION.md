# Python-native synthetic POS conversion — incremental contract

This is a **development-only module** in the isolated Python migration branch. It does **not** perform actual payments, determine insurance copays, communicate with bank terminals, adjudicate NCPDP claims, or constitute proof of payment. Never process real patients/PHI or operate a pharmacy with this system.

## Implemented

- Multi-prescription checkout (1–20 fills) on one transaction for **one patient at one site**.
- All fills require pharmacist-verified `READY`, current unexpired and unrecalled stock, complete physical-source quantities, generated labels, and valid pickup mode.
- Will Call scans must match an active bag barcode in the custody ledger; previously retired bags cannot be used. Immediate pickup is only allowed if no Will Call package exists.
- Captures a named recipient, identity **method** (not government ID numbers), attested signature method and a site-scoped idempotency key.
- Takes an explicitly supplied **synthetic** line amount and up to 8 mock tender allocations; exact two-decimal tender sum must match line total, or zero for a no-charge pickup.
- Writes one atomic `py_pos_transactions` record, per-fill lines, mock tenders, mock capture event, existing `py_sales` rows and prescription state transitions. The `py_pos_financial_events` ledger preserves history for refund and void activity. Refunds are restricted to pharmacist/administrator, capped at the non-refunded balance and idempotent. Financial voids do not reverse clinical fulfillment automatically.
- Site-scoped query/receipt/ledger endpoints; receipts prominently identify the simulation.
- Alembic revision `56b4b973cdea` after `7c91d1e71f32`, introducing isolated `py_` tables with no legacy Prisma modification. Downgrade is blocked.

## Not yet equivalent to original TypeScript POS

Automated payer/copay snapshots, third-party adjudication and reversals, price rules, settled card/cash drawer workflow, change-making, offline settlement reconciliation, refund-to-original-card authorization, pickup fraud review, multiple simultaneous workstations with proper row locks and serializable retries, real receipt devices, detailed controlled medication rules, and physical stock reversal remain unimplemented. Legacy POS records are **not migrated**.

The old single-fill Python `service.sell` endpoint is retained for compatibility but does not create a multi-fill POS transaction. It must be retired or adapted under a reviewed migration gate before claiming parity.

## Migration testing

Migrate *synthetic* PostgreSQL or isolated SQLite using `PHARMACY1OS_SYNTHETIC_DEMO=1`, an explicit `PHARMACY1OS_DATABASE_URL`, and `python -m pharmacy1os.db_cli upgrade`. Independently run `verify`, `alembic check`, and the Python tests. This must never be run against live data.
