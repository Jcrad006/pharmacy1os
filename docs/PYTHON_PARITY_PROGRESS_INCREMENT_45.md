# Python parity increment 45 — atomic corrected synthetic rejection retry

Follows [Increment 44](PYTHON_PARITY_PROGRESS_INCREMENT_44.md), narrowing baseline **BL06**, **BL07**, **BL09** and API/Qt Third Party workspace gaps.

## Implemented
- A pharmacist can invoke `SandboxClaimService.retry_cleared_rejection` after a documented resolution of a manually injected synthetic hold. It requires an exact resolution ID as a stale-screen compare-and-swap precondition, a 12–2000 character justification, and ordered 1–4 current insurance coverages including all previously rejected coverage IDs for that fill. Other unresolved holds, mismatched COB, bad physical sources, inactive payers, or existing claims/labels block retries.
- `PharmacyService._prepare_for_review_tx` is a transaction-scoped extraction of the existing label/claim preparation path; normal `prepare_for_review` still wraps it. Retry records an append-only `TEST_RETRY`/`RETRIED_SYNTHETIC` operation linked to the original rejection, then prepares all local payer claim/label records **in the same database transaction**. Failure rolls back the retry event and all claims/labels. The mock paid result remains local only.
- Migration `b1e7c92d401a` extends exactly the synthetic transaction operation/outcome CHECK constraints; it preserves historical rows. `rejection_queue` shows the new `RETRY_PREPARED_SYNTHETIC` and `retry_id` status without equating this to external payer approval.
- New FastAPI `POST /api/third-party/test-rejections/{rejection_id}/retry` and native Qt Third Party pharmacist action, guarded by synthetic/demo mode and pharmacy-site permissions.
- Regression tests include cleared vs uncleared holds, pharmacist permissions, other sites, stale resolutions, incomplete or misordered payer selections, failed source scans/claim adapter rollback, immutable history corruption, API restrictions and true PostgreSQL multi-workstation retry race.

## Outstanding
This is an explicit **test-rejection correction flow**, not a genuine NCPDP rejected-claim resubmission or authenticated insurer adapter. An earlier cleared test hold may still be prepared through the existing legacy `prepare_for_review` path; that compatibility path does not synthesize retry provenance. No real payer switch, hardware printer acknowledgement, live checkout pricing, original Prisma migration, or production authentication. PR #43 must remain draft.
