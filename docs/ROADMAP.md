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

## Phase 2B — Staff roles and permission administration
- Define operational roles separately from individual users
- Pharmacy owner / system administrator role
- Pharmacist-in-charge / supervising pharmacist role
- Staff pharmacist role
- Pharmacy intern role with configurable pharmacist supervision
- Certified / registered pharmacy technician roles
- Cashier / pickup-only role
- Inventory / receiving role
- Auditor / read-only compliance role
- Granular permission matrix for prescription entry, editing, processing, verification, sale, clinical documentation, inventory, reports, users, configuration, and audit access
- Site-specific role assignments for multi-location organizations
- Optional per-user permission overrides with explicit audit trail
- Pharmacist-only controls for final verification and designated clinical actions
- Dual-control / second-user authorization for selected high-risk administrative actions
- Temporary role elevation with reason, expiration, and audit logging
- User activation, suspension, termination, and credential lifecycle
- Role/permission change history and administrative audit reports

## Phase 3A — Drug / product / lot master
- [x] Drug concept records
- [x] Multiple manufacturer/NDC products per drug
- [x] NDC normalization and lookup
- [x] Independent lot-number collection under each NDC
- [x] Independent expiration-date collection under each NDC
- [x] Site-specific lot records
- [x] Search by drug, brand, manufacturer, NDC, or lot number
- [x] Drug/Product workstation with F7 navigation
- [x] Database-backed catalog hierarchy/retrieval tests
- [x] NDC-specific descriptor
- [x] Stock-package type and units-per-package
- [x] Dispensing unit support for each, gram, and milliliter
- [x] Current price per dispensing unit and per stock package
- [x] Package/unit price derivation when only one price is entered
- [x] Select catalog Drug during prescription Data Entry
- [x] Allow any catalog NDC associated with the selected Drug during Product Fill
- [x] Verify scanned NDC belongs to the Data Entry Drug
- [x] Verify scanned lot belongs to the scanned NDC at the pharmacy site
- [x] Verify scanned expiration belongs to the scanned NDC at the pharmacy site
- [x] Block Product Fill → Pharmacist Review until NDC/lot/expiration verification succeeds
- [x] Store verified NDC/lot/expiration on the specific prescription fill
- [x] Parse raw GS1/2D barcode payloads into stable product identifier + lot + expiration
- [x] Product barcode registry with multiple barcode identifiers per NDC
- [x] F8 receiving workflow recognizes known barcodes
- [x] Unknown receiving barcode can be assigned to an existing NDC
- [x] Unknown receiving barcode can be carried into F7 and attached while creating a new NDC
- [x] Receiving scan registers newly observed lot/expiration data under the recognized NDC
- [x] Product Fill verifies a single raw registered barcode against the Data Entry Drug
- [x] Pharmacist/admin-only correction of an incorrect barcode → Drug/NDC assignment
- [x] Required correction reason with before/after audit trail
- [x] Correction warns when the old barcode mapping was previously used on prescription fills
- [x] Correction re-registers rescanned lot/expiration under the corrected NDC without blindly deleting old traceability records
- [x] Registered barcode identifiers are searchable in the Drug/Product catalog
- [ ] Third-party claim billing/adjudication during Product Fill
- [ ] Prescription label generation/printing after successful adjudication

