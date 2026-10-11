# Python-native prescriber directory — synthetic conversion

The Python replacement of the prescriber directory now supports structured multi-record professional identifiers, phone/fax contacts and practice addresses. It is an isolated synthetic prototype and not a credential-verification service or production source of prescriber authority.

## Model and behavior

- `py_provider_identifiers`: NPI, DEA, state-issued and other identifiers with jurisdiction and primary status; normalized search; durable retirement audit rather than silent deletion. Adding or retiring a professional credential requires pharmacist/admin `correct` permission.
- `py_provider_contacts`: multiple phone or fax entries and optional extension, normalized lookup, one active primary per prescriber/contact kind. Technician/intern data entry is permitted with auditing.
- `py_provider_addresses`: multiple structured addresses, one active primary. Existing addresses stay in the record when the primary address changes.
- All three models contain site and prescriber links. Domain methods check that the acting staff member and prescriber belong to the same site. The schema has uniqueness and partial-unique primary indexes for SQLite and PostgreSQL.
- The directory searches by name, normalized phone/fax, and current normalized professional identifiers.
- A `ProviderDirectory` Python service owns the operations; the FastAPI adapter offers synthetic routes under `/api/prescribers/...` and `/api/provider-identifiers/...`, guarded by the existing demo identity mechanism. It is not authentication.
- Alembic revision `230691d35edd` adds only the directory tables/indexes on top of the Python schema baseline, preserving other records.

## Safety and remaining parity work

The service does **not** validate licensing status, DEA registration, NPI check digit, specialty, Medicare participation, or prescriber authority. It does not handle all provider demographics or visual desktop editing yet, and there is no migration/import of legacy Prisma prescribers, contacts or identifiers. Production use must await identity, transaction isolation, independent legal review and legacy-data mapping. Real PHI and real prescriber records are prohibited in this prototype.

## Verification

The Python domain and synthetic FastAPI API have negative-path tests for role enforcement, site isolation, validation failures, primary-record rotation, retained retirement history, and lookup. The PostgreSQL GitHub Actions service database test additionally exercises directory persistence and searches after an Alembic upgrade.
