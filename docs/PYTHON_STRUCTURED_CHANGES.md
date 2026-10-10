# Python prescription change application — synthetic development

Adds `StructuredChangeService` and a versioned Alembic migration after `0d31c6f4a822`.

The Python document vault already has immutable scans and independent annotated change provenance. This increment adds a guarded, explicitly pharmacist-approved **structured application** of documented fields. It preserves the original source bytes and annotation, records document SHA-256, before/after values, staff ID, reason, Rx version, and timestamp in `py_structured_change_applications`, and adds a regular audit entry. Each provenance record can be applied at most once; an applied annotation cannot subsequently be superseded.

Supported structured fields: **SIG, QUANTITY, REFILLS, DRUG, PRESCRIBER**. Noncontrolled drug IDs must exist in the catalog, and new prescriber IDs must belong to the same pharmacy site. Quantity and refill validation is strict. Changes are limited to Data Entry / DUR or a hold from those stages, and any prior fill (including a sold fill), pending scheduled fill, changed Rx version, damaged original, cross-site request, or missing recorded prescriber authorization blocks the operation. Applying while in DUR resets the prescription to Data Entry so clinical review cannot be skipped.

Other documented annotation types **STRENGTH, DOSAGE_FORM, DAW, WRITTEN_DATE, OTHER** remain documentation-only because the current Python Prescription schema lacks corresponding independent fields. Never update the shared drug catalog to simulate a prescription-specific strength change. Use a new reviewed workflow instead.

## Development API

`POST /api/prescription-changes/{change_record_id}/apply` accepts JSON `{"value":"two tablets daily", "approval_note":"Confirmed verbal clarification with prescriber", "expected_version":0}`. The staff actor must have the *clinical* permission. `GET /api/prescriptions/{rx_id}/structured-change-history` returns applications for this site, in version order. Endpoints are under the existing synthetic-only API gate and **do not verify external prescriber authority**. The approval note is a human attestation, not a digital signature, and is not an EPCS/NCPDP or state-law compliance claim.

To migrate an isolated synthetic database use `PHARMACY1OS_SYNTHETIC_DEMO=1` with the existing Alembic CLI. Existing source documents and Prisma tables are preserved. Do not use real PHI or merge as production-ready.

Outstanding: legal authorization verification, electronic communications, regulatory retention, actual production identity and signatures, controlled-substance handling, historic Prisma data migration, multi-workstation concurrency isolation, backup/recovery, and manual Qt validation.
