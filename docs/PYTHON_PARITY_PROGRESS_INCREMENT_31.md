# Python parity increment 31 — opt-in FEFO selection policy and pharmacist exception

**Branch:** `python-native-rewrite`. Continues [increment 30](PYTHON_PARITY_PROGRESS_INCREMENT_30.md). Advances inventory parity item **IN14** from read-only FEFO advice toward explicitly controlled, auditable physical stock picking.

## Implemented

- `FefoPolicy` is a persisted, unique **site + NDC/product** policy with `ADVISORY` or `ENFORCE` mode, minimum remaining shelf life (0–3650 days), enabled flag and pharmacist-authored change rationale. Settings require the existing `correct` permission. Prior settings are preserved in the append-only central audit log.
- The product scan transaction now checks other **same-NDC physical lots at that pharmacy site**, ordered by expiration; recalled, expired, unavailable, fully reserved/quarantined and short-shelf-life-ineligible lots are excluded. For physically reconciled lots, a candidate counts only if a non-quarantine active location actually contains available stock.
- In `ENFORCE` mode, attempting to scan a later expiration or a lot below the minimum shelf-life threshold **fails before reservation**. A pharmacist/admin may override by personally scanning with a 12–1000-character explanation. The decision, source lots, expirations, reason codes, actor, and policy are audited **atomically in the reservation transaction**.
- In `ADVISORY` mode, the pick is allowed and a deviation is audited; a false override annotation is rejected.
- **Fail-safe opt-in**: products with no active policy retain their previous scan behavior and may not submit fabricated override notes.
- Registered in FastAPI: `GET /api/inventory/fefo/policies`, `POST /api/inventory/fefo/policies`. Existing `POST /api/fills/{fill_id}/sources` accepts optional `fefo_override_note`.
- Native PySide6 Inventory screen: policy listing and pharmacist configuration; pharmacist Product Fill may document an override after a blocked FEFO scan.
- New Python database table added with Alembic revision `c8f20b42d531` following `b7e362a05c91`; no existing inventory balance or TS/Prisma data is touched.
- Targeted tests cover technician denial, pharmacist overrides, no reservation on failure, stock receipt chronology, minimum shelf life, quarantine, site isolation, location-tracked candidates, advisory vs enforce, API and default-disabled gate.

## Deliberate limitations

This is an **application-level synthetic policy**, not an independent claim about legally mandated FEFO or formal DSCSA compliance. It does not automatically allocate inventory or bypass the original NDC, barcode, lot, expiry, recall, DUR, and pharmacist verification checks. Choice remains scoped to the same **NDC/product** (not cross-manufacturer therapeutic substitutions). Existing SQLite demo databases require the normal schema migration or explicit synthetic initializer and all multi-workstation race/lock behavior still needs real PostgreSQL load testing. Full original TypeScript contract parity, production authentication and safe real-world deployment remain incomplete.
