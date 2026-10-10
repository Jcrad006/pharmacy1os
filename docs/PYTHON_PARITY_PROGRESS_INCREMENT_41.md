# Python parity increment 41 — corrected scanned source quantities

Continues [Increment 40](PYTHON_PARITY_PROGRESS_INCREMENT_40.md) on `python-native-rewrite`.
Targets the source-edit portion of baseline **FL05/FL06** and native fill workbench **UI13**, without representing complete equivalence.

## Implemented
- Added atomic `PharmacyService.correct_scanned_source_quantity` with site/role controls, PostgreSQL fill/source/stock row locking, positive three-decimal quantity validation, fill total limit, and nonempty attributable correction reason.
- A delta changes only the existing scanned source's reservation (never its product, lot, expiration, or NDC) and updates both aggregate inventory and the exact tracked physical bin through the existing movement ledger. Active tracked allocations are corrected with an appended quantity-adjustment event; untracked source corrections remain explicitly untracked.
- Increased quantities revalidate stock availability, expiration, recall, and site FEFO policy. Decreases never require an FEFO override.
- Claims, label and print histories, or any synthetic transaction history prohibit this direct correction route. Zero means **remove the source**, which already has its own audited operation.
- Exposed `PUT /api/fills/{fill_id}/product-sources/{source_id}/quantity` in the disabled-by-default synthetic Python API; added a native Qt dashboard action for correcting scanned quantity, including pharmacist FEFO override when policy requires it.
- Added tests for increase/decrease, exact tracked bin and active allocation preservation, inadequate bin stock rollback, no-change/invalid-role/site/quantity guards, transactional audit and API/live-disabled behavior.

## Validation and remaining gaps
CI should independently run Python 3.12/3.13, PostgreSQL and Qt checks for this commit. Legacy Prisma conversion, entire claim rebill/reversal lineage, real claim switch, post-claim source correction and production printer/hardware validation remain open. **No real patient dispensing is permitted.**
