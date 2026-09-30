# Development Guide

This guide is intentionally written so a contributor does not need prior Pharmacy1OS knowledge.

## What the pieces do

- `apps/web`: workstation screens.
- `apps/api`: workflow, permissions, auditing, fill rules, and synthetic clinical/date rules.
- `packages/db`: PostgreSQL/Prisma schema, migrations, and synthetic data seed.
- `docs`: architecture, safety boundaries, and roadmap.
- `.github/workflows/ci.yml`: automated validation.

## First local startup

1. Install Node.js 22 or newer.
2. Install pnpm 10 or newer.
3. Install Docker.
4. Copy `.env.example` to `.env`.
5. Run `docker compose up -d db`.
6. Run `pnpm install`.
7. Run `pnpm db:generate`.
8. Run `pnpm db:deploy`.
9. Run `pnpm db:seed`.
10. Run `pnpm dev`.
11. Open http://localhost:5173.

## Development identity

The workstation synthetic staff selector is sent as an `x-dev-user` header and is accepted only when:

```text
ALLOW_DEV_IDENTITY=true
```

This is development scaffolding, not production authentication.

## Core dispensing behavior

- DUR Review precedes fill creation.
- Scheduled fills are rechecked when started.
- Product Fill precedes Pharmacist Review.
- Only pharmacist/admin development roles may perform final verification.
- Ready fills can be sold or returned to stock.
- Fill #0 is the original; #1 and above are refills.
- Refill usage increments when a refill is sold.
- Return-to-stock does not consume a refill.
- Prescription edits create before/after audit data and can force workflow re-review.

## Synthetic clinical/date-rule behavior

Before a fill is created or a scheduled fill starts, `apps/api/src/clinical/dateRules.ts` evaluates the intended dispensing time against:

1. prescription expiration date
2. do-not-fill-before date
3. optional `minimumDaysBetweenFills` measured from the most recent sold fill

When a rule blocks dispensing, the API returns a conflict response and creates/reuses an open structured `DurIssue`.

Current synthetic DUR codes include:

- `RX_EXPIRED`
- `DO_NOT_FILL_BEFORE`
- `REFILL_TOO_SOON`

DUR issues have severity, status, source, creation time, and optional resolver/resolution time.

Pharmacist/admin development roles have `clinical:document` permission and may:
- create a synthetic manual DUR issue
- resolve an open DUR issue
- add a pharmacist intervention note

These are **not validated clinical rules**. They exist to exercise the architecture that a future drug-knowledge/DUR/claims integration can use.

## Automated validation

CI creates a fresh PostgreSQL service and performs:

1. dependency installation
2. Prisma client generation
3. schema validation
4. all migrations
5. synthetic seed
6. TypeScript typecheck
7. unit + database-backed integration tests
8. production builds

The clinical integration tests verify expiration blocking, refill-too-soon blocking, eligibility-date output, automatic DUR issue creation, pharmacist DUR resolution, role restrictions on intervention documentation, manual synthetic DUR issue creation, and retrieval of clinical records.

A green check means development checks passed. It does **not** mean the product is clinically validated, compliant, or production-ready.

## Data rule

Use synthetic data only. Never use real patient data, live prescriptions, production credentials, or pharmacy vendor accounts during development.

## Derived exception queue

`GET /api/exceptions` builds a work list from source-of-truth pharmacy state rather than persisting duplicate task records.

Current derived categories:

- `CLINICAL_ISSUE`: open `DurIssue` records
- `ON_HOLD`: prescriptions whose workflow status is On Hold
- `PHARMACIST_REVIEW`: prescriptions awaiting pharmacist verification
- `SCHEDULED_FILL`: fill records in Scheduled status

The API sorts higher clinical severity first, then scheduled due time, then age. Because the exceptions are derived, resolving the underlying source automatically removes the exception.

Patient and provider directories use structured server-side filters for last name, first name, date of birth, and phone. Phone search uses a digit-only normalized value, while displayed telephone formatting is preserved.

Primary menu shortcuts are F1 through F6 in sidebar order: Dashboard, Exceptions, Will Call, New Prescription, Patients, Providers. Queue-level J/K, arrows, Home/End, Enter, and / search behavior remains separate.
