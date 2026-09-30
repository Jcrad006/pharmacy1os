# Pharmacy1OS

Pharmacy1OS is an early-stage, Linux-friendly pharmacy operations platform intended to become a secure, modular foundation for prescription processing and pharmacy workflow.

> **Development status:** prototype only. Do not use real patient information, protected health information (PHI), production credentials, or this software for live pharmacy operations.

## Architecture

Pharmacy1OS is being built as a browser-based application that can run on Linux and be accessed by pharmacy workstations on a trusted network. This avoids reinventing Linux itself while preserving the ability to integrate with pharmacy hardware and external services later.

## Foundation included

- React + TypeScript pharmacy workstation UI
- Fastify + TypeScript API
- PostgreSQL data layer using Prisma
- Role and permission model
- Initial pharmacy domain schema
- Audit-event data model
- Local Docker development database
- Automated CI checks
- Architecture, security, and roadmap documentation

## Repository layout

```text
apps/
  api/            Pharmacy API
  web/            Pharmacy workstation UI
packages/
  db/             Prisma database schema and client
docs/             Architecture, security, and roadmap
.github/workflows Continuous integration
```

## Local development

Requirements: Node.js 22+, pnpm 10+, and Docker.

```bash
cp .env.example .env
docker compose up -d db
pnpm install
pnpm db:generate
pnpm dev
```

Development addresses:

- Web: http://localhost:5173
- API: http://localhost:3001
- Health: http://localhost:3001/health

## Safety boundary

This repository is development scaffolding. Authentication, encryption, PHI safeguards, regulated interfaces, deployment hardening, validation, disaster recovery, and compliance controls must be completed and independently reviewed before real-world pharmacy use.
