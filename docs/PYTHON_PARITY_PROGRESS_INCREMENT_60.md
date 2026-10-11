# Python parity increment 60 — whole COB reversal and replacement rescan tracking

Builds on [Increment 59](PYTHON_PARITY_PROGRESS_INCREMENT_59.md) within isolated draft [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43).

## Implemented
- Integrated a pharmacist/administrator-only **Reverse Entire COB / New Rescan** action into the F10 native prepared COB correction dialog. It uses the existing read-only `CobCorrectionPlanner.plan(target_position=1)` both before and after a documented 12–1000-character reason; an altered payer chain fails closed.
- On explicit confirmation, the action delegates to the existing row-locked `ClaimRebillService.reverse_current_cob` and passes the exact **current** 2–4 synthetic paid payer transaction IDs in descending order. This is version-aware, including payer positions previously corrected multiple times.
- Existing core service transactionally reverses synthetic payer claims, retires unused test labels, releases stock reservations, and creates an independent **unscanned** replacement fill. Desktop displays its exact ID and directs the technician to regular Product Fill scanning; it does not reuse source scans or attempt simulated payer billing automatically.
- Added `CobReplacementTracker.detail`, a privacy-minimized **read-only** validation of site-scoped rebill ancestry, original versioned COB closure, new physical source quantity, and stage: **awaiting rescan**, **awaiting synthetic claim preparation**, **awaiting pharmacist verification**, **verified ready**, or **nonactive reconciliation**.
- Added desktop tracking for the recently created replacement and a persisted exception-queue action to inspect an outstanding replacement after reopening the workstation.
- Added regression tests for three-payer full reversal → blank fill → partial and full rescans → local claim preparation → pharmacist verification, tampered reversal-link rejection, and full reversal of a previously corrected four-payer chain. No schema migration.

## Release blockers
**SYNTHETIC ONLY; no real payer contact, acceptance/settlement, scanner-device integration, actual print, patient dispensing or production use.** The existing TypeScript/Prisma implementation remains unchanged and authoritative. Qt visual interaction, multi-workstation concurrency, controlled-substance and legal workflow parity, production authentication, migration, hardware and PHI-safe recovery remain unverified. Keep PR #43 draft.
