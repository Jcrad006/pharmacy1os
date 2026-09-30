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

## Phase 1 — Core dispensing
- [x] Synthetic staff identity for development
- [x] Patient search API
- [x] Prescriber search API
- [x] Patient registration API
- [x] Prescriber registration API
- [x] Prescription entry API
- [x] Live workstation prescription queue
- [x] Controlled workflow transitions
- [x] Pharmacist-only final verification transition
- [x] Fill creation API
- [x] Future-fill scheduling API
- [x] Audit events for core workflow changes
- [ ] Patient registration workstation screen
- [ ] Prescriber registration workstation screen
- [ ] Prescription detail screen
- [ ] Fill/dispensing workstation screen
- [ ] Refill accounting updates when fills are completed
- [ ] Hold/resume workflow controls in workstation
- [ ] Cancel/transfer workflow controls in workstation
- [ ] Audit-history workstation screen
- [ ] Database-backed integration tests for API workflows

## Phase 2 — Identity/security
- Production authentication
- Sessions
- Server-enforced RBAC hardening
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
- Claims adjudication
- PDMP where applicable
- Notifications

## Phase 5 — Production hardening
- Backup/restore validation
- Monitoring
- Deployment automation
- Security/privacy/compliance review
- Performance and failure testing
- Formal release validation
