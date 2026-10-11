# Python parity increment 51 — version-aware correction preview and current billed NDC

Follows [Increment 50](PYTHON_PARITY_PROGRESS_INCREMENT_50.md) on the isolated `python-native-rewrite` branch.

## Implemented

- **Fixed the stale original-only COB preflight:** `CobCorrectionPlanner.plan` now derives current active payer transaction IDs and version numbers from the validated, immutable `CobAttemptRegistry._history_tx` rather than assuming exactly one original BILL per payer. For position `N`, it displays downstream-first active reversal dependencies and upstream-first resubmission positions even after multiple corrected attempts; reports original and current transaction identities and NDCs distinctly.
- **Actionable synthetic-only preflight, still read-only:** Returns `action_enabled=true` *only* for an intact pre-verification 2–4 payer chain with active local test attempts, no completion/emergency fill, no previous replacement, unprinted queued labels, no unresolved manual test hold, and physically eligible scanned on-hand source NDC(s). Required exact active transaction IDs and allowed NDCs are exposed for pharmacist review. The plan does not write data, authenticate an insurer or assume live payer acceptance.
- **Corrected Fill Claims / Labels report:** `FillClaimReview.detail` now checks versioned BILL/REVERSE ancestry before reporting a current billing NDC, paid transaction ID, and attempt version. The historical original `ClaimOperation` and first-attempt NDC remain visible and explicitly identified as original. Multiple versions are shown as immutable attempts; physical bottle labels and print queue snapshots remain unchanged.
- Removed a duplicated corrected-attempt ancestry test in the internal versioned ledger validator.
- Regression tests cover consecutive suffix corrections, dynamic old-vs-current transaction IDs, adjusted vs original NDCs, three-position review after correction, read-only site gates, post-print preflight denial, and synthetic-only API parity.

## Remaining limitations

Selective COB correction and matching report are **local simulations**. No switch, live third-party insurance adjudication, NCPDP transaction, monetary reconciliation, or patient dispensing is enabled. A future increment should implement consistent whole-fill reversal of the *latest* paid attempts after one or more selective corrections, preserving each original attempt/reversal link and avoiding legacy `ClaimOperation` uniqueness errors. Existing original-only whole-fill reversal blocks corrected chains intentionally. Keep [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43) draft and do not use real patient data.
