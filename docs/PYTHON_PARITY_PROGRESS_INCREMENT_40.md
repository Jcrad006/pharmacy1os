# Python parity increment 40 — fill billing details

**Branch:** `python-native-rewrite`; follows [Increment 39](PYTHON_PARITY_PROGRESS_INCREMENT_39.md).

- Synthetic-only days supply and chosen billing NDC/product are recorded per fill. Unknown values remain null rather than guessed.
- Guarded, audited per-fill changes permit only an active Product Fill, site-matched operator, and a billing product already present among scanned physical sources; selected source removal must not orphan the billing choice.
- Claim or label history freezes the details. Synthetic payer-operation snapshots reflect the entered days supply and billing selection while retaining the full payer-intended quantity for partial physical fills.
- Migrated Python-only SQLAlchemy schema and compatible existing opt-in SQLite demo database are covered. No conversion of production Prisma data.
- Native Qt detail and FastAPI expose the fields and a guarded editing path. No real NCPDP claim submission is introduced.
- Regression tests exercise invalid inputs, role/site isolation, reversal boundary, source correction, physical vs billed quantity, original-style per-fill projection, and API behavior.

**Not parity-complete:** original payer rules, external claim transport, exact day-supply adjudication and hardware acceptance remain missing. CI results must be checked before marking this increment verified.
