# Stage 3L.1 — Document Vault Durability and Coordinated Backup

Stage 3L.1 treats PostgreSQL metadata and the local prescription document vault as one logical clinical record system.

## Safety boundary

A backup is not considered valid merely because a PostgreSQL dump or a folder of document files exists. Pharmacy1OS publishes a backup set only after:

1. document creation is temporarily placed behind an exclusive write barrier;
2. active document writers drain;
3. every database-referenced document passes logical SHA-256 and byte-size verification;
4. PostgreSQL is dumped to a plain SQL file;
5. the exact stored document payloads are copied;
6. a backup manifest and manifest checksum are written;
7. the complete staging set self-verifies.

Only then is the staging directory renamed to its final `backup-...` name.

A failed backup removes its `.incomplete-...` staging directory and is not returned by the backup-list operation.

## Backup contents

Each published backup directory contains:

```text
backup-<timestamp>-<id>/
├── database.sql
├── manifest.json
├── manifest.sha256
└── documents/
    └── originals/
        └── <site>/
            └── <document>.p1doc
```

The document payload is copied exactly as stored. If document encryption is enabled, the backup therefore preserves the encrypted AES-256-GCM payload rather than writing decrypted PHI into the backup directory.

The manifest records:

- Pharmacy1OS backup format/version;
- application version;
- completed Prisma migration snapshot;
- database dump SHA-256 and byte size;
- document ID/site/storage key;
- logical/decrypted document SHA-256 and byte size;
- raw stored payload SHA-256 and byte size;
- document encryption state;
- encryption-key fingerprint, never the encryption key itself.

## Integrity scans

The integrity scanner compares the Document table with the local vault.

Referenced-file failures are `FAIL` conditions:

- missing source file;
- logical SHA-256 mismatch;
- logical byte-size mismatch;
- decryption/authentication failure;
- unexpected read failure.

A physical file under `originals/` with no Document row is reported as an `ORPHAN_FILE`. Orphans produce `WARN`, are never silently deleted, and do not by themselves prevent a backup from preserving all database-referenced clinical records.

Reports are written under:

```text
BACKUP_ROOT/integrity-reports/
```

## Write coordination

Document creation obtains a writer lease before writing source bytes and holds it until the database metadata transaction finishes.

A backup or restore obtains an exclusive lock and waits for active writer leases to drain. No new writer can begin after that exclusive lock is established.

Stale writer markers and stale backup markers may be reclaimed conservatively only when their owning process is no longer alive and the marker is at least five minutes old.

A stale `RESTORE` lock is intentionally different: it is not automatically reclaimed. A process may have crashed after swapping vault directories but before the database restore completed. Pharmacy1OS therefore fails closed and keeps document intake blocked until an operator investigates the restore journal.

## Operator commands

The PostgreSQL client utilities `pg_dump` and `psql` must be installed on the Pharmacy1OS server. They should be compatible with the PostgreSQL server version.

```bash
pnpm backup:create
pnpm backup:list
pnpm backup:scan
pnpm backup:verify -- <backup-id>
```

Restore is deliberately offline-only:

```bash
pnpm backup:restore -- <backup-id> --confirm <backup-id> --offline
```

Before restore:

1. stop the Pharmacy1OS API/workstation service;
2. confirm the configured `DATABASE_URL`, `DOCUMENT_STORAGE_ROOT`, `BACKUP_ROOT`, and document-encryption key;
3. verify the selected backup;
4. keep the service stopped until restore completes and its post-restore integrity scan passes.

There is no HTTP restore endpoint.

## Restore behavior

Restore first verifies the manifest, database dump, all raw payload hashes/sizes, all logical document hashes/sizes, and the configured encryption-key fingerprint.

It then:

1. prepares the backup vault in a restore staging directory;
2. preserves the current `originals/` tree as a rollback copy;
3. swaps the staged backup vault into the active path;
4. runs `psql` with `ON_ERROR_STOP` and `--single-transaction`;
5. rolls the vault back automatically if the database restore fails;
6. performs a post-restore document-vault integrity scan;
7. removes the rollback vault only after that scan succeeds;
8. retains a restore journal under `BACKUP_ROOT/restore-reports/`.

A failed post-restore integrity scan does not silently return Pharmacy1OS to service. The rollback copy is preserved for investigation.

## Administrative API

Only the `ADMIN` role has the `system:backup` permission.

Available development endpoints:

- `GET /api/system/backups`
- `POST /api/system/backups`
- `POST /api/system/backups/:id/verify`
- `POST /api/system/document-vault/integrity-scan`
- `GET /api/system/document-vault/integrity-reports`

Restore remains an offline CLI operation.

## Configuration

```dotenv
DOCUMENT_STORAGE_ROOT=./data/documents
BACKUP_ROOT=./data/backups
DOCUMENT_VAULT_LOCK_TIMEOUT_MS=30000

# Optional executable overrides
# PG_DUMP_BIN=pg_dump
# PSQL_BIN=psql
```

If the vault contains encrypted documents, the same `DOCUMENT_ENCRYPTION_KEY` is required to verify and restore the backup. The backup contains only a one-way fingerprint of that key.

## Explicitly deferred after Stage 3L.1

Stage 3L.1 stops at durability/integrity infrastructure. It does **not** implement:

- scanner/TWAIN/SANE acquisition;
- multi-page PDF/TIFF annotation;
- fax transport;
- e-prescribing transport;
- automatic backup schedules;
- retention pruning;
- off-site replication;
- production disaster-recovery certification.

Those remain later stages.
