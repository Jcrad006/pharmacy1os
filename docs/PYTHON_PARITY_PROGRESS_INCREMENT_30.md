# Python parity increment 30 — original-container packaging and discard-date metadata

**Branch:** `python-native-rewrite`. Follows [increment 29](PYTHON_PARITY_PROGRESS_INCREMENT_29.md), originally missing audit item **FL08**. This converts TypeScript's `PUT /fills/:id/packaging` and its pharmacist-commit packaging calculation into the synthetic Python services.

## Behavior

- Fill records now store `dispensed_in_original_container`, `patient_discard_date`, the actor/time of the packaging decision, and its documented rationale.
- The processing operator can set/revise packaging only while both the prescription and fill are in `PRODUCT_FILL` and before test claims/labels. The decision is audited.
- At **pharmacist final verification**, if repackaged, compute the earlier of the verification date plus one calendar year and the **earliest** physical stock source expiration. Original-container fills set the computed date to null, matching the TypeScript reference's metadata behavior.
- Calculation occurs only upon successful verification, in the same database transaction as stock consumption. Rejected/failed verification cannot produce a committed discard date.
- Leap-year dates are handled deterministically (February 29 -> February 28 in a nonleap following year).
- Added `PUT /api/fills/{fill_id}/packaging` with a reason and strict boolean input, plus native Qt **Set Original Container Packaging** action.
- New Alembic revision `b7e362a05c91` extends **only** `py_fills` after `e41cd17a9203`. Existing historical fills retain the old synthetic default `False` and `NULL` date; no synthetic discard dates are retroactively fabricated.

## Explicit limits

The calculation reproduces **application reference semantics**, not an independent statement of North Carolina law or an authorized label instruction. The synthetic thermal label snapshot and real device integration have not been made automatically compliant with discard-date printing. Live patient, pharmacy, billing, and legal dispensing are prohibited. Full one-to-one UI/HTTP parity and regulatory validation remain open.
