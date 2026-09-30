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

## Prescription editing

The prescription-edit API accepts changes to prescriber, medication, strength, dosage form, SIG, quantity, refill authorization, written date, expiration date, and do-not-fill-before date.

Editing is currently restricted to pre-verification workflow states and is blocked when an active fill exists.

Every meaningful edit creates a `PRESCRIPTION_EDITED` audit event with structured before/after values.

If an Rx in DUR Review is edited, its workflow is reset to Data Entry. If an Rx is On Hold from DUR Review, its resume destination is changed to Data Entry. This forces the changed order back through review.

## Will Call and return-to-stock

Will Call is backed by a dedicated API query for prescriptions in `READY`.

A Ready fill can be returned to stock if it has not been sold:

1. the fill becomes `RETURNED_TO_STOCK`
2. the prescription returns to `DUR_REVIEW`
3. `refillsUsed` is unchanged
4. the prescription disappears from Will Call
5. when reprocessed, the same fill record and fill number are reused

This prevents an unsold return-to-stock event from consuming a refill authorization.

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

The integration suite now exercises hold/resume, original fills, pharmacist verification, sale, refill processing, refill accounting, refusal of excess refills, audited prescription editing, workflow reset after editing, Will Call membership, return-to-stock, same-fill-number reprocessing, and audit-history retrieval.

A green check means those development checks passed. It does **not** mean Pharmacy1OS is compliant, clinically validated, or production-ready.

## Data rule

Use synthetic data only. Never use real patient data, real prescriptions, production credentials, or live pharmacy vendor accounts during development.
