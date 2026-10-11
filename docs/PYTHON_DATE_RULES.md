# Python synthetic dispensing-date rule port

Extends the original TypeScript `clinical/dateRules.ts` behavior to Python. An optional, pharmacist-controlled 0–365-day minimum interval is stored for each prescription and checked **again at Product Fill start**, including scheduled fills. Every new synthetic pickup records a timestamp in the same database transaction as sale, from either the older single-fill checkout path or the multi-fill POS.

Expiry and do-not-fill-before are also checked with strict date parsing. A **previous SOLD fill lacking an actual recorded pickup timestamp causes a hard block**, never a fabricated timestamp or calculated refill date. Preview endpoints expose block codes and eligibility without claiming a legal or payer-specific refill policy. This interval is a synthetic rule, not an authoritative days-supply, controlled-substance, or insurance calculation.

Date/time comparisons use UTC for reproducibility in the synthetic prototype. Future-dated previews use midnight UTC and may conservatively block the eligibility date until the actual required interval has elapsed. A production replacement requires pharmacy-location timezone policy, certified clinical review, explicit emergency exception handling, clock synchronization, tested legacy date backfill, concurrency protection, and regulatory review.

Migration: `84a672dc47f0`, additive; never backfills missing historical sale dates. Existing Prisma tables untouched. API remains disabled without explicit synthetic-demo flag and does not provide secure real authentication.
