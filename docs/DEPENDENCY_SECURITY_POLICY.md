# Dependency, SBOM and vulnerability policy

Stage 3L.3 initial security gates:

1. Runtime dependencies are installed only from the committed `pnpm-lock.yaml` in CI with frozen-lockfile. Review both manifest and lockfile changes for new or replaced dependencies.
2. Every CI verification run generates an SPDX JSON SBOM artifact. Preserve the artifact with the run; compare SBOMs on dependency PRs.
3. GitHub CodeQL security-extended scans TypeScript/JavaScript on PRs, main updates, and weekly. The project must verify scanning is enabled and SARIF upload succeeds; a skipped/unlicensed scan is **not** a passing security gate.
4. `pnpm audit --prod --audit-level high` rejects high and critical production dependency advisories. Investigate and fix them by upgrading, replacing, or removing the affected package. Do not automatically mutate dependency versions in CI.
5. Exceptions require a tracked issue with package/advisory ID, affected usage, exploitability analysis, mitigation, responsible reviewer, and expiration. CI bypasses must not be introduced without approval and recorded evidence.
6. Review development-only dependency vulnerabilities on a regular basis even if they do not trigger the production gate. Pin actions to reviewed commit SHAs before production release; this initial stage uses conventional version tags.
7. Generate a new lockfile only through a controlled dependency update PR; test exact versions before merging. Keep runtime security controls separate from synthetic development identities.

None of these measures establish that a regulated pharmacy product is production-safe.
