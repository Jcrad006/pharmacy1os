# Pharmacy1OS Python — PostgreSQL backup and offline recovery rehearsal

**Synthetic development only; no real patient data, live dispensing or operational restores.** The original TypeScript application and Prisma tables are not modified.

## Offline PostgreSQL custom archive

`pharmacy1os-postgres-backup create` requires `PHARMACY1OS_SYNTHETIC_DEMO=1`, `PHARMACY1OS_DATABASE_URL=postgresql+psycopg://...`, `PHARMACY1OS_BACKUP_SIGNING_KEY` (at least 32 secret bytes), a local PostgreSQL test instance with only the `py_*` tables and Alembic metadata, and `--confirm SYNTHETIC_OFFLINE_NO_WRITERS`. Install compatible `pg_dump` and `pg_restore` binaries; PostgreSQL 17 requires a client that can dump that server's format. No passwords are placed into command-line arguments: database connection details are passed via `PG*` environment variables. Do not log process environments or backups.

The utility reads document metadata and exports a **REPEATABLE READ PostgreSQL snapshot**. `pg_dump --format=custom --snapshot=...` imports that exact snapshot to keep database metadata and database content aligned. This **does not lock or coordinate the separate filesystem document vault**, so every application/writer must be stopped for the entire operation. The utility rejects non-Python tables, nonlocal PostgreSQL endpoints, unsupported URL query options, unreadable/missing/extra/linked vault files, source hashes that disagree with database metadata, corrupt encrypted files or missing encryption keys. The published archive includes a database custom-format file and verbatim (possibly encrypted) document payloads. A secret HMAC-SHA256 manifest covers database digest, bytes, Alembic revision, document identities, logical SHA-256, raw payload SHA-256, and sizes; `pg_restore --list` validates the dump catalog.

Commands (fictional paths/credentials only):

```bash
export PHARMACY1OS_SYNTHETIC_DEMO=1
export PHARMACY1OS_DATABASE_URL='postgresql+psycopg://synthetic:FAKE_PASSWORD@127.0.0.1:5432/synthetic_demo'
export PHARMACY1OS_BACKUP_SIGNING_KEY='RANDOM_TEST_ONLY_SECRET_WITH_AT_LEAST_32_BYTES'
pharmacy1os-postgres-backup create --vault /tmp/synthetic-vault --backup-root /tmp/synthetic-pg-backups --confirm SYNTHETIC_OFFLINE_NO_WRITERS
pharmacy1os-postgres-backup verify --backup-root /tmp/synthetic-pg-backups --backup-id backup-GENERATED-ID --confirm SYNTHETIC_OFFLINE_NO_WRITERS
```

`verify` is **read-only**. No PostgreSQL **restore** or destructive update command exists. These tools do not prove a production-grade recovery point, concurrency guarantees or backup correctness under concurrent filesystem writes.

## SQLite recovery rehearsal — only new paths

`pharmacy1os-recovery rehearse` verifies a prior signed **SQLite** archive and writes to an **entirely new file path and a never-used vault directory**. Targets must be absent, parent folders must already exist and cannot be symbolic links. A hard-link is used to publish the SQLite file with no overwrite; the destination vault directory is created with `exist_ok=False` so it cannot replace another application directory. A recovery journal is created prior to publication. If a crash or error happens after the first target becomes visible, **leave the partially recovered data and the journal for human inspection**; the tool must not remove a published target automatically. Incomplete staging files are removed. Operators must confirm both offline mode and that destinations are empty.

```bash
pharmacy1os-recovery rehearse --backup-root /tmp/synthetic-backups --backup-id backup-GENERATED-ID \
 --target-database /tmp/new-demo.sqlite3 --target-vault /tmp/new-demo-vault \
 --confirm SYNTHETIC_OFFLINE_NO_WRITERS --confirm-target EMPTY_DESTINATIONS_ONLY
```

The CLI rejects a second invocation aimed at the same restored paths and does not support any restore into an occupied database or a legacy Prisma system. A recovery rehearsal does not make a backup legally compliant for pharmacy operations. There is no automated offsite replication, retention, key rotation, backup schedule, full process write barrier, recovery-time assurance or PostgreSQL restoration in this increment.
