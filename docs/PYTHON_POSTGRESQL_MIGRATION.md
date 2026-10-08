# Python-native database migrations — isolated synthetic track

**Status:** Versioned Python-only persistence baseline. **Not approved for patient data, live dispensing, production identity, or an existing pharmacy database.**

This incremental port adds Alembic schema revisions for the 30 Python-native SQLAlchemy models (`py_*` tables), SQLite demo database baseline registration, schema verification, and a PostgreSQL 17 migration CI workflow. **It does not migrate any Prisma rows, does not replace existing schema or existing staff/patient/Rx data, and does not prove concurrency safety.**

## Safety rules

- The migration tooling requires `PHARMACY1OS_SYNTHETIC_DEMO=1` and an explicit `PHARMACY1OS_DATABASE_URL` using `sqlite+pysqlite:///...` or `postgresql+psycopg://...`.
- The initial revision operates only on `py_*` tables and its own `alembic_version` table. The autogenerate environment excludes Prisma/non-`py_` tables.
- The initial revision is an explicit, version-controlled list of tables, relationships, constraints and indexes, **not** `Base.metadata.create_all()` disguised as a migration.
- Destructive Alembic downgrades are disabled. Recovery must involve an independently verified backup/restore process.
- `stamp-demo` applies **only** to an existing SQLite database, with the confirmation string `I_UNDERSTAND_SYNTHETIC_ONLY`, structural equivalence, no other tables, and successful SQLite integrity and foreign-key checks. It does not modify pharmacy records; incompatible schemas are rejected rather than repaired.
- Existing Python runtime demo bootstrap (`PharmacyService.create_schema()`) remains in the legacy synthetic dev code; it is **not** a substitute for controlled migrations. Do not repoint that bootstrap at PostgreSQL or a real installation.

## Commands

Run from `python/` after installing the Python package with Alembic. Use a disposable SQLite file for tests:

```sh
export PHARMACY1OS_SYNTHETIC_DEMO=1
export PHARMACY1OS_DATABASE_URL=sqlite+pysqlite:////tmp/pharmacy1os-synthetic-migration.db
python -m pharmacy1os.db_cli upgrade
python -m pharmacy1os.db_cli status
python -m pharmacy1os.db_cli verify
alembic check
```

For an *existing* synthetic SQLite demo file created by the current Python model, **only after separately copying that database file to a backup**:

```sh
export PHARMACY1OS_DATABASE_URL=sqlite+pysqlite:////absolute/path/to/synthetic/pharmacy1os.sqlite3
python -m pharmacy1os.db_cli stamp-demo --confirm I_UNDERSTAND_SYNTHETIC_ONLY
python -m pharmacy1os.db_cli verify
```

If it fails, do not force or manually change `alembic_version`. Investigate schema drift and produce an explicit data-preserving revision. `stamp-demo` never converts records from legacy TypeScript/Prisma/PostgreSQL.

For a disposable PostgreSQL 17 database, install `.[postgres,test]`, point `PHARMACY1OS_DATABASE_URL` at that database, and run `upgrade`, `verify`, and `alembic check`. GitHub Actions `python-postgres-migrations.yml` performs this with a synthetic service container.

## What this milestone does **not** solve

A transactional dispensing engine requires proven PostgreSQL row locks, isolation boundaries, operation idempotency, defense against duplicate fills/scans/claims, multi-workstation security, tested restore, fail-safe device/claim integration and regulatory/clinical review. The current Python services have not received those guarantees. The legacy TypeScript implementation remains authoritative until comprehensive migration and parity gates pass. **Never connect to a database holding real PHI or real prescriptions.**
