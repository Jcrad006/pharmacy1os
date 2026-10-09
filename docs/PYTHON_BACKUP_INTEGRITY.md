# Python migration — offline synthetic SQLite backup and verification

**Not for live patient records or production.** `pharmacy1os.backup` adds a standalone **offline-only** development backup CLI (`pharmacy1os-backup`) for an explicitly isolated SQLite demo database with its immutable prescription document vault. It does not restore the database, use live PostgreSQL, coordinate concurrent workstations, or certify disaster recovery.

A backup **fails closed** when a source is missing, its logical SHA-256/size differs from the database, encrypted source authentication fails, or the vault contains unindexed/orphan files or symlinks. The tool captures a SQLite backup-API snapshot, checks SQLite integrity/foreign keys, requires an Alembic version and enumerates the document table from the snapshot. It copies the **exact stored bytes**, including ciphertext for AES-GCM encrypted vaults, checks each against the snapshot, and produces a signed HMAC-SHA256 JSON manifest. It verifies the staged output before atomically renaming it to a published `backup-*` directory. Failures clean the incomplete stage.

Signing uses `PHARMACY1OS_BACKUP_SIGNING_KEY`, a secret containing at least 32 bytes. Encrypted document verification requires `DOCUMENT_ENCRYPTION_KEY` as 64 hex characters (32 bytes); neither key is stored in the archive. Put signing keys in secure separate storage, not with the backup. **No authenticity guarantee if the signing key is stolen.** File copying and document writes have no shared coordination lock; the operator must stop **all** writers first, and the CLI requires explicit confirmation. The snapshot does not substitute for a multi-process write barrier.

Example (synthetic paths only):

```sh
export PHARMACY1OS_SYNTHETIC_DEMO=1
export PHARMACY1OS_BACKUP_SIGNING_KEY='<64+ unpredictable characters of private test key>'
# Set DOCUMENT_ENCRYPTION_KEY only if demo document encryption is enabled.
pharmacy1os-backup create --database /tmp/demo.sqlite3 \
  --vault /tmp/demo-documents --backup-root /tmp/demo-backups \
  --confirm SYNTHETIC_OFFLINE_NO_WRITERS
pharmacy1os-backup verify --backup-root /tmp/demo-backups \
  --backup-id backup-YYYYMMDDTHHMMSSZ-<generated-id> \
  --confirm SYNTHETIC_OFFLINE_NO_WRITERS
```

Only the operator CLI exposes these actions. There is deliberately **no `restore` command** and no API route. Enforce application downtime externally and test restoration separately in disposable environments before attempting a future production-grade recovery implementation.

Pending blockers: PostgreSQL coordinated consistent dump, concurrent vault writer coordination, off-site immutable encrypted backup policy and secret management, restore journal/rollback, migration compatibility checks, retention, scheduled backup orchestration, and independent recovery rehearsal. Legacy Prisma data are not included or altered.
