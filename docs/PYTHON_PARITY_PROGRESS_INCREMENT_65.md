# Python parity increment 65 — durable reviewed-edit idempotency and reconnect safety

**Date:** 2026-10-10. Extends [Increment 64](PYTHON_PARITY_PROGRESS_INCREMENT_64.md) and the [October 10 refreshed parity audit](PYTHON_PARITY_AUDIT_2026-10-10.md) on `python-native-rewrite` / draft PR #43.

## Implemented

- **Atomic, immutable server receipts:** New Python `PrescriptionEditRequest` ORM table `py_rx_edit_requests` records unique `(site_id, request_id)`, Rx, pharmacist actor, original request SHA-256 digest, linked versioned `PrescriptionEdit`, deterministic recorded response, independent response digest and timestamp. Request ID is a canonical UUIDv4. Added additive versioned Alembic migration `18fb732c02a1` after `d52f1ab36c90`; no Prisma tables changed.
- **Replay semantics:** `PrescriptionEditService.update(..., request_id=...)` locks the site-owned Rx row, checks the immutable receipt before checking the current version/status, and returns the **exact original recorded response** for an identical request from the same actor—even if the Rx has subsequently moved to another workflow status. A key reused with different request fields, note, actor or Rx is rejected. Authorization runs again even on replay.
- **Atomic correctness:** The Rx field changes, one versioned clinical edit, its audit event and its request receipt commit together in a single DB transaction. Errors roll everything back; no successful receipt is invented for rejected edits. Legacy edit callers with `request_id=None` retain their existing non-idempotent behavior.
- **Read-only reconciliation:** `GET /api/prescriptions/{rx_id}/review-requests/{request_id}` is site- and original-actor-restricted; `RECORDED` is grounded in a recorded receipt and linked edit. `NOT_RECORDED` is **not** evidence of failure: the operation might still be in flight; response explicitly sets `safe_to_retry=false`. The receipt's SHA-256 is an integrity checksum, **not** a signed or externally witnessed audit attestation.
- **Workstation identity:** The localhost-authenticated client requires a UUIDv4 with every reviewed Rx PATCH and can query the outcome. The native Qt workstation retains the request UUID in its active session; when the response is lost, it queries the receipt rather than resubmitting a potentially duplicate edit. A **Last review receipt** action is available for later review during the same desktop session.
- **Tests:** Independent SQLite tests cover exact replay after status changes, actor/content mismatch, rollback, missing receipts, corruption refusal and UUID validation. Real loopback HTTP tests cover lost responses after commit, verified receipt lookup, same-token replay and operator isolation. PostgreSQL tests run two concurrent sessions with the same UUID, testing identical replay and conflict rejection, and are included in `python-postgres-migrations.yml`.

## Safety boundaries and incomplete parity

Everything remains **synthetic-only** and currently **loopback-only** (the native Qt transport refuses off-host origins), with no live PHI, real dispensing, connected NCPDP claims, fax, signed eRx or third-party financial records. PostgreSQL tests are developer correctness tests, **not** a remote multi-workstation architecture. The client keeps request IDs in memory only; restarting the workstation requires the operator to preserve the displayed token for manual reconciliation, or a future secure request journal. No automated recovery retry is enabled.

This increment does not rescore the 138-item parity audit or establish exact TypeScript model, endpoint or GUI equivalence.

## Next step

Implement an encrypted, bounded client-side **synthetic-only** in-flight request journal and backend reconciliation for reconnect or application restart, without automatically replaying unknown network failures. Continue migrating remaining native workstation workflows behind auditable server transactions and completing the field/route differential audit before any real deployment.
