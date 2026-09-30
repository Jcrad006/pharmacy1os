# Pharmacy1OS

Pharmacy1OS is an early-stage, Linux-friendly open-source pharmacy operations platform intended to become a secure, modular foundation for prescription processing and pharmacy workflow.

> **Development status:** prototype only. Do not use real patient information, protected health information (PHI), production credentials, or this software for live pharmacy operations.

## Current synthetic dispensing prototype

The current prototype includes:

- React + TypeScript pharmacy workstation
- Fastify + TypeScript pharmacy API
- PostgreSQL + Prisma database with versioned migrations
- Site-scoped patient and prescriber records
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
- Automated migration, seed, typecheck, test, and production-build validation in CI

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

Current keyboard shortcuts (when not typing in a form):

- `/` — focus queue search
- `Q` — dispensing queue
- `N` — new prescription
- `W` — Will Call
- `P` — patients
- `R` — prescribers
- `Enter` in queue search — open the first result
