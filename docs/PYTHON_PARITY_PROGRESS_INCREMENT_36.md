# Python parity increment 36 — original-style patient directory and native registration

**Branch:** `python-native-rewrite`; follows [increment 35](PYTHON_PARITY_PROGRESS_INCREMENT_35.md). Continues the synthetic-only rewrite of the original `apps/api/src/routes/patients.ts`, especially audit items PP01–PP03 and UI04.

## Completed in this increment

- Python `PatientDirectory.create` now passes through optional email with the existing service's trimmed / size-limited / basic syntax validation; directory reads expose email. No schema change is required because `py_patients.email` already exists.
- Added original-style `GET /api/patients` accepting `query`, `firstName`, `lastName`, `dateOfBirth`, and `phone`. Results are site-scoped, limited to 100, and use camelCase response fields, alongside the retained `GET /api/patients/search` Python interface. Search handles case-insensitive name prefixes, `Last, First`, digit-normalized phone substring and normalized DOB.
- Original-style `POST /api/patients` now accepts `firstName`, `lastName`, and `dateOfBirth` while preserving previous Python `first`, `last`, `dob` request fields and top-level `id` response. It also includes a `patient` envelope with core original-compatible fields and returns HTTP 201.
- Native PySide6 Patients workspace supports first/last/DOB/phone/email on registration, displays email in search results, and opens a selected patient's read-only details. Optional inputs support blank values and cancellation.
- New targeted regression tests check both API request shapes, legacy alias, DOB/phone/name filters, email, auditing, site privacy, non-writer denial, invalid calendar dates and synthetic-disabled API.

## Explicit gaps and safety

- This is **synthetic-only** and **not full patient record parity**: no high-assurance patient matching or deduplication; no production PHI controls, printing, or production workstation identity verification. Do not enter real patient information.
- The Python endpoint uses the `/api/` prefix, not the original application's root route; legacy `createdAt`, `updatedAt` and `phoneSearch` database fields are not replicated. Date validation is intentionally stricter than the TypeScript date parser, and Python workflow errors return 409 instead of every original HTTP error status. These are *not* bit-for-bit HTTP or schema parity claims.
- The TypeScript reference remains authoritative. The Python prototype still lacks full UI workflows, legacy Prisma migration, external pharmacy integrations, and clinically validated operation.
