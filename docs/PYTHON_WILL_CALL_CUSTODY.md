# Python Will Call custody increment (synthetic only)

This Python module ports a subset of the existing TypeScript POS / Will Call custody behavior. It is not full POS parity, a production-ready software release, or a replacement for the legacy application.

## Converted
- Rebag only a READY/STAGED fill, with a previously unused barcode and documented reason. Previously assigned or retired barcodes are not reusable, including across sites.
- Move a staged package to a different bin with an audit reason.
- Retain original bag and location provenance in separate custody events; mark active barcodes CLOSED after checkout or return to stock.
- Add site/role gates, transactionally committed audit history, native Qt controls and synthetic FastAPI endpoints.
- Add additive Alembic revision 7c91d1e71f32 for two Python-only custody tables with FK constraints and unique barcode, while leaving Prisma records unchanged.

## Limitations
- There is no active cold-chain location validation or physical location registry; bin is currently free-form validated text.
- A single package per fill; original TypeScript supports richer package tracking and multi-fill checkout.
- No verified signature hardware, barcode scanner drivers, split tenders, returns/refunds, cash pricing snapshot, or real electronic payment.
- SQLite tests are not evidence of cross-workstation race freedom; multi-client PostgreSQL locking and failure injection remain release blockers.
- Demo actor headers are impersonation, not authentication. Use synthetic development data only.
- Alembic schema migration does not copy Prisma data and cannot prove semantic equivalence. Existing TypeScript system remains the authoritative application.
