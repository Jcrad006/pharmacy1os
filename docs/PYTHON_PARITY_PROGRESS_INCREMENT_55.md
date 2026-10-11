# Python parity increment 55 — atomic multi-rejection synthetic COB retries

Builds on [Increment 54](PYTHON_PARITY_PROGRESS_INCREMENT_54.md) in draft [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43).

## Work completed
- Added `RejectionBatchService.retry`, a pharmacist-only, row-locked, atomic local retry for two to four manually injected test rejections on the same physical fill. All exact original rejection IDs and pharmacist resolution IDs must be submitted in increasing COB position order, and the selected 1–4 active patient coverages must contain every rejected coverage.
- Each original mock rejection receives **its own immutable `TEST_RETRY` event**, referencing its exact original rejection, clearing resolution, ordered COB coverages and stable batch fingerprint. The same SQL transaction prepares all synthetic payer claims and bottle labels once. Nothing calls an insurance network or printer.
- The single-rejection retry is blocked on fills with multiple test rejections rather than incorrectly advancing all payer claims while leaving other mock rejections merely marked cleared. The existing ordinary fill-preparation path now requires matched, hashed `TEST_RESOLVE` **and** `TEST_RETRY` evidence for every documented reject; technicians cannot bypass the hold after it is cleared.
- A replay of the same exact batch returns original retry IDs and prepared claims without mutating inventory or generating duplicate claims. Partial/stale/different batches, wrong payer position, corrupted response hashes, cross-site access and absent resolutions fail closed.
- Added synthetic-only `POST /api/third-party/test-rejections/retry-batch` and native Third Party pharmacist action. Added SQLite tests for completed and rejected workflows, atomic rollback and API permission gates, plus actual PostgreSQL two-pharmacist concurrency regression. No schema migration required.

## Still missing
These are manually injected **development-only** rejection codes, not NCPDP payer responses, prior-authorization transactions, real claims, real settlement amounts or guarantees of a production-safe dispense. The next parity areas include patient-level operational exceptions, reconciliation of corrected COB chains, and actual desktop Third Party interaction parity under synthetic guards. PR remains draft.
