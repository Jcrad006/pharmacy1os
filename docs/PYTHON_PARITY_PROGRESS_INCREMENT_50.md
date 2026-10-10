# Python parity increment 50 — atomic selective local COB correction

Follows [Increment 49](PYTHON_PARITY_PROGRESS_INCREMENT_49.md) on `python-native-rewrite`; draft [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43).

## What works

- New `SyntheticCobCorrectionService.correct(actor, fill_id, reason, target_position, expected_active_paid_transaction_ids, corrected_billing_ndc)` selects a position within a 2–4-payer *locally simulated* COB chain. Input includes the exact, ordered **descending active** paid transaction IDs from the target through the last position and one corrected billing NDC from physical scanned sources.
- Pharmacist/site gate, locked fill/claim/stock rows (real PostgreSQL serialization), pre-verification only, completion/emergency/previously restarted fill exclusion, source integrity, unopened labels, no output attempts, and no open manual test rejection.
- One SQL transaction creates a reversal for **last payer → target**, links it to the old paid attempt, then creates new synthetic paid transaction(s) for **target → last**, appending attempt versions 2, 3, and beyond while preserving the original ClaimOperation snapshot, payer and physical source records. The new target can use a different, *already scanned* NDC. Downstream payer requests include identifiers of current upstream local paid attempts. A failure rolls back all reversals/rebills.
- The original `Claim` table remains a current-state projection; every old BILL and REVERSE is validated through the versioned ledger. `verify` now reconciles **all** payer attempts in its existing SQL transaction, permitting a fully corrected chain but forbidding incomplete/forged reversals before stock consumption.
- Deterministic idempotent replay returns the same reversal/new-paid transaction IDs without duplication; stale/out-of-order lists are blocked. Initial full-fill reversal path is blocked for already versioned-corrected claims rather than accidentally selecting the original paid event.
- `POST /api/third-party/fills/{fill_id}/correct-cob`, native Third Party correction action, and existing read-only attempt history. Tests cover four-payer suffix correction, repeat attempt versions, replay, stale/role/site/print/NDC guards, rollback, API safety gating, forged history blocking verification, and concurrent PostgreSQL pharmacist actions.

## Important limitations

- This records **local simulated paid responses only**, never real NCPDP adjudication, remote payer response, insurance receivables, amounts, claim switch transport or patient billing. Correcting one payer NDC is only a sandbox assumption and does not prove a payer would accept that substitution.
- Original `ClaimOperation` paid/reversed snapshot is intentionally **not** overwritten on selective correction. New versioned `BILL`/`REVERSE` events are canonical; downstream read-only billing views may still use original ClaimOperation and need further parity updates.
- Full-fill reversal after selective corrections is deliberately blocked; it requires dedicated logic for reversing the latest active attempts. The preflight planner currently describes the original all-paid chain, not a multi-version chain; the interactive correction action derives the latest from the versioned ledger. Further compliance/clinical integration, real authorization behavior, and production operations are not implemented.

Draft only. **Never use for real dispensing, insurer transmission, or PHI**.
