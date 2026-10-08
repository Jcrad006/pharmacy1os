# Stage 3L.3 — Engineering reliability and deterministic builds

**Development implementation merged into `main` at `b3886f338d808b17175437ceb1536814660d3580`.** Scope and exit criteria: [PROGRESSION_MAP.md](PROGRESSION_MAP.md). Stage PR: [#41](https://github.com/Jcrad006/pharmacy1os/pull/41).

## Delivered controls

1. **Deterministic dependencies.** Commit `pnpm-lock.yaml`, pin pnpm 10.17.1 in CI, use `pnpm install --frozen-lockfile`, and reject lockfile drift. A reviewed transitive `deepmerge-ts` 8.x override addresses the advisory affecting Prisma 6.x's prior 7.x dependency; the compatibility of this cross-major override must be reevaluated when upgrading Prisma.
2. **Dependency and source-code review.** CI produces an SPDX-JSON SBOM, runs CodeQL extended JavaScript/TypeScript static analysis, and blocks high/critical production dependency advisories via `pnpm audit --prod --audit-level high`. The [dependency security policy](DEPENDENCY_SECURITY_POLICY.md) defines review/remediation of new findings.
3. **Real Chromium journey.** `apps/api/e2e/dispensing.pw.ts` drives the web workstation through Data Entry → drug/NDC/lot/expiration source scan → sandbox paid claim → physical bottle-label record → pharmacist identity and verification → READY → Will Call bag/bin staging → barcode-confirmed staged checkout → POS and SOLD. Synthetic fixtures are directly seeded; user workflow actions happen in the browser. This verifies label generation and POS accounting, not a physical label printer, hardware scanner, card terminal or live payer.
4. **Deterministic properties.** Seeded randomized GS1/check-digit, stable operation fingerprints and tenancy scope, workflow transitions, and Decimal thousandth-unit/cent rounding tests.
5. **Concurrency/fault integrity.** Tests target simultaneous fill creation (a unique fill number and audit event), prescription state transitions, same-key inventory receipts, duplicate source scans, same-key concurrent POS checkout, and failure injection after a receipt has modified inventory inside a transaction. Tests assert no double stock reservation, duplicate sale, or partial balance/ledger write. The UI additionally ignores stale cross-identity DUR responses and keeps pharmacist verification disabled until the current clinical check completes.
6. **PostgreSQL integrity.** Two stage migrations enforce nonnegative numeric/capacity bounds, foreign keys with site scoping and explicit historical-row validation, plus a cross-site stock-position guard. Invalid preexisting records fail deployment instead of being rewritten. The scope/limitations and migration preflight review are recorded in [STAGE_3L3_DATABASE_AUDIT.md](STAGE_3L3_DATABASE_AUDIT.md).

## Verification and reproduction

The final implementation at `e6974655a97ca36dcb9282996d92a116c0a026df` passed [GitHub Actions CI run 37797738593](https://github.com/Jcrad006/pharmacy1os/actions/runs/37797738593): locked install, SBOM, Prisma generate/schema validation, PostgreSQL migration and seed, API/web tests, TypeScript, dependency audit, build, and the full separate Playwright Chromium browser journey. [CodeQL run 37797738564](https://github.com/Jcrad006/pharmacy1os/actions/runs/37797738564) succeeded.

Locally, with an isolated synthetic PostgreSQL database and the documented development-only environment:
```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:deploy
pnpm db:seed
pnpm typecheck
pnpm test
pnpm audit --prod --audit-level high
pnpm build
pnpm --filter @pharmacy1os/api exec playwright install chromium
# Start API + web development servers with ALLOW_DEV_IDENTITY=true and CLAIM_SANDBOX_ENABLED=true.
pnpm --filter @pharmacy1os/api test:e2e
```

## Boundary and deferred work

This completes the **software engineering reliability stage only**. It does **not** authorize real prescriptions, protected health information, live dispensing, real claims, EPCS, DSCSA reporting or production authentication. Additional tenant/data relationship normalization, crashed-process/restart drills across actual live external transports, performance/load-testing at real store scale, card terminal and physical printer validation, independent clinical/legal review, and multi-site deployment/security assurance remain blockers assigned to subsequent stages. Do not mistake synthetic CI results for a pharmacy release certificate.

**Next development stage: 3M — Production identity, RBAC and security.** Do not begin work on it as part of this PR.
