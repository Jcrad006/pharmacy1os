# Python rewrite parity closure — Increment 20

**Baseline:** [2026-10-08 138-feature audit](PYTHON_PARITY_AUDIT_2026-10-08.md), [116 original route inventory](PYTHON_PARITY_ROUTE_INVENTORY_2026-10-08.md), [58 original Prisma models](PYTHON_PARITY_DATA_MODEL_CROSSWALK_2026-10-08.md).

**State:** Feature conversion still in progress. The audit remains an immutable *baseline* for comparison, not a dynamically recomputed % completion. This increment documents the subset of confirmed engineering changes, not a claim of complete parity or real-patient readiness.

## Delivered Python artifacts

- `py_patients.email`; `py_drugs` metadata for brand, route, active state, controlled substance schedule, narrow therapeutic index, biologics, interchangeable biological alternative and cold chain.
- `py_products` active state, package description/type, units per package, package price, therapeutic equivalence code, interchangeable biological flag.
- `py_prescriptions` source type, written date, immutable synthetic electronic source message reference and payload, prescribed product/NDC and product-selection directive (including `DISPENSE_AS_WRITTEN`).
- `PrescriptionEditService`: pharmacist-only revision with expected-version concurrency check, documented human attestation, before/after immutable edit ledger, cross-site denial, active-fill/previous-fill/pending-schedule/transfer blockers, and a reset to Data Entry following a DUR-stage edit.
- Synthetic API enhancements: `GET /api/catalog/drugs`, `GET /api/catalog/products`, `GET /api/prescriptions/{rx_id}`, `PATCH /api/prescriptions/{rx_id}`, `GET /api/prescriptions/{rx_id}/edits`. Prescription GET intentionally does **not** return raw electronic message content.
- Native Qt desktop: explicit detailed drug and product entry, prescription provenance/DAW selector and pharmacist edit control.
- Medication safety validation in Python scan, preparation, pharmacist verification, direct checkout and synthetic multi-line POS. DAW requires an exact prescribed NDC; inactive product or changed drug metadata fails closed even if scanned previously.
- Additive standalone Alembic migrations `c6d923e46a10` (Rx/catalog) and `60a79f2cc141` (immutable edit history). Existing SQLite nullable FK column is added through a supported inline REFERENCES statement rather than unsupported generic ALTER CONSTRAINT. No Prisma tables are changed.
- Regression tests: prescription provenance, DAW mismatch, stale product status, metadata validation, clinical class safeguards, field editing, nonclinical role denial, version conflicts, before/after history, date and schedule checks, and migration from prior synthetic schema.

## Parity issue tracking

| Audit ID | What improved | Remaining gap |
|---|---|---|
| PP03 | Patient email column and primary entry/API added | Search/display/update paths and UI field completeness |
| DR02 | Brand, route, active and cold-chain fields modeled | Exact TS catalog query/update contracts and validated handling |
| DR05 | Package type/size/price and equivalence code modeled | Manufacturer table, dispensing unit/package semantics, cost ledger |
| DR11 / DR15 | Product-selection and active/compliance metadata preserved | Full editable compliance workflow and clinically validated product substitution |
| DR12 / DR13 | NTI/biologic flags recorded | Consent and biologic communication tasks still **missing**, filling fails closed |
| DR14 | Controlled substance schedule now represented | EPCS/legal dispensing rules still **missing**, filling blocked |
| RX02 / RX03 | Rx source, electronic metadata and written date recorded | Real eRx/transfer-in ingestion, validation and source transport missing |
| RX04 | Original prescribed NDC and DAW directive now included | Clinical source authorization/edits after fills not supported |
| RX06 | Pharmacist-reviewed, audited general unfilled Rx editing and version reset | Original full React form/editor parity, provider/prescriber authorization integration |
| RX16 | Dedicated revised Rx edit history API | Rich native integrated Rx detail/timeline display |
| FL01 / FL02 | Physical product cross-check extended to DAW and product active state | Original compliance exception workflows and reauthorization missing |
| FL16 | Revalidation at POS even after product catalog mutation | Entire multi-workstation concurrency graph still needs fault/stress tests |

**Not closed:** payer/coverage/claims, inventory locations/stock allocation/FEFO, receiving discrepancy and inventory exceptions, NTI/biologic/controlled product workflows, real EPCS/eRx/fax/claim switch, full native UI feature parity, original Prisma data conversion and release deployment.

## Safety and migration cautions

- **Conservative upgrade defaults:** existing synthetic legacy drug records receive `controlled_substance_schedule='UNCLASSIFIED'`; this is intentionally **not** a legal classification. Pharmacist/admin classification review is required before a real product could be dispensed. New Python ordinary noncontrolled drugs receive `NONE`.
- **Other unported handling:** NTI/biological/cold-chain products and transfer-in prescriptions are blocked by the synthetic dispensing engine. That behavior prevents accidental representation of unimplemented professional workflows as complete.
- **Electronic metadata:** manually recorded synthetic electronic source payloads are only provenance fields. No EPCS signature, authenticity validation, HL7/NCPDP SCRIPT transport, or regulated messaging exists.
- **Persistent existing demo SQLite:** the new columns require reviewed migration. SQLAlchemy `create_all` cannot upgrade already-existing tables. Never directly replace an existing schema or stamp an old unverified database as latest; run the correct Alembic migration after confirming an appropriate versioned synthetic database and a verified backup.
- `py_*` is independent of legacy Prisma and is not a completed migration of original user data; separate field- and record-level conversion/migration remains a P0 task.
- Successful unit tests cannot establish patient safety or statutory compliance.

## Next high-priority parity increments

1. Port original Payer, PatientCoverage and full claim request/response/outbox schemas; connect four-position coordination of benefits to patient coverage and audited reversal/retry logic.
2. Port warehouse locations, stock positions, FEFO, allocation/demand/backorder and reconciliation exceptions with PostgreSQL concurrent-inventory proofs.
3. Port NTI manufacturer consent and biologic communication, clinical intervention records, remaining exact Rx/packaging/billing fields and integrated native forms.
4. Build field-by-field Prisma data conversion with regression fixtures; original API contract comparisons; native Qt acceptance tests, installer and rollback rehearsals.
