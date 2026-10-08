# Stage 3L.3 — Engineering reliability (in progress)

Planning scope and exit criteria: [PROGRESSION_MAP.md](PROGRESSION_MAP.md).

## Initial implementation

- Committed `pnpm-lock.yaml`, generated with pnpm 10.17.1 from the checked-in manifests. CI now uses `pnpm install --frozen-lockfile` and verifies the install leaves the lockfile unchanged. Only reviewed dependency-manifest/lockfile changes may update the graph.
- Generate an SPDX JSON software bill of materials (SBOM) artifact on CI.
- Analyze JavaScript/TypeScript with GitHub CodeQL's extended security queries. Repository-level Code Scanning permissions must be available; absence of reporting is not a clean scan.
- Fail CI on high or critical *production* dependency advisories, pending reviewed remediation or explicitly documented time-limited exemption. Development dependencies still require scheduled review.
- Introduce repeatable seeded property-style tests covering barcode checksums, GS1 metadata, canonical fingerprints, and workflow transition maps.
- Add a concurrent duplicate prescription-transition test that requires one success, one conflict, and exactly one immutable audit event.
- Add PostgreSQL numeric safety checks and a composite same-site foreign key for inventory allocations.

## Data integrity and migration review

The migration intentionally refuses to advance past invalid existing data; it does not coerce quantities or repair records automatically. Before deploying against anything other than the synthetic seeded database, run a read-only preflight, investigate violations, and take a coordinated backup.

Suggested preflight examples:

```sql
SELECT "id", "siteId", "onHandQuantity", "reservedQuantity", "quarantinedQuantity"
FROM "InventoryBalance"
WHERE "onHandQuantity" < 0 OR "reservedQuantity" < 0
  OR "quarantinedQuantity" < 0
  OR "reservedQuantity" + "quarantinedQuantity" > "onHandQuantity";

SELECT a."id", a."siteId" AS allocation_site, b."siteId" AS balance_site
FROM "InventoryAllocation" a
JOIN "InventoryBalance" b ON b."id" = a."inventoryBalanceId"
WHERE a."siteId" <> b."siteId";
```

Remaining integrity scope: audit all cross-site edges (claims, will-call, documents, inventory location, prescription/patient), review same-site constraints and migrate them with explicit validation; inspect fractional rounding and status-dependent invariants.

## Exit gate status

**Not yet met.** A browser-driven full Rx-to-POS journey (including claim sandbox and labels), broader fault injection and stress testing of stock allocation, claims, scans, and POS, and full database-invariant audit remain outstanding. CI results and dependency findings must be reviewed before merging. Do not mark 3L.3 complete or begin 3M based on this initial increment.

This remains a synthetic prototype; do not use live dispensing or PHI.
