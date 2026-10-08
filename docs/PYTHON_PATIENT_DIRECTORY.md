# Python synthetic patient directory — first parity increment

The Python `PatientDirectory` matches the TypeScript directory's core per-site search behavior: last/first-name prefixes, combined `last, first`, phone digit normalization, DOB input in ISO or U.S. numeric formats, and capped result size. It validates calendar dates and does not allow users to search other sites. Existing `py_patients` records are reused; no Alembic revision is necessary for these methods.

This is **synthetic-only**. Patient matching and deduplication are not safe for clinical identity verification; no external master-patient-index or cross-system patient synchronization is implemented. The original TypeScript API also supports email; Python `py_patients` does not yet have this field. Legacy Prisma records are not migrated.

Routes: `GET /api/patients/search` and `POST /api/patients/normalized`, behind the existing synthetic development actor gate. These are *not* production authentication.
