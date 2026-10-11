# Python parity increment 38 — prescription queue, detail and audit projection

**Branch:** `python-native-rewrite`. Continues Increment 37 and addresses original Rx audit items **RX05, RX16, UI03** in the isolated synthetic Python implementation.

## Changes

- Fixed the prior NPI regression test by prioritizing an already-persisted active NPI before the legacy scalar NPI check. This preserves uniqueness enforcement and differentiates an existing child entry from an identity mismatch.
- Added `PrescriptionDirectory` and read-only `GET /api/prescriptions/queue`, `GET /api/prescriptions/will-call`, `GET /api/prescriptions/{id}`, and `GET /api/prescriptions/{id}/audit`. Existing `GET /api/queue` remains available.
- Queue supports synthetic site isolation, Rx/status/name/prescriber/medication search, explicit oldest/newest ordering, default limit 100 (up to 200), and result metadata. Detail includes selected medication, patient and prescriber, prescription SIG/date/directive, fill attempts, scanned physical sources, mock claims, bottle label snapshots, Will Call custody and current Python transition options.
- Audit timeline enumerates related Rx and fill-subject events with staff role/timestamps in reverse chronology; it **does not** pretend to recover full original TypeScript audit-event schemas or events associated with separate clinical/stock records.
- Original electronic raw-message body is not returned by either projection. Audit metadata is redacted in these read-only endpoints. All endpoints reuse the existing development-only actor check and source-site restrictions.
- Native PySide6 dashboard includes read-only Rx detail and audit buttons. New Python regression tests cover multiple query fields, status/limit/sort, fill contents, raw eRx privacy, audit scopes, Will Call filtering and disabled-by-default API.

## Known differences and release blockers

- Python `Prescription` has no `updated_at`; ordering uses the latest Rx/fill audit event as an **approximation**, explicitly indicated by `updatedAtSource`. Legacy records without events sort at an unknown/fallback timestamp, and audit events emitted for other subjects may not update the queue order.
- Queues currently issue separate SQL lookups per prescription. This proof-of-concept is not optimized for a production-size pharmacy.
- The `allowedTransitions` array reflects the current Python transition map, not exact Fastify workflow parity, and should **not** be used as dispensing authorization. The detail DTO and API return/HTTP errors are not one-to-one copies of Prisma; they omit original fields with no Python counterpart.
- There is **no authenticated live pharmacy identity**, no source-message verification, payer switch, original Prisma migration, functional Qt end-to-end acceptance or legal/clinical validation. No real PHI, claims or prescription processing.
- Review GitHub Actions Python test and PostgreSQL migration results independently before treating this commit as validated. The TypeScript `main` branch remains authoritative.
