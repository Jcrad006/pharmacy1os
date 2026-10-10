# Python parity increment 44 — per-fill claims, print provenance, full rebill chains

Follows [Increment 43](PYTHON_PARITY_PROGRESS_INCREMENT_43.md). Baseline parity targets: **BL07**, **BL09**, **BL12**, **FL14** and original `GET /fills/:id/claims` *concept*, not byte-for-byte DTO matching.

## Delivered
- `GET /api/fills/{fill_id}/claims` and native Third Party claim/label review present site-authorized per-fill claims and sequence, billed and physical quantities, selected billed NDC, days supply, masked historical coverage, local request/reversal transaction events and immutable bottle label records together.
- Includes each test label's queued/void status, source-independent SHA-256 snapshot integrity, and explicit OS-dialog/reprint event history. An accepted dialog or spool request **does not confirm successful printing**. The view never invents claim amounts, authorization references, patient copays, or real payer outcomes.
- Validates claim transaction canonical request checksums before returning a report. Missing jobs in historical synthetic records remain visibly null. Reject-only events remain separate and clearly labeled as manually simulated test holds.
- Extended `ClaimRebillService.lineage` to traverse **all successive attempts** from root to newest through immutable `SyntheticRebillLink` records; checks Rx/site membership, increasing attempt numbers and cycles. It can now show a three-attempt rescan/rebill chain from **any** of its fill IDs.
- New regression tests cover 2 COB payer sequences, 2 manufacturer labels, simulated print attempt not being hardware success, reversal/void history, API site/disabled modes, historical tampering detection, rejection-only events and three-attempt chain.

## Boundaries
- Native display remains a development-oriented modal rather than full React parity.
- No real NCPDP claim submission, pharmacy printer proof, payer response, real payment amount, original Prisma data backfill, or real patient dispensing. Never use actual patient data.
- Draft PR #43 only; do not merge. Check this increment's GitHub Actions before marking it validated.
