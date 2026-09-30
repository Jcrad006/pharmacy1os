# Development Guide

This guide is intentionally written so a contributor does not need prior Pharmacy1OS knowledge.

## What the pieces do

- `apps/web`: the workstation screens pharmacy staff interact with.
- `apps/api`: the server that enforces workflow, role permissions, auditing, and fill rules.
- `packages/db`: the PostgreSQL/Prisma schema, migrations, and synthetic data seed.
- `docs`: architecture, security boundaries, development guidance, and roadmap.
- `.github/workflows/ci.yml`: automated validation performed by GitHub.

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

The seed step creates synthetic pharmacy staff, patients, prescribers, and prescriptions. It is intentionally safe to rerun.

## Development identity

The workstation contains a synthetic staff selector. The selected value is sent to the API as an `x-dev-user` header.

The API accepts that header only when:

```text
ALLOW_DEV_IDENTITY=true
```

This exists solely to exercise role behavior before production authentication is implemented. It must never be treated as a login mechanism for real pharmacy use.

## Dispensing workflow during development

Prescription status represents the current processing stage. Individual `PrescriptionFill` records preserve each dispensing event.

Important rules currently enforced:

- DUR Review must occur before a fill is created.
- Future fills may be scheduled without immediately entering Product Fill.
- A scheduled fill moves to Product Fill when explicitly started.
- Product Fill must precede Pharmacist Review.
- Only a pharmacist/admin development role can move Pharmacist Review to Ready.
- A Ready fill must exist before the prescription can be marked Sold.
- The original fill uses fill number 0.
- Refills use fill numbers 1, 2, and so on.
- `refillsUsed` changes when a refill is sold.
- A sold prescription may re-enter DUR Review only if refills remain.
- Hold records the prior workflow state so Resume returns to that state.
- Cancel/transfer cancels an active fill.

## Automated validation

CI creates a temporary PostgreSQL database and performs, in order:

1. dependency installation
2. Prisma client generation
3. schema validation
4. all database migration deployment
5. synthetic seed loading
6. TypeScript typechecking
7. unit and database-backed integration tests
8. production builds

The integration test creates its own synthetic patient, prescriber, and prescription and exercises hold/resume, original fill, pharmacist verification, sale, refill processing, refill accounting, refusal of excess refills, and audit-history retrieval.

A green check means those development checks passed. It does **not** mean Pharmacy1OS is compliant, clinically validated, or production-ready.

## Data rule

Use synthetic data only. Never use real patient data, real prescriptions, production credentials, or live pharmacy vendor accounts during development.
