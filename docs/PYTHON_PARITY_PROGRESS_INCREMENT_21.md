# Python parity increment 21 — payer master, patient insurance coverages, synthetic COB lineage

**Status:** Development-only. Porting from the baseline audit [PYTHON_PARITY_AUDIT_2026-10-08.md](PYTHON_PARITY_AUDIT_2026-10-08.md). Original TypeScript/Prisma source preserved. This does not authorize real patient, financial or payer data.

## Data models and invariants

- `InsurancePayer` maps the basic original **Payer** fields into the isolated `py_insurance_payers` table: site, name, BIN, PCN, default group, claim standard (`D0`/`F6`), billing NDC strategy, active. Payer name is unique per pharmacy site; BIN syntax requires exactly six digits when present.
- `PatientCoverage` maps the basic original **PatientCoverage** shape into `py_patient_coverages`: specific patient and payer, COB position **1–4**, member/person/group IDs, relationship, cardholder name and DOB, effective/termination dates, and active state. Only one coverage occupies each patient position.
- `ClaimCoverageSnapshot` associates each newly simulated `Claim` with a specific payer/coverage/position, preserving a snapshot of payer name, synthetic member identifier, group/person code and **full intended billed quantity vs physical part quantity**. It is append-only as part of the same fill preparation transaction. Member identifiers are masked in API responses and omitted from audit metadata. Snapshots are retained after synthetic claim reversal.
- Patient coverage mutations and payer inactivation require pharmacist/admin `correct` permission and are **blocked while the affected patient's PAID_SYNTHETIC claims remain unreversed**. Deactivation is logical, without deleting coverage histories. Every create/change/deactivation produces a site-scoped audit.
- Existing name-only `prepare_for_review(..., payer_names)` behavior remains strictly a **legacy sandbox compatibility path**, so previously written Python tests and callers still work. Such historical/name-only test claims do not acquire fake coverage lineage. For the new coverage-linked path, explicitly pass `coverage_ids` instead of payer names.
- Coverage IDs must belong to the same site and prescription patient; be active and within inclusive effective/termination dates; be in exactly positions 1,2,...N (maximum four), with no duplicate coverage/payer. Only the currently implemented majority-source synthetic NDC selection is permitted. Any unsupported strategy is blocked until implemented. Every simulated claim is recorded with the full intended quantity; physical sourcing stays independent.
- Partial-fill completions do not create another payer claim; emergency fills remain isolated from payer claims.

## New Python API

All non-health endpoints are disabled without `synthetic_enabled=True`, and staff impersonation through `x-demo-staff-id` is **not production authentication**.

| Operation | Endpoint |
|---|---|
| Payer list | GET `/api/third-party/payers` |
| Payer create | POST `/api/third-party/payers` |
| Payer enable/disable | PATCH `/api/third-party/payers/{payer_id}` |
| Patient 1–4 coverages | GET `/api/patients/{patient_id}/coverages` |
| Replace/add position | PUT `/api/patients/{patient_id}/coverages/{position}` |
| Logical deactivation | DELETE `/api/patients/{patient_id}/coverages/{position}` with JSON reason |
| Claim/coverage provenance | GET `/api/fills/{fill_id}/coverage-claim-history` |
| Coverage-linked preparation | POST `/api/fills/{fill_id}/prepare` body `{"payers":[],"coverage_ids":["..."]}` |

The existing `/api/billing/profiles` and `/api/billing/fills/{fill_id}/claim-history` routes remain, with separate historical payer-name synthetic rules; the schema does **not yet** link every named profile revision to payer ID.

## Native PySide6 workstation

On **Third Party**: Create Synthetic Payer, View Payers, Set Patient Coverage Position, View Patient Coverages, Deactivate Patient Coverage, plus existing payer profile and claim history actions. On **Dashboard**: Prepare With Patient Coverages, which requires explicit operator confirmation and leaves actual external adjudication disabled.

These screens are basic Qt actions, not a field-complete recreation of the React third-party workspace.

## Schema and testing

Alembic revision **`d1c21b5981aa`**, following **`60a79f2cc141`**. Adds only three new `py_*` tables, FKs, unique constraints and indexes; no destructive operations against legacy Prisma tables. A new test file `python/tests/test_insurance_coverages.py` checks site/role restrictions, active/expired coverages, ordering, invalid inputs, claim rollback, redacted output, immutable claim snapshots, change restrictions, reversal and synthetic FastAPI routes. CI checks are authoritative; green should only be claimed when completed on this commit.

## Audit closure and explicit gaps

Improved original audit **PP04, BL01, BL02, BL04, BL07**, and part of **BL12**. **These items are still not marked full parity**: payer editing in TypeScript has richer fields; original third-party has claim request/response snapshots, reject codes, authorizations, real claim adapter stubs and an actual rejected-claims workspace; **coverage-linked sequential COB and real payer patient responsibility calculation remain unimplemented**. No claim is sent to any insurer; all `PAID_SYNTHETIC` results are simulated flags, not adjudication.

Next: immutable request/response claim ledger and rejection workspace; source-correction reversal/rebilling, profile-to-payer identity association and position-aware COB adapter interface; comprehensive native Qt payer/coverage forms. Then inventory location/FEFO parity and Prisma-record conversion tests.
