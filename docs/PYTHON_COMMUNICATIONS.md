# Pharmacy1OS — synthetic Python communication worklist

This increment adds `py_communication_tasks` and append-only-by-service `py_communication_events` to the isolated Python/Alembic schema. It does **not** convert or modify the original Prisma data, connect to a fax service, receive a live electronic prescription, or send an outbound e-prescription. It cannot be used to fulfill a legally prescribed communication requirement.

## Workflows

1. A staff member creates a work item linked to an **existing immutable prescription source document** in the document vault. The document and prescription must belong to the actor's site, and the source bytes must pass the existing SHA-256 vault integrity check.
2. An inbound `FAX`, `PHONE`, or `ERX` work item starts **QUARANTINED**. Only a pharmacist can record **REVIEWED**; reviewing does not create, authenticate, or alter an electronic prescription.
3. Outbound `FAX` or `PHONE` work items start **DRAFT**. A pharmacist explicitly **APPROVES** the source. Staff can then record a manual **ATTEMPT_RECORDED** event with a note; this does not prove a recipient received anything. Repeated attempts are allowed and their event history is preserved. Outbound `ERX` is blocked.
4. A pharmacist can cancel an outbound work item while retaining all event history. Every event records actor identity, timestamp, reason, and an idempotency key; reusing a key with altered details is rejected.

Endpoints (all use synthetic-only development actors and are disabled by default): `GET/POST /api/communications`, `GET /api/communications/{id}/events`, `POST /api/communications/{id}/events`. Native Qt preview has a Communications view with work queue, draft/review/attempt/cancel actions and event history.

## Verification and limitations

Tests cover permissions, site isolation, document-to-prescription matching, SHA-256 integrity, quarantined inbound eRx review, deduplicated requests/events, and the API. Alembic revision `0d31c6f4a822` creates Python-owned tables and indexes only; automatic downgrade is prohibited to prevent loss of audit history. PostgreSQL CI and SQLite schema drift checks validate the committed migration.

**Not finished:** no NCPDP SCRIPT interface, e-prescription signature/certificate/DEA validations, eRx message reconciliation, prescriber identity verification, fax modem/provider integration, delivery confirmation, retrieval receipts, live patient data, legal change authorization, or production authentication. Recorded manual fax/phone attempts are explicitly not evidence of actual transmission or delivery. The old application remains authoritative and unchanged.
