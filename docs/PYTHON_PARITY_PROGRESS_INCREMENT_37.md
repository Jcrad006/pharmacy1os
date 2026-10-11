# Python parity increment 37 — original-style prescriber directory aggregate

**Branch:** `python-native-rewrite`. Follows [increment 36](PYTHON_PARITY_PROGRESS_INCREMENT_36.md). Ports the core synthetic domain behavior of original `apps/api/src/routes/prescribers.ts` into a native Python transaction with FastAPI and PySide6 entry points.

## Implemented

- `PrescriberParityService.create` creates one site-scoped prescriber plus up to 30 supplied identifiers, contacts and addresses each, **in one SQLAlchemy transaction**. Invalid child entries abort before or during the transaction; nothing is left partially registered. A single `PRESCRIBER_CREATED` audit records child counts, not credential contents.
- Accepts original TypeScript `firstName`, `lastName`, `practiceLevel`, `dateOfBirth`, `identifiers`, `contacts`, `addresses`, `npi`, `deaNumber`, `stateProviderId`, `stateProviderIdState`, `phone` and `fax` inputs; preserves existing simpler Python `first`, `last`, `level` names. `POST /api/prescribers` now returns HTTP 201 with both the Python `id` and the original-style `prescriber` payload.
- Validation includes calendar DOB, nonempty names, identifier type/number, unique NPI, issuing state for state IDs, primary-per-type/jurisdiction selection, phone/fax digits, complete addresses, and at most one primary record in each contact/address group.
- `GET /api/prescribers` handles original-style case-insensitive name, `Last, First`, practice-level, normalized provider identifier and phone searches, with optional `firstName`, `lastName`, `dateOfBirth`, `phone` filters. Returned providers include structured active identifier, contact and address details, ordered primary first; results stay scoped to the signed-in synthetic site and limited to 100.
- PySide6 Providers workspace now searches by provider names/NPI/phone/practice level, shows DOB/NPI, and supports initial registration with optional DOB, NPI, phone and fax. Existing detailed add-identifier/contact/address controls remain.
- New nullable `py_prescribers.date_of_birth` column, additive Alembic revision `d7f2e57b8c94` after `b6d7198c42e0`, and non-destructive SQLite synthetic-demo bootstrap column upgrade. Historical DOB remains unknown (`NULL`) rather than invented.
- Regression tests exercise atomic multi-child creation, original/legacy request shapes, name/phone/identifier/DOB filters, audit redaction, invalid child rollback, site isolation, access permissions, disabled API and historical null DOB.

## Known differences and safety limits

This does **not** provide verified professional credentials, prescriber licensing, legal order authority or production patient matching. The original routes are prefixed `/api/` in Python, and HTTP errors/metadata fields are not byte-compatible with Fastify. The Python service deliberately rejects multiple explicitly marked primary records instead of silently selecting a winner. Search over large populations is not yet optimized: it scans the isolated site's synthetic directory and invokes nested-record queries per candidate. Existing `ProviderDirectory.details` uses separate authorization semantics, and original provider DOB/search normalization has not been proven by differential cross-language testing.

As throughout the rewrite: **no real PHI, controlled-substance dispensing, claims transmission or live use.** Full TypeScript↔Python feature, schema, GUI, concurrency, disaster recovery and regulatory parity is not complete; the original TypeScript `main` branch is authoritative. Check Python and PostgreSQL workflow results separately before asserting acceptance.
