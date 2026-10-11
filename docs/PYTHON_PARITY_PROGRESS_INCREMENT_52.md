# Python parity increment 52 — reverse latest corrected COB attempts and restart a fresh fill

Follows [Increment 51](PYTHON_PARITY_PROGRESS_INCREMENT_51.md) on `python-native-rewrite`, draft [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43).

## Implemented
- **New pharmacist-only `ClaimRebillService.reverse_current_cob`** accepts a prepared 2–4 payer fill and exact currently active synthetic BILL transaction IDs in descending COB position (last to first). Verifies immutable versioned `CobAttemptRegistry` history inside a row-locked SQL transaction and refuses stale, reordered or missing IDs.
- Corrected `_restart_tx` may now reverse the *latest active attempt of every payer* after one or more selective NDC corrections (Increments 50–51). Reverses last → primary, appends linked synthetic REVERSE events and one `SyntheticCobAttemptReversal` per final attempt, then releases scanned stock reservations, voids unused labels, retires original fill, and starts a fresh unscanned/unadjudicated fill. Historic intermediate reversals and paid attempts are not overwritten. Both code paths remain local-only.
- Historical `ClaimOperation` original PAID snapshots remain untouched; final `SYNTHETIC_REVERSED` operation includes selected current NDC, version and original paid/reversal transaction references. All events are local simulations, no insurer contact.
- **Idempotent replay** checks exact original active IDs, intact all-payer final reversals, original fill retirement and linked replacement lineage. It returns the existing reversal IDs and replacement without duplicate inventory movement, labels or claims—even if the new attempt was subsequently verified.
- Original `restart` and `reverse_cob_transactions` behavior for uncorrected legacy chains is preserved, and original-only claim IDs still cannot silently override the requirement for latest payer transaction identifiers on a corrected chain.
- New `POST /api/third-party/fills/{fill_id}/reverse-current-cob` and native Third Party action. Regression tests cover two separate selective corrections before whole-fill reversal, chronological immutable event chain, stale/role/site/print rejects, transactional failure rollback, API demo gates, and real migrated PostgreSQL two-pharmacist contention.

## Remaining differences
This is a **local simulated** full-fill restart after correcting payer positions. External claim adapter transactions, NCPDP switch integration, actual monetary reconciliation, partial-fill legal requirements, verified printer hardware, and real dispensing remain unimplemented or unvalidated. Do not process real prescriptions. PR stays draft.