## Phase 3H — Inventory ledger and dispensing integration
- [x] Inventory balance by site + NDC + lot + expiration
- [x] Immutable inventory transaction ledger with on-hand and reserved deltas
- [x] Quantity-bearing inventory receiving from scanned stock
- [x] Track optional receiving source/vendor and invoice/reference
- [x] Product Fill reserves the exact fill quantity from the scanned lot/expiration
- [x] Prevent reservation when available inventory is insufficient
- [x] Pharmacist verification commits reserved inventory as dispensed
- [x] Ready-fill return-to-stock creates a reversing inventory transaction
- [x] Cancellation releases uncommitted reservations or returns committed stock
- [x] Prevent negative on-hand inventory and on-hand below reserved quantity
- [x] Pharmacist/admin-only audited manual inventory adjustment
- [x] Inventory ledger workstation showing on-hand, reserved, and available quantities
- [x] Seeded synthetic inventory balances for development/testing
- [x] Database-backed end-to-end inventory ledger tests
- [x] Cycle-count workflow with count sessions and discrepancy review
- [x] Technician/intern physical count entry without immediate stock mutation
- [x] Required submission before pharmacist/admin reconciliation
- [x] Stale-count detection when inventory moves after a recorded count
- [x] All-or-nothing pharmacist/admin approval with audited ledger adjustments
- [x] Cycle-count rejection without inventory mutation
- [x] Cycle-count workstation embedded in F9 Inventory
- [x] Inventory transfers between pharmacy sites
- [x] Pharmacist/admin-controlled transfer shipment from available stock
- [x] Destination-site receipt with recreated lot/expiration traceability
- [x] In-transit cancellation with source-ledger restoration
- [x] Explicit TRANSFER_OUT / TRANSFER_IN / TRANSFER_CANCEL_RETURN ledger movements
- [x] Damaged/expired/quarantined stock disposition
- [x] Quarantined quantity excluded from Product Fill availability
- [x] Staff quarantine action with reason code and optional note
- [x] Pharmacist/admin-only release back to usable inventory
- [x] Pharmacist/admin-only destroy/vendor/reverse-distributor disposition
- [x] Immutable quarantine/release/disposition ledger deltas and audit events
- [x] Cycle-count snapshots and stale checks include quarantined quantity
- [x] F9 quarantine hold queue with active and resolved history
- [x] Recall workflow linking affected on-hand stock and dispensed fills
- [x] Product-wide or lot-specific recall cases
- [x] Automatic quarantine of currently available recalled stock
- [x] Automatic quarantine of newly received stock under an active recall
- [x] Recalled stock blocked at Product Fill reservation and pharmacist verification
- [x] Sold-fill/patient exposure linkage for recall follow-up
- [x] Recall closure documentation without silently releasing quarantine holds
- [x] Purchase orders and wholesaler receiving reconciliation
- [x] Multi-line purchase orders by product/NDC
- [x] Partial receipt tracking with lot/expiration and invoice reference
- [x] Ordered-vs-received quantity reconciliation with over-receipt prevention
- [x] PO receipts linked to inventory balances and immutable RECEIVE transactions
- [x] Pharmacist/admin cancellation of unreceived purchase-order remainder
- [x] Physical inventory locations by pharmacy site (shelf/bin/refrigerator/freezer/safe/receiving/quarantine/will-call/other)
- [x] Stock positions linking physical quantity to balance + location + usable/quarantine state
- [x] Automatic site bootstrap of required storage/quarantine locations and default inventory policy
- [x] Explicit fill-allocation records linking reserved quantity to the prescription fill that owns it
- [x] Inventory demand/backorder records for completion fills, reorder demand, and future supply planning
- [x] Partial-fill completion automatically creates a dated inventory demand for the remaining quantity
- [x] Inventory-demand readiness recalculates when stock is received, returned, quarantined, released, disposed, adjusted, or transferred
- [x] Site/product inventory policy model for reorder point, target stock, FEFO, shelf life, expiration warning, and stale-work thresholds
- [x] Automatic reorder demand when product inventory drops below configured policy
- [x] FEFO lot/expiration recommendations with minimum remaining shelf-life enforcement
- [x] Receiving discrepancy cases for shortage, overage, wrong product, damage, lot/expiration mismatch, invoice mismatch, duplicate shipment, and unexpected product
- [x] Pharmacist/admin-controlled receiving discrepancy resolution with audit trail
- [x] Idempotency keys for receiving, PO receipts, and site-transfer shipment to prevent duplicate stock movements
- [x] Receipt-level acquisition unit cost and extended-cost history on immutable inventory transactions
- [x] Historical inventory balance reconstruction from the immutable ledger at an arbitrary date/time
- [x] Automated inventory exception engine for reorder, expiration, stale reservations/transfers, overdue POs, uncovered demand, stock-position imbalance, and missing acquisition cost
- [x] Transfer chain-of-custody metadata including carrier, tracking, seal/tamper ID, manifest/reference, and custody events
- [x] F8 receiving captures physical location, acquisition cost, and idempotency key
- [x] F9 architecture control center for locations, stock moves, demand/backorders, policy, FEFO, historical projections, exceptions, and discrepancies
- [x] F9 transfer workstation displays and records chain-of-custody events
- [x] PO receiving supports physical receiving location and idempotency key
- [x] Database-backed regression tests for physical positions, allocations, idempotency, projections, demand, FEFO/policy, discrepancies, and transfer custody

