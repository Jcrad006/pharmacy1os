# Python parity increment 33 — pharmacist intervention ledger and clinical record

**Branch:** `python-native-rewrite`. Follows [increment 32](PYTHON_PARITY_PROGRESS_INCREMENT_32.md). Ports the discrete original TypeScript `InterventionNote` record and read/write prescription clinical API (`apps/api/src/routes/clinical.ts`) into the synthetic Python stack, addressing audit item **RX14**.

- Persisted `py_intervention_notes` with site, prescription, author, note and creation timestamp. Append-only by application design: there is no note-edit/delete method or API. Notes have 1–4000 characters, as in the original TypeScript endpoint, with a database length constraint.
- Only actors with pharmacist-level `clinical` permission can author; authenticated site scope is enforced. Any pharmacy staff with `read` permission at that site can inspect the clinical record.
- `GET /api/prescriptions/{prescription_id}/clinical` combines existing Python DUR issue status with the independent notes; `POST /api/prescriptions/{prescription_id}/interventions` returns the created author-attributed intervention. API remains synthetic-only and disabled by default.
- Free-text intervention documentation does **not** change prescription SIG, resolve a DUR issue, authorize dispensing, or imply prescriber approval. The audit records the event, prescription and author IDs without duplicating free-text protected note content.
- Native PySide6 Dashboard adds **Record Pharmacist Intervention** and **Review Rx Clinical Record** actions for selected prescriptions.
- Alembic additive revision `dfa7206c53e1` follows `c8f20b42d531`; production/live databases and legacy Prisma tables remain untouched.
- Tests cover note integrity and provenance, DUR independence, role/site boundaries, API gate and read/write original-like route shapes.

**Open parity:** original full DUR detail fields, severity enumerations, created/resolved author metadata, date-sorted DUR history, explicit edit/invalidation clinical edge cases and production identity compliance are not yet replicated. This cannot be used with live patient information.
