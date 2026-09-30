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
- [x] Patient/prescriber search and registration APIs
- [x] Prescription entry API
- [x] Live workstation prescription queue
- [x] Controlled workflow transitions
- [x] Pharmacist-only final verification
- [x] Fill creation and future-fill scheduling
- [x] Core workflow audit events

## Phase 1B — Full synthetic dispensing workstation
- [x] Patient/prescriber workstation screens
- [x] Prescription detail workstation
- [x] Fill/dispensing controls
- [x] Separate prescription and fill states
- [x] Original-fill/refill numbering
- [x] Refill accounting on sale
- [x] Scheduled-fill start behavior
- [x] Hold/resume/cancel/transfer
- [x] Sale-specific permission
- [x] Audit-history workstation
- [x] Database-backed end-to-end dispensing tests

## Phase 1C — Dispensing depth
- [x] Audited prescription editing
- [x] Data Entry reset after editing a DUR-reviewed prescription
- [x] Return-to-stock workflow
- [x] Ready reversal to DUR Review
- [x] Reprocess returned fills without consuming a refill number
- [x] Dedicated Will Call API/workstation
- [x] Will Call sale/return-to-stock controls
- [x] Database-backed editing/Will Call/RTS tests

## Phase 1D — Synthetic clinical/date-rule workflow
- [x] Prescription expiration enforcement
- [x] Do-not-fill-before enforcement through shared date-rule engine
- [x] Configurable minimum-days-between-fills rule
- [x] Date-rule evaluation for immediate and scheduled fills
- [x] Structured DUR issue model
- [x] Automatic DUR issue creation for blocked date rules
- [x] Manual synthetic DUR issue entry for pharmacist/admin roles
- [x] DUR issue resolution with resolver/time tracking
- [x] Pharmacist intervention-note records
- [x] Clinical/DUR workstation panel
- [x] Database-backed clinical integration tests

## Phase 1E — Workflow efficiency
- [x] Server-backed prescription queue search by Rx/drug/patient/prescriber
- [x] Workflow-status queue filtering
- [x] Oldest/newest queue sorting
- [x] Work-queue aging indicators
- [x] Saved workstation queue filters/preferences
- [x] F1–F6 function-key navigation for primary work areas
- [x] Enter-to-open-first queue search workflow
- [x] Database-backed queue search/filter tests
- [x] Server-backed patient search by Last name, First name, DOB, and normalized phone
- [x] Server-backed provider search by Last name, First name, DOB, and normalized phone
- [x] Provider identity model with practice level/credential (MD, DO, NP, PA, etc.)
- [x] Attached NPI, multiple DEA registrations, and multiple state provider IDs
- [x] Multiple provider phone numbers, fax numbers, and structured practice addresses
- [x] Derived synthetic exception queue
- [x] Clinical/DUR exception category
- [x] On-hold exception category
- [x] Pharmacist-review exception category
- [x] Scheduled-fill exception category
- [x] Exception search/filtering and severity-first ordering
- [x] Database-backed exception lifecycle tests
- [x] User-configurable saved queue priority pinning
- [x] J/K and arrow-key queue row navigation
- [x] Home/End queue jumping
- [x] Enter-to-open highlighted queue row
- [x] Unit-tested stable priority ordering

## Phase 1F — Clinical workflow hardening
- [x] HIGH DUR issues block final pharmacist verification
- [x] DUR resolution requires a documented resolution note
- [x] Structured eligibility date on synthetic date-rule issues
- [x] Automatic resolution of stale synthetic date-rule issues during reprocessing
- [x] Server-enforced verification gate independent of the workstation UI
- [x] Database-backed clinical-gate and reconciliation tests

## Phase 2 — Identity and security
- Production authentication
- Sessions
- Server-enforced RBAC hardening
- MFA support
- Admin user lifecycle
- Structured security logging
- Secrets-management strategy

## Phase 3A — Drug / product / lot master
- [x] Drug concept records
- [x] Multiple manufacturer/NDC products per drug
- [x] NDC normalization and lookup
- [x] Multiple lot numbers and expiration dates per manufacturer/NDC product
- [x] Site-specific lot records
- [x] Search by drug, brand, manufacturer, NDC, or lot number
- [x] Drug/Product workstation with F7 navigation
- [x] Database-backed catalog hierarchy/retrieval tests
- [ ] Associate scanned lot/expiration information with a specific prescription fill

## Phase 3 — Pharmacy utilities
- Inventory
- Barcode scanning
- Label generation and printing
- Return-to-stock inventory effects
- Will-call inventory/location management
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