## Phase 3I — Dispensing continuity
- [x] Technician-entered partial fill before product reservation
- [x] Partial quantity and intended total preserved separately
- [x] Automatic linked completion fill for the remaining quantity
- [x] Completion retains the same prescription fill number with a separate part number
- [x] Completion fill does not consume an additional authorized refill
- [x] Completion fill scheduled date/time and derived Exceptions prompt
- [x] Completion can start directly from the sold partial without minimum-days-between-fills blocking
- [x] Cancellation/return-to-stock prevents orphaned scheduled completion fills
- [x] Pharmacist/admin-only emergency supply authorization when no refills remain
- [x] Emergency supply requires documented clinical justification and follow-up deadline
- [x] Emergency supply does not fabricate or consume an authorized refill
- [x] Emergency supply still requires Product Fill, inventory reservation, pharmacist verification, and sale
- [x] Emergency follow-up appears in Exceptions until documented complete
- [x] Database-backed partial/completion and emergency-supply workflow tests
- [ ] Jurisdiction-specific policy configuration for emergency quantity/duration, exclusions, notification deadlines, and controlled-substance rules

## Phase 3J — Billing, adjudication & prescription labels
- [x] Separate logical fill quantity from physical dispense-part quantity
- [x] Separate payer-intended quantity from actual physical quantity dispensed
- [x] Explicit primary-claim, completion, and emergency-supply billing roles
- [x] Billing-anchor lineage for completion parts of the same authorized fill
- [x] Same fill number / separate part number for partial and completion dispensing
- [x] Remaining-owed quantity tracked independently from payer-intended quantity
- [x] Product Fill technician can interrupt a scanned/reserved fill and convert it to a partial
- [x] Mid-fill partial conversion atomically releases the original reservation and re-reserves only the physical partial quantity
- [x] Physical shortage/discrepancy creates a high-severity inventory exception without silently changing on-hand inventory
- [x] Pharmacist/admin resolution of physical-stock exceptions requires an audited note
- [x] Quantity architecture documented for claims and label implementation
- [ ] Patient coverage / payer profile model
- [ ] Immutable claim and claim-attempt transaction model
- [ ] Scan-triggered claim construction and adjudication
- [ ] Default synthetic partial strategy submits the full payer-intended logical fill quantity
- [ ] Payer-adapter strategy layer for payer-specific partial/completion transaction rules
- [ ] PAID adjudication automatically generates and queues the physical dispense-part label
- [ ] REJECTED adjudication suppresses dispensing-label generation and routes the fill to a dedicated Third-Party Rejections workspace
- [ ] Third-party rejection correction/resubmission history
- [ ] Claim reversal/rebill lifecycle
- [ ] Cash and coordination-of-benefits pathways
- [ ] Structured prescription label renderer
- [ ] Audited print-job / reprint / failure queue

## Phase 3 — Pharmacy utilities
- [x] Core inventory ledger
- [x] Barcode scanning
- Label generation and printing
- [x] Return-to-stock inventory effects
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
