# Python migration: external transfer workflow, label print queue and concurrency

**Synthetic development only. No real patient data, real prescription-transfer messages, live payer transactions, or production dispensing.**

## Transfer-out: request vs attestation

An outgoing prescription transfer can be requested by a technician/pharmacist in a reviewed or previously sold Rx. The request records the pharmacy, phone, justification and stable idempotency key but **does not transmit anything**. A pharmacist must explicitly attest that a separate external exchange actually occurred, supplying the receiving pharmacist, a reference and a meaningful note. Only then does the synthetic prescription move to TRANSFERRED.

The domain blocks controlled/unidentified drugs, active physical fills, unsold inventories, owed partials, unresolved emergency-supply follow-ups, and pending scheduled fills. Sold prescriptions require at least one available refill. A request blocks starting/scheduling another refill or emergency supply while pending. Pending requests may be withdrawn, but an attested request cannot be undone through the same workflow. Cross-site access is rejected. Request history is conservatively restricted to one transfer-out per source Rx in this increment, even if withdrawn.

The external receiving pharmacy is **not** notified and no transfer-in, refill-balance exchange, receiving pharmacy credential check, audit export, legal verification or live exchange mechanism has been implemented.

Synthetic FastAPI:
- POST /api/prescription-transfers-out with prescription_id, destination_name, destination_phone, reason, request_key
- GET /api/prescription-transfers-out and GET /api/prescription-transfers-out/{id}
- POST /api/prescription-transfers-out/{id}/attest with receiving_pharmacist, handoff_reference, note, personally_confirmed=true
- POST /api/prescription-transfers-out/{id}/withdraw with reason

Native Qt Dashboard actions: Request Transfer Out, Attest External Transfer, Withdraw Transfer Request.

Migrations: additive isolated py_prescription_transfers_out table in revision f1e28b7a45ce, following c4e6bdf912a0.

## Bottle-specific print queue

Each synthetic FILL_PREPARED transaction creates one isolated Python print job **per physically sourced bottle** and stores an independent canonical snapshot and SHA-256 checksum. Contents include the drug, sig, synthetic patient identity, physical part quantity, total physical quantity, NDC, product description and bottle 1 of N metadata. Every print preview repeats SYNTHETIC TEST LABEL - NOT FOR PATIENT USE.

Jobs are never printed automatically and never claim hardware delivery. An authorized pharmacist can record a documented reprint request or, through the native PySide6 workstation, explicitly accept an OS print dialog; this records an audit event followed by a local print attempt. An accepted dialog is **not evidence the hardware printed**, and no standardized thermal-label formatting/calibration or printer fleet management is claimed.

Returning or cancelling an unsold fill voids all queued print jobs and preserves their immutable snapshots and audit history. Later requests against voided jobs fail. A corrupted snapshot checksum fails closed rather than rendering.

Synthetic FastAPI:
- GET /api/label-print-jobs/fills/{fill_id}
- GET /api/label-print-jobs/{job_id}/preview
- POST /api/label-print-jobs/{job_id}/test-reprint with request_key and reason

Native Qt Dashboard: Preview / Print Synthetic Bottle.

Additive migration: a8f167bf70d2 creates py_label_print_jobs and py_label_print_events, after transfer migration f1e28b7a45ce.

## Concurrency

Key Python fill transitions now acquire PostgreSQL row-level locks on a selected fill. Reservation and pharmacist inventory commitment lock the affected Stock rows, and multiple reserved sources are committed in stable stock ID order. Direct pickup and RTS also lock the current fill, with RTS locking stock. The direct fill-start path locks the source prescription.

Two actual PostgreSQL concurrency tests were added: (1) simultaneous 80-unit reservations from a lot holding only 100 units must produce one acceptance and one shortage rejection; (2) two simultaneous scans against the same fill/lot must create only one source.

**Not yet safe for production concurrency:** Every inventory mutation route, multiple-client desktop state refresh, distributed retry/idempotency, PostgreSQL transaction retries and deadlock handling, lock ordering for all supply chain workflows, high-load throughput testing and multi-instance stress testing require further work. SQLite ignores FOR UPDATE, and its synthetic success is not proof of PostgreSQL correctness. The real concurrency tests run only under the isolated PostgreSQL Actions service.

## Release blockers

Production SSO, MFA, identity federation, roles/least privilege hardening, encryption/key management, migrations from legacy data, real payer integrations and receipts, EPCS or transfer certification, North Carolina-specific clinical and transfer requirements, label standards/thermal printers and full desktop workflow parity are still outstanding. No production claims or external communications have been enabled.
