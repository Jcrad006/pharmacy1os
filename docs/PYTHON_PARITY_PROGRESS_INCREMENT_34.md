# Python parity increment 34 — original-style DUR metadata and resolution provenance

**Branch:** `python-native-rewrite`. Continues [increment 33](PYTHON_PARITY_PROGRESS_INCREMENT_33.md). Completes a substantive subset of original `apps/api/src/routes/clinical.ts`: manual DUR issue creation with title, description and original INFO/WARNING/HIGH severities, status/history, pharmacist resolution with timestamp and actor.

- Added optional `title`, `description`, `source`, `created_at`, `resolved_at`, `resolved_by_id` and `resolved_automatically` to the Python `py_dur_issues` table. Original preexisting synthetic rows retain code, severity, resolved flag and resolution note; unknown historical provenance remains NULL. A named reviewer FK supports Alembic's SQLite batch migration.
- Original-like `POST /api/prescriptions/{id}/dur/issues` and `PATCH /api/dur/issues/{id}/resolve (plus a transitional legacy-Python alias)` respond with structured issue details. The previous Python `/api/prescriptions/{id}/issues` and `/api/issues/{id}/resolve` routes remain backward compatible.
- New manual DUR issues require pharmacist `clinical` authority, a valid issue code/title, and recognized severity; normalized uppercase codes and source `SYNTHETIC_MANUAL` match the reference. A resolved issue cannot be resolved again. Resolution text is stored in the clinical issue row; the general audit stores only clinical record identifiers.
- The existing high-severity unresolved DUR gate is retained on fill creation and pharmacist verification. Recording an intervention note is still distinct from resolving an issue.
- The PySide6 dashboard adds **Document DUR Issue** and **Resolve DUR Issue (Pharmacist)** actions; clinical record viewing includes title/source/timestamp/actor details.
- Alembic additive `f2a19480c63e` follows `dfa7206c53e1`. Synthetic SQLite `create_schema` adds missing nullable metadata columns for previously initialized demo databases.
- Tests cover original-style API paths, severity validation, staff/site access, inability to resolve twice, provenance, and unresolved HIGH gating.

**Important differences remaining:** The original TypeScript backend's full DUR automated rule engine, precise eligibility dates, automatic resolutions, its full JSON shape and all frontend workflows remain incomplete. This is **not** live clinical decision support and should never be used to dispense real prescriptions.
