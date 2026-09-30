# Pharmacy1OS Roadmap

## Phase 0 — Foundation
- [x] Monorepo layout
- [x] Web workstation shell
- [x] API shell
- [x] PostgreSQL/Prisma schema
- [x] Role and permission model
- [x] Audit-event schema
- [x] CI workflow
- [x] Initial database migration
- [x] Synthetic seed data
- [x] Automated migration/seed validation against PostgreSQL

## Phase 1A — Core dispensing foundation
- [x] Synthetic staff identity for development
- [x] Patient search API
- [x] Prescriber search API
- [x] Patient registration API
- [x] Prescriber registration API
- [x] Prescription entry API
- [x] Live workstation prescription queue
- [x] Controlled workflow transitions
- [x] Pharmacist-only final verification
- [x] Fill creation API
- [x] Future-fill scheduling API
- [x] Audit events for core workflow changes

## Phase 1B — Full synthetic dispensing workstation
- [x] Patient registration workstation
- [x] Prescriber registration workstation
- [x] Prescription detail workstation
- [x] Fill/dispensing workstation controls
- [x] Separate prescription and fill workflow behavior
- [x] Original-fill and refill numbering
- [x] Refill accounting on sale
- [x] Scheduled-fill start behavior
- [x] Hold/resume with previous-state restoration
- [x] Cancel controls
- [x] Transfer controls
- [x] Sale-specific permission
- [x] Audit-history workstation
- [x] Database-backed end-to-end dispensing integration tests

## Phase 1C — Dispensing depth
- Prescription editing with change audit trail
- Return-to-stock workflow
- Reversal of ready prescriptions
- Will-call queue
- Prescription expiration logic
- Refill-too-soon / date-rule framework
- Basic synthetic DUR issue model
- Notes and intervention records
- Better search, filtering, and queue prioritization
- Keyboard-first pharmacy workflow

## Phase 2 — Identity and security
- Production authentication
- Sessions
- Server-enforced RBAC hardening
- MFA support
- Admin user lifecycle
- Structured security logging
- Secrets-management strategy

## Phase 3 — Pharmacy utilities
- Drug/product/NDC master
- Inventory
- Barcode scanning
- Label generation and printing
- Return-to-stock inventory effects
- Will-call management
- Reports and dashboards

## Phase 4 — External integrations
- Fax
- E-prescribing
- Drug knowledge / DUR vendor adapter
- Claims adjudication
- PDMP where applicable
- Notifications

## Phase 5 — Production hardening
- Backup/restore validation
- Monitoring and alerting
- Deployment automation
- Security/privacy/compliance review
- Performance and failure testing
- Formal release validation
