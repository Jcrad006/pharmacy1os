# Pharmacy1OS Python Parity Increment 66 — protected workstation request journal

**Branch:** `python-native-rewrite` · Draft PR #43 · October 10, 2026 · Previous: [Increment 65](PYTHON_PARITY_PROGRESS_INCREMENT_65.md) · Baseline: [October 10 parity audit](PYTHON_PARITY_AUDIT_2026-10-10.md)

## Delivered

The native Qt localhost client now has a **restart-surviving, encrypted, synthetic-only request recovery journal**. The prior implementation persisted receipts on the server but stored in-flight request identifiers only in desktop process memory.

1. **`workstation_recovery_journal.py`**: stores at most 64 metadata-only request records, with request UUIDv4, prescription UUIDv4, site and staff UUIDs, validated loopback origin, UTC creation timestamp, and `PENDING`/`RECORDED` state. **No SIG, quantity, clinical attestation, eRx, other patient details, session tokens or passwords** are written to the journal. Uses Fernet authenticated encryption (from the existing `cryptography` dependency) with a separately saved, local 0600 key. Storage is a local 0700 private directory with 0600 files, owner checks, symlink denial, 64 KiB encrypted file cap, and a POSIX `flock` single-desktop lock. Every save goes to an exclusive temporary file, is fsynced, atomically replaced, and then synchronizes its directory. Invalid schema, unreadable key, altered ciphertext, excessive entries, unsafe permissions, or second-owner lock fail closed.
2. **`workstation_recovery.py`**: a strict mutation boundary writes the pending request ID to the encrypted journal **before** making an authenticated reviewed-edit HTTP PATCH. If journaling fails, **no request is transmitted**. A successful server response marks the local record as recorded. A lost response leaves a durable pending entry; there is **no automatic retry**.
3. **Post-login recovery:** The Qt preview opens the local journal after authenticating a synthetic pharmacist/administrator account. If journal verification fails, it refuses to open the editing-capable preview. A small read-only startup reconciliation batch checks existing pending IDs, and the user may select **Reconcile pending reviews** or **Last review receipt**. Only the authenticated account's records at that loopback origin are accessible. `RECORDED` is checked against the server's immutable receipt. `NOT_RECORDED` **does not mean failed** and stays pending. The operator may explicitly acknowledge confirmed receipts, removing them from the local journal only; their original server receipts and audit remain.
4. **Tests:** encrypted restart and three-session round-trip; corrupted ciphertext and missing/invalid key; insecure permissions, symlinks, concurrent journal lock, second account isolation, 65th-request refusal, nonloopback origin denial, pre-send failure with a full journal, actual local-socket committed-but-lost response followed by restarted workstation read-only reconciliation, and offline/unknown readback without any mutating request.

## Local demo requirements

This pilot supports **Linux/macOS POSIX local workstations**; Windows locking/permissions are not yet implemented. Python 3.12+ and `cryptography` are already package dependencies. Both desktop and server still run on **the same computer** and use localhost-only session authentication; refer to [Increment 62 setup](PYTHON_PARITY_PROGRESS_INCREMENT_62.md).

For the default journal directory, check that each managed directory is privately owned and has mode `0700`: `~/.pharmacy1os`, `~/.pharmacy1os/synthetic`, and `~/.pharmacy1os/synthetic/workstation-recovery`. If a previous demo installed its parent directories with permissive permissions, the new workstation **refuses to journal and submit edits** until permissions are intentionally corrected by the user. The key and encrypted file are in the recovery directory. Do not copy, reset, remove, or rename either while unacknowledged requests exist: **the key is necessary to recover pending metadata**. Never share the local journal.

## Security and limitations

- **Encryption is not production key management:** The local encryption key lives beside the encrypted journal under OS file permissions. This protects against incidental file disclosure/tampering but **not** compromise of the same logged-in OS account, privileged access or a malicious local administrator. A future production application requires managed key storage, workstation identity, approved full-disk encryption, and threat-model review.
- A POSIX advisory lock prevents multiple instances cooperating on the same journal; it is **not** a distributed network lock. No other signed application or unmanaged process should mutate this directory.
- The local journal is not the authoritative event record; only the server-side committed receipt tied to the audited prescription edit can demonstrate that a request committed. The journal stores no planned change values and **cannot safely resubmit** uncertain requests.
- Old/recovered request records are not automatically deleted, even if stale. The user must reconcile and explicitly acknowledge `RECORDED` receipts; a limit of 64 prevents unbounded local retention. `PENDING` entries cannot be acknowledged without a server receipt.
- Startup checks are capped at two pending requests to avoid long UI blocking, with manual batches capped at 16; the Qt UI currently performs those read-only operations synchronously, so responsiveness still requires future worker-thread integration.
- The desktop/HTTP client remains a **synthetic localhost-only prototype**, not a remotely usable production pharmacy. No PHI, live electronic prescriptions, claims, payments or dispensing are supported. This increment **does not certify TypeScript parity**.

## Next priorities

Review the complete CI matrix, add explicit test/patch coverage for error and permission edge cases, move read-only reconciliation off the Qt main event loop, and continue the 138-item audit closure with cross-language endpoint/field comparisons and PostgreSQL fault recovery. Remote multi-workstation service should not be exposed until secure transport and authorization are independently reviewed.
