# Pharmacy1OS

Pharmacy1OS is an early-stage, Linux-friendly open-source pharmacy operations platform intended to become a secure, modular foundation for prescription processing and pharmacy workflow.

> **Development status:** prototype only. Do not use real patient information, protected health information (PHI), production credentials, or this software for live pharmacy operations.

## Current synthetic dispensing prototype

The current prototype now includes:

- React + TypeScript pharmacy workstation
- Fastify + TypeScript pharmacy API
- PostgreSQL + Prisma database with versioned migrations
- Site-scoped patient and prescriber records
- Patient and prescriber registration screens
- Synthetic pharmacist, technician, intern, cashier, admin, and auditor role architecture
- Prescription entry and live dispensing queue
- Prescription detail workstation
- Controlled prescription workflow states
- Separate per-fill workflow states
- Original fill and refill numbering
- Refill accounting updated at sale
- Future-fill scheduling and scheduled-fill start logic
- Hold/resume with the pre-hold workflow state preserved
- Cancel and transfer controls
- Pharmacist-only final verification
- Sale-specific role permission
- Fill and prescription audit events
- Audited prescription editing with before/after field changes
- Automatic workflow reset when a DUR-reviewed prescription is edited
- Dedicated Will Call queue
- Return-to-stock for Ready, unsold fills
- Reprocessing of returned fills without consuming a refill number
- Pharmacist/admin/auditor audit-history view
- Database-backed end-to-end dispensing integration tests
- Automated migration, seed, typecheck, test, and production-build validation in CI

## Dispensing model

A new prescription begins in Data Entry, proceeds to DUR Review, then receives an individual fill record.

A fill can be created immediately or scheduled for the future. Immediate fills enter Product Fill. Scheduled fills remain scheduled until started.

The standard processing path is:

```text
Data Entry
   ↓
DUR Review
   ↓
Create / start fill
   ↓
Product Fill
   ↓
Pharmacist Review
   ↓
Pharmacist verification
   ↓
Ready / Will Call
   ↓
Sold
```

After a fill is sold, a refill may re-enter DUR Review only when authorized refills remain. Refill usage is counted when the refill is actually sold.

A Ready fill may instead be **Returned to Stock**. Return-to-stock marks that dispensing event as `RETURNED_TO_STOCK`, removes it from Will Call, sends the prescription back to DUR Review, and does **not** consume a refill. Reprocessing that returned fill reuses the same fill number.

## Prescription editing

Prescription edits are currently allowed only in pre-verification workflow states and when no active fill exists. The API records a structured audit event containing before/after values for changed fields.

If a prescription that already reached DUR Review is edited, Pharmacy1OS automatically resets it to Data Entry so the changed order must be reviewed again.

Ready, Sold, Cancelled, and Transferred prescriptions cannot be silently edited.

## Repository layout

```text
apps/
  api/            Pharmacy API, permissions, and workflow rules
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

This repository remains a development prototype. Do not enter real PHI. Production authentication, encryption, clinical content validation, regulated interfaces, deployment hardening, disaster recovery, formal validation, and applicable privacy/regulatory controls must be completed and independently reviewed before real-world pharmacy use.
