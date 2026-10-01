# Pharmacy1OS

Pharmacy1OS is an early-stage, Linux-friendly open-source pharmacy operations platform intended to become a secure, modular foundation for prescription processing and pharmacy workflow.

> **Development status:** prototype only. Do not use real patient information, protected health information (PHI), production credentials, or this software for live pharmacy operations.

## Current synthetic dispensing prototype

The current prototype includes:

- React + TypeScript pharmacy workstation
- Fastify + TypeScript pharmacy API
- PostgreSQL + Prisma database with versioned migrations
- Site-scoped provider identity records (name + practice level) with attached NPI/DEA/state identifiers, multiple phones/faxes, and multiple practice addresses
- Patient and prescriber registration screens
- Synthetic role/permission architecture
- Prescription entry and live dispensing queue
- Prescription detail workstation
- Separate prescription and fill workflow states
- Original fill/refill numbering and refill accounting
- Future-fill scheduling and scheduled-fill start logic
- Hold/resume, cancel, transfer, Will Call, and return-to-stock
- Pharmacist-only final verification
- Audited prescription editing with before/after changes
- Automatic workflow reset after editing a DUR-reviewed prescription
- Structured synthetic DUR issues
- Pharmacist intervention notes
- Explicit prescription expiration checks
- Configurable synthetic minimum-days-between-fills rule
- Automatic structured DUR issue creation when a date rule blocks dispensing
- Pharmacist/admin DUR resolution controls
- Server-backed queue search by Rx number, drug, patient, or prescriber
- Workflow status filters, oldest/newest sorting, and aging indicators
- Saved workstation queue preferences
- Keyboard-first shortcuts for queue search and primary work areas
- Database-backed dispensing, clinical, and queue-search integration tests
- Drug/Product master with NDC-specific descriptors, package sizes, dispensing units, current unit/package pricing, lots, and expirations
- Catalog Drug selection during Data Entry with fill-time NDC/lot/expiration verification against the selected Drug
- Shared product-barcode registry used by inventory receiving and Product Fill
- F8 Receiving recognizes known GS1/UPC/GTIN identifiers and supports unknown-barcode assignment
- Automated migration, seed, typecheck, test, and production-build validation in CI

Clinical hardening now includes a server-enforced HIGH-severity DUR gate, required resolution dispositions, structured eligibility dates for date-rule issues, and automatic reconciliation of stale synthetic date-rule issues.

## Dispensing model

The standard synthetic processing path is:

```text
Data Entry
   ↓
DUR Review
   ↓
Date-rule evaluation
   ↓
Create / start fill
   ↓
Product Fill
   ↓
Scan/verify NDC + Lot + Expiration against Data Entry Drug
   ↓
Pharmacist Review
   ↓
Pharmacist verification
   ↓
Ready / Will Call
   ↓
Sold
```

A Ready fill may instead be returned to stock. A returned, unsold fill does not consume a refill authorization and can be reprocessed using the same fill number.

## Synthetic clinical/date-rule layer

Pharmacy1OS now contains a development-only clinical workflow architecture.

Before a fill is created or a scheduled fill is started, the API can evaluate:

- configured prescription expiration date
- do-not-fill-before date
- optional minimum days between sold fills

A blocking rule creates or reuses a structured DUR issue such as `RX_EXPIRED` or `REFILL_TOO_SOON`.

Pharmacist/admin development roles can also create synthetic DUR issues, resolve them, and document pharmacist intervention notes.

**These rules are architecture/testing scaffolding only. They are not validated clinical decision support, legal dispensing rules, insurance adjudication, or a replacement for a drug-knowledge vendor.**

## Repository layout

```text
apps/
  api/            Pharmacy API, permissions, workflow, DUR/date rules
  web/            Pharmacy workstation UI
packages/
  db/             Prisma schema, migrations, and synthetic seed
docs/             Architecture, security, development, and roadmap
.github/workflows Automated validation
```

## Local development

Requirements: Node.js 22+, pnpm 10+, and Docker.

```bash
cp .env.example .env
docker compose up -d db
pnpm install
pnpm db:generate
pnpm db:deploy
pnpm db:seed
pnpm dev
```

Then open:

- Workstation: http://localhost:5173
- API: http://localhost:3001
- Health check: http://localhost:3001/health

The workstation offers synthetic staff identities for exercising role behavior. That selector is development-only and is **not production authentication**.

## Safety boundary

This repository remains a development prototype. Do not enter real PHI. Production authentication, encryption, validated clinical content, regulated interfaces, deployment hardening, disaster recovery, formal validation, and applicable privacy/regulatory controls must be completed and independently reviewed before real-world pharmacy use.

## Workstation efficiency

The dispensing dashboard now supports a server-backed working view. Staff can search by Rx number, medication, patient name, or prescriber name; filter to a workflow status; and sort by oldest or newest activity.

Queue settings are stored locally on the workstation so the last working view is restored on return.

Primary menu function keys:

- `F1` — Dashboard
- `F2` — Exceptions
- `F3` — Will Call
- `F4` — New Prescription
- `F5` — Patients
- `F6` — Providers

The workstation intercepts these function keys while active. The existing `/` queue-search shortcut and J/K/arrow queue-row navigation remain available. On keyboards configured to use media controls on the function row, the operating system may require the physical Fn modifier.

## Exception queue and directories

The workstation now includes an **Exceptions** queue derived directly from live pharmacy state. It currently surfaces open synthetic DUR issues, prescriptions on hold, prescriptions waiting for pharmacist verification, and scheduled fills.

There is no separate completion checkbox for these derived exceptions. When the underlying issue is resolved—for example, a DUR issue is resolved or an On Hold prescription is resumed—the corresponding exception disappears automatically.

Patient and provider directory searches are server-backed and support separate Last name, First name, DOB, and phone fields. Results are ordered Last name, First name. Phone matching uses normalized digits so punctuation does not have to match.

## Queue priority and keyboard navigation

A workstation can save a preferred workflow status to **Prioritize**. Matching prescriptions are pinned to the top of the current search/filter results while preserving the server-provided oldest/newest order within the priority group and the remaining group.

When the queue is active and the user is not typing in a form:

- `J` or Down Arrow — highlight next prescription
- `K` or Up Arrow — highlight previous prescription
- `Home` — highlight first result
- `End` — highlight last result
- `Enter` — open highlighted prescription

This preference is local to the workstation prototype and is not yet a production user-profile setting.


## Barcode workflow

The barcode registry stores stable product identifiers separately from variable lot and expiration data. A receiving scan can resolve a known product or flag an unknown barcode for assignment. GS1 AI (01) is treated as the stable GTIN identifier, while parsed lot and expiration values are recorded under the recognized NDC at the pharmacy site. Product Fill uses the same registry and still requires the resolved NDC to belong to the Drug selected during Data Entry.

Third-party adjudication and prescription-label printing remain intentionally deferred to later phases.


## Barcode-assignment correction safety

Barcode-to-product mappings created during receiving are correctable, but correction is restricted to pharmacists and administrators through the dedicated inventory-correction permission. A correction requires the replacement NDC/product and a documented reason. Pharmacy1OS preserves the original assignment in the audit trail, records the old and new Drug/NDC, and warns when the barcode had already been used on prescription fills.

A correction never blindly deletes lot or expiration records from the old NDC. Matching old traceability is surfaced for pharmacist review because those records may represent legitimate stock independent of the incorrect barcode mapping.
