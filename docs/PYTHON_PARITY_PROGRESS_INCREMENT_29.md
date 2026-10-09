# Python parity increment 29 — scanned source correction before review

**Branch:** `python-native-rewrite`. Continues [increment 28](PYTHON_PARITY_PROGRESS_INCREMENT_28.md). Converts the previously missing core source-removal feature **FL07** from the original TypeScript API.

## Implemented

- `PharmacyService.scanned_sources` enumerates barcode-resolved physical sources for a site-owned fill, with NDC, lot, expiry, product description, quantity and optional physical location.
- `PharmacyService.remove_scanned_source` requires a documented 12–2000-character reason, dispensing/process permission, and the fill **and** prescription still at `PRODUCT_FILL`. Row-level locks are used in PostgreSQL for the fill, source and exact lot balance.
- Releases the exact original stock reservation using the existing append-only `FILL_SOURCE_CORRECTION_RELEASE` ledger event. A tracked-location reservation is released to the **original position**, not an arbitrary bin. The original allocation transitions to `RELEASED` with event history and detached source FK so the preserved audit record survives source deletion.
- The correction does **not** decrement on-hand stock, adjudicate payer claims, create a label, mark a fill complete or silently approve another manufacturer. The operator must scan the correct physical product again.
- If claims, claim transactions, labels or print jobs exist, removal fails closed and requires a separate reversal workflow; this mutation is not allowed after Product Fill.
- Added `GET /api/fills/{fill_id}/product-sources` and `DELETE /api/fills/{fill_id}/product-sources/{source_id}` with a required JSON `reason`, plus a native Qt **Remove Incorrect Scanned Source** button.
- New synthetic tests cover stock restoration, repeated remove denial, cross-site denial, permission checks, exact physical-location release, allocation history, successful rescan and the disabled-by-default API gate.

## Scope and next work

No schema migration was needed: source deletion and audit already use the existing Python inventory tables. This is the **core workflow**, not guaranteed matching JSON/HTTP contracts of the TypeScript endpoint, automatic payer rebilling, or production dispensing certification. Further Python work should include FEFO policy and override controls, manufacturer/lot compliance, DSCSA-oriented serialized receipt tracking, and side-by-side original/Python contract tests. Keep the original reference in place until full parity.
