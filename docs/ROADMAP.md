# Pharmacy1OS Roadmap

## Phase 0 — Foundation
- [x] Monorepo layout
- [x] Web workstation shell
- [x] API shell
- [x] PostgreSQL/Prisma schema
- [x] Role and permission model
- [x] Audit-event schema
- [x] CI workflow
- [ ] Validate full stack
- [ ] Initial migration
- [ ] Synthetic seed data

## Phase 1 — Core dispensing
- Patient and prescriber search/registration
- Prescription entry and queue
- Fill creation and future-fill scheduling
- Workflow transitions
- Pharmacist verification
- Refill accounting
- Hold/cancel/transfer
- Audit events for workflow changes

## Phase 2 — Identity/security
- Authentication
- Sessions
- Server-enforced RBAC
- MFA support
- Admin user lifecycle
- Structured security logging

## Phase 3 — Utilities
- Inventory and NDC/product records
- Barcode scanning
- Labels/printing
- Return-to-stock
- Will-call
- Reports

## Phase 4 — Integrations
- Fax
- E-prescribing
- DUR/drug knowledge
- Claims
- PDMP where applicable
- Notifications

## Phase 5 — Production hardening
- Backup/restore validation
- Monitoring
- Deployment automation
- Security/privacy/compliance review
- Performance and failure testing
- Formal release validation
