# Python parity increment 63 — native authenticated reviewed SIG change

Extends [Increment 62](PYTHON_PARITY_PROGRESS_INCREMENT_62.md) and the [October 10 parity audit](PYTHON_PARITY_AUDIT_2026-10-10.md), addressing PL03/PL07/PL11, RX06/RX16 and UI03 on `python-native-rewrite`.

## Work delivered

- The local session-mode FastAPI exposes an authorized, read-only `GET /api/prescriptions/{rx_id}/edit-context` using the already implemented `PrescriptionEditService.context`. It returns the current version, allowed edit state and candidate values; no new SQLite/Prisma data schema and no new editing rules.
- The separate-process `LocalSessionWorkstationClient` now exposes `edit_context` and `review_sig`. **One narrow, documented pharmacist-reviewed SIG change** is permitted through existing `PATCH /api/prescriptions/{rx_id}`, with the original `PrescriptionEditService.update` rechecking `expected_version`, site, clinical role, editability and pending-fill constraints inside a locked database transaction. A successful edit creates the existing versioned edit record and audit event and resets DUR review according to existing backend logic.
- The HTTP transport allowlist now permits just that versioned SIG PATCH, verifying exact payload fields, nonempty new SIG, valid integer version, full 12–2000-character review documentation, and forbidding arbitrary Rx changes, all fill/claim/payment/inventory requests, redirects and off-localhost access.
- The independent native PySide6 preview adds an explicitly pharmacist/administrator-only **Review SIG** action. It reads the editor context, collects new SIG and review documentation, **rechecks without silently replacing its captured version**, asks for confirmation and sends the original version to the server. Stale windows must refresh and start over.
- Failure/reconnect rule: **no automatic retry for any PATCH after a transport loss**. A lost response could mean the server committed. Operators must inspect the newly fetched Rx version and its redacted audit before considering further edits. Response status 409 reports stale/blocked action, never a success claim.
- Added actual local-socket regression tests with *two separate authenticated clients*: successful reviewed edit and DUR reset, stale second-client conflict (no duplicate history), persisted attestation without audit text leakage, unauthorized technician, cross-site access and client-side rejection of non-SIG mutations.

## Limits

This is **not** yet the full native prescription editor: only SIG changes, not multi-field Rx review, original React UX, writes to other modules, or a network-accessible pharmacy service. The pilot is **localhost HTTP only** for fictional records, with synthetic accounts. No production authentication/TLS, real PHI, eRx, payer, physical dispensing or clinical validation. The old local SQLite desktop is unaffected; this code does **not** signify exact TypeScript parity.

**Next:** generalize authoritative per-workflow version checks and idempotency to controlled server-side mutation endpoints; implement reconnect-safe client state handling and PostgreSQL multi-process acceptance tests. Preserve independent TypeScript/Prisma source and review all clinical/legal constraints before any live use.

## Stale-status review precondition

A prescription can progress from Data Entry to DUR Review without changing its edit version. The authenticated workstation therefore now sends both the captured version and the original review **status**; the existing server-side Rx editor compares both under the row lock before allowing the modification. Existing direct edit clients without a status precondition remain backward compatible. Tests simulate a stale Data Entry window where status changes but version does not, and require a fresh review instead of a silent overwrite.
