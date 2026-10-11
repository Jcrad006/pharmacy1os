# Python parity increment 58 — interactive native synthetic Third Party exceptions

Follows [Increment 57](PYTHON_PARITY_PROGRESS_INCREMENT_57.md) in [draft PR #43](https://github.com/Jcrad006/pharmacy1os/pull/43).

## Added
- A dedicated PySide6 **Interactive Third Party Exception Worklist** launched from the native F10 Third Party workspace, with typed status filtering, readable selected rows, paging, refresh, and a privacy-minimized per-fill event provenance viewer. The modal replaces a JSON-only popup for operational navigation without breaking existing actions.
- Pharmacist/administrator-only buttons to **clear an individually selected open mock rejection** and **retry a complete pharmacist-cleared synthetic COB chain**, with multiline documentation and explicit confirmation. Backend role/site and workflow checks remain mandatory and execute in the existing transactional services. Auditor/technician views cannot use the mutating buttons.
- A pure-Python `ThirdPartyRetryPlanner` read-only preflight that scans **all** rejection/resolution events for the selected fill rather than assuming the current exception page contains all holds. It verifies SHA-256 evidence, unique hold-to-coverage ancestry, pharmacist resolution, ordered active eligible patient coverages (1–4), payer active/effective rules and no existing claim or label artifacts.
- The native dialog invokes the existing single- or multi-rejection transactional retry operation only after preflight. All authoritative state is **revalidated** during the mutation, not trusted from the selected UI row.
- Three additional headless regression tests for single-hold planning and site boundaries, incomplete out-of-order batch clearance, and stale coverage/corrupt evidence. No schema change, payer network integration, or new API.

## Remaining parity and release blockers
Qt visual/interaction smoke testing on a real desktop is still required; CI can compile/import Python and exercise headless planners but does not prove the dialog visually works. This synthetic UI cannot adjudicate real payer claims or confirm payment. Separate native claim/correction grids, real payer transport, regulatory validation, production identity, legacy data import, hardware and backup/recovery testing remain outstanding. Do **not** merge or use with real patients; retain the TypeScript production/reference system.
