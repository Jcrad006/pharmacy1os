# Pharmacy1OS

Pharmacy1OS is an early-stage, Linux-friendly pharmacy operations platform intended to become a secure, modular foundation for prescription processing and pharmacy workflow.

> **Development status:** prototype only. Do not use real patient information, protected health information (PHI), production credentials, or this software for live pharmacy operations.

## Current prototype

The current synthetic dispensing prototype includes:

- React + TypeScript pharmacy workstation
- Fastify + TypeScript pharmacy API
- PostgreSQL + Prisma database
- Site-scoped synthetic patients and prescribers
- Synthetic pharmacist, technician, and intern identities
- Prescription entry and live workflow queue
- Controlled workflow-state transitions
- Pharmacist-only final verification transition
- Fill creation and future-fill scheduling API
- Automatic audit-event creation
- Automated migration, seed, typecheck, test, and build validation in CI

## Repository layout

```text
apps/
  api/            Pharmacy API and workflow rules
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

The workstation will offer synthetic pharmacist, technician, and intern identities for exercising role behavior. That selector is development-only and is **not production authentication**.

## Safety boundary

This repository remains a development prototype. Do not enter real PHI. Production authentication, encryption, regulated interfaces, deployment hardening, disaster recovery, formal validation, and applicable privacy/regulatory controls must be completed and independently reviewed before real-world pharmacy use.
