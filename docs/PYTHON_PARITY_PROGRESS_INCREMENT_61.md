# Python parity increment 61 — cross-workstation race safety and full rebill ancestry

Follows [Increment 60](PYTHON_PARITY_PROGRESS_INCREMENT_60.md) in draft [PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43).

## Delivered
- Hardened read-only `CobReplacementTracker.detail` to reconcile **every historical original→replacement link**, not just the most recent, before reporting a multiple-attempt synthetic rescan status. Each prior fill must be returned, belong to the same site/Rx, connect to the immediately next attempt, and have a fully reversed and mirrored versioned payer ledger matching the stored claim-ID snapshot. An earlier altered link now fails closed even when later attempts look normal.
- Added a headless three-attempt test that performs two independent synthetic full-COB reversals, verifies the latest replacement status, tampers with the **first** historical link and ensures the tracker refuses to conceal it.
- Added PostgreSQL 17-only dual-workstation adversarial concurrency tests: **verify versus whole-COB reversal** (exactly one may succeed and inventory either dispenses once or releases once), and **selective payer correction versus full reversal** (exactly one may succeed, stale paid IDs are refused, and claims/stock/replacement lineage reflect the winner).
- Included these tests in the migrated PostgreSQL GitHub Actions workflow. No schema migration, new external API, real payer activity, printer output, or PHI is introduced.

## Still missing
These tests establish invariants under two concurrent operations on the disposable PostgreSQL CI service; broader fault injection, lock timeouts, cross-process workstations and live Qt interaction remain unverified. SQLite's single-process demo is not a substitute for PostgreSQL multi-user safety. Full production-grade TypeScript parity, payer transaction integration, authentication, regulatory rules, backup restoration and safety validation are outstanding. PR remains draft, **synthetic use only**.
