# Python-native future-fill scheduling and payer billing (synthetic prototype)

> **NOT SAFE FOR LIVE PHARMACY DISPENSING OR REAL PATIENT INFORMATION.** This is a staged Python rewrite, not a complete replacement. Do not migrate or remove the legacy TypeScript/Prisma system on the basis of these modules.

## Why these modules exist

The old React/Fastify/Prisma application supports future-fill scheduling, refills, multiple COB payers, payer-specific configuration, and synthetic adjudication. Earlier Python migration slices only had immediate fill creation and basic synthetic paid claims. This increment ports the following behavior with separate SQLAlchemy tables and an auditable transition path.

## Scheduled fills

- `SchedulingService.schedule()` records a single pending future fill per prescription, a normalized YYYY-MM-DD due date, optional partial dispense quantity, creator, and an idempotency key unique per pharmacy site. Replaying the same key and request returns the existing schedule; conflicting requests are rejected.
- `start_due()` rechecks local date, do-not-fill-before and expiration, pending status, fresh DUR-review status, unresolved HIGH DUR issues, active fills and refill authorization. It creates a fill and updates the schedule in **the same database transaction**. Duplicate successful calls return the original fill ID. It does not submit a claim or move physical inventory before Product Fill.
- A pending schedule prevents an unscheduled `start_fill()` call from bypassing the scheduling controls.
- After a SOLD prescription, `begin_refill_review()` explicitly transitions the Rx to DUR_REVIEW before a new fill. Never assume prior clinical review suffices.
- The scheduler does not automatically trigger background processing, apply jurisdictional refill timing rules, or assert a time zone. All dates use the current date from the process; multi-site local calendar and daylight-saving policy require separate validation.

## Payer profiles and synthetic claim history

- `BillingService.update_profile()` records versioned **site-specific** payer billing profiles. Changes require an existing privileged user and a documented reason; historical revisions are retained.
- The prototype supports a maximum number of physical NDC sources (1–4) and two **synthetic-only** NDC selection strategies (largest-quantity NDC, or first scanned). The resulting selected billing NDC and all actual physical source/LOT/expiry quantities are saved in the immutable-sequence **application-level** claim-operation log. These are sandbox assumptions, **not validated claims-payer rules**.
- Each prepared synthetic COB claim writes a PAID event within the same transaction as the claim and labels. Reversal/RTS/cancel writes a separate REVERSED event. Prior entries are never updated by the Python service; final production integrity needs DB-level append-only protections and independent audits.
- No real claim transport, authorization, rejected claim workspace, cost-sharing calculation, reimbursement, or payer response verification exists. The existing `Claim` table still has a mutable sandbox status for current workstation compatibility.

## Versioned migrations

- `17d52add635c` follows provider-directory revision `230691d35edd` and creates `py_scheduled_fills` with unique site/idempotency keys and a unique index for active pending requests.
- `fe722c185f29` adds `py_payer_billing_profiles` and `py_claim_operations` with uniqueness, relationships, and basic numeric limits.
- Downgrades are intentionally blocked so they cannot silently erase scheduling or claim records. Run Alembic only against isolated synthetic databases using the `pharmacy1os-db` restrictions; **never against production Prisma data**.

## Synthetic local tests

```bash
cd python
PHARMACY1OS_SYNTHETIC_DEMO=1 pytest -q
PHARMACY1OS_SYNTHETIC_DEMO=1 PHARMACY1OS_DATABASE_URL=sqlite+pysqlite:////tmp/pharmacy1os-new-only.sqlite3 python -m pharmacy1os.db_cli upgrade
PHARMACY1OS_SYNTHETIC_DEMO=1 PHARMACY1OS_DATABASE_URL=sqlite+pysqlite:////tmp/pharmacy1os-new-only.sqlite3 python -m pharmacy1os.db_cli verify
```

A native Qt workflow and development-only FastAPI paths are present. The Qt interface has not had a real graphical smoke test. PostgreSQL migration testing, concurrency, finance/security review, parity tests against the legacy app, and migration of existing Prisma records remain blocking release gates.

## Outstanding full-Python conversion

Production identity / MFA and per-site role management; complete legacy Prisma-to-SQLAlchemy data migration; database-level concurrency and financial append-only enforcement; sophisticated third-party billing/rejections/reconciliation; accounting and tender/void/refund/payment terminals; product-tracing and DSCSA; document-vault coordinated recovery; fax/eRx and hardware drivers; controlled substance/EPCS/PDMP compliance; validated clinical knowledge, policies and jurisdiction; independent safety/security testing; comprehensive Qt GUI parity; and production packaging/deployment. The legacy TypeScript stack remains the reference until these gates are met.
