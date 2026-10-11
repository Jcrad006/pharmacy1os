# Python parity increment 46 — transaction-selected one-payer synthetic reversal

Branch `python-native-rewrite`. Follows [Increment 45](PYTHON_PARITY_PROGRESS_INCREMENT_45.md). Narrows **BL09** and transaction-level safety gaps (partial; original multi-payer reversal is still missing).

## Functionality

- `ClaimRebillService.reverse_single_transaction(actor, transaction_id, reason, expected_claim_id=...)`: pharmacist-only synthetic reversal keyed by the *original BILL transaction ID*, matching the original TypeScript claim action's navigation.
- Explicit restriction to **one** paid synthetic payer, pre-verification, one original BILL event. Multi-payer COB must use existing full-fill `restart`; one-position reversal amid active downstream payer claims is deliberately prohibited. No real payer request is issued.
- Uses the same atomic audited replacement-fill operation as Increment 42 (now refactored as transaction-scoped `_restart_tx`). Original paid transaction preserved; a new REVERSE event linked by `original_transaction_id`, original claim marked reversed, unused labels voided, reservations released, and a new Product Fill attempt created for fresh source scan, preparation and pharmacist verification. A failure rolls back all changes.
- **Idempotent replay:** subsequent calls with same original transaction and exact claim ID return the existing reversal transaction and linked replacement fill, after checking original/current historical integrity. No duplicate reversal, source movement or fresh fill; repeated calls do not rewrite history. Checks payer and role boundaries, source integrity, print events, prescription and fill state.
- Adds `POST /api/third-party/claims/{transaction_id}/reverse` for opt-in synthetic API plus a native Qt Third Party pharmacist action. No migration needed.
- Tests: success, replay, freshly rescanned replacement, refused multi-payer, role/site/stale ID/printed-label guards, tampered-original checks, transactional rollback, API synthetic gating, and real PostgreSQL two-workstation reversal replay.

## Not parity-complete

- The original TypeScript service supports single-position reversals within COB with downstream sequencing and external adapter references; this Python version deliberately does **not**. This is a *single-payer reversal with automatic rescan* rather than a general standalone reverse-in-place. A later increment should model true ordered multi-payer reversal and re-adjudication.
- No insurer, live claim switch, real print/label hardware acknowledgement, PHI handling certification or dispensing validation. Keep [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43) draft.
