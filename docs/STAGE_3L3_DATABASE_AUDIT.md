# Stage 3L.3 database invariant audit

**Scope**: database quantity/relationship integrity and server-enforced workflow transitions, in the synthetic prototype only. The SQL migrations are authoritative for the exact constraints. These are safety *hardening*, not clinical/legal validation.

## Numeric invariants and precision

| Domain | Enforced rule | Verification |
| --- | --- | --- |
| InventoryBalance | On hand/reserved/quarantined nonnegative; reserved + quarantined not greater than on hand | Check constraint and negative-path test |
| InventoryStockPosition | Physical position quantity nonnegative | Check constraint |
| InventoryAllocation | Quantity strictly positive | Check constraint |
| Prescription | Refills and optimistic version nonnegative; written quantity nonnegative when supplied | Check constraint |
| PrescriptionFill | Fill number nonnegative; part >=1; requested/intended/physical/owed quantities nonnegative; version/days supply nonnegative | Check constraint |
| PointOfSaleTransaction | Due/tendered/change nonnegative | Check constraint |
| ExternalClaimOperation | Coverage position within 1–4; attempts nonnegative | Check constraint |
| Decimal arithmetic | Thousandths of a dispensing unit preserved in split/remainder calculations; monetary result rounded to cents using decimal arithmetic | Seeded randomized property tests |

The last row documents the test of arithmetic semantics, not a claim that every route is free of rounding errors. Higher-level status-dependent quantity equivalences remain application invariants checked by integration tests.

## Relationship and tenant/site integrity

The existing single-column foreign keys prove entity existence but do *not* alone prove a site-local association. The Stage 3L.3 migrations introduce validated composite foreign keys: prescription → site-local patient and prescriber; patient coverage → site-local patient and payer; document → site-local patient and Rx; annotations/change records → site-local source and Rx; claim/payer billing profile → site-local payer; Will Call package → site-local location; inventory balance → site-local lot and expiration; inventory hold/transaction/allocation → site-local balance. A trigger rejects stock positions whose balance and location belong to different sites.

**Not all relationships are expressible as simple composite foreign keys** without denormalized site IDs. Fill, claim, label, POS, will-call and some transfer linkages traverse a prescription or stock relationship. Their same-site rules require the existing application transaction guards and are candidates for further cross-table triggers or schema normalization before production. Do not treat this audit as an assertion of comprehensive multi-tenant isolation.

The migration checks existing rows rather than silently reassigning bad relationships; site mismatches abort schema deployment. Before applying on a populated database, use coordinated backup plus read-only reconciliation queries. In development, migrations run on seeded PostgreSQL and must pass CI. Never automatically fix a cross-site patient or inventory link.

## Workflow and failure review

Application-layer prescription status transitions are constrained by transition maps and permission checks, with row locking at high-risk state changes. Stage 3L.3 adds locks/rechecks to fill creation and returned-fill reprocessing. A concurrent loser receives an explicit conflict, not a duplicate fill. The DB has a unique constraint on `(prescriptionId, fillNumber, partNumber)`, a secondary backstop.

Receipt and POS idempotency keys are immutable request-fingerprint scoped. Adversarial tests check interrupted inventory transactions roll back balance *and* ledger; duplicate receiving, duplicate product scans, simultaneous fill creation, and simultaneous checkout cannot double-allocate or sell. Synthetic claim operations retain deterministic operation keys and previous Stage 3L.2 ambiguity states, but no live clearinghouse is connected. Cross-process crash/restart and ambiguous external-network reconciliation remain future integration requirements (Stage 3U).

Status correctness cannot be proven from isolated SQL checks alone. Transaction ordering, workflow permissions, and audit event association are validated by API and browser tests. The PostgreSQL checks are a second defense if a route or future background worker is faulty.

## Pre-release boundary

All test patients, stock, claims, payments, and identities are synthetic. Production identity, credential handling, regulated connectivity, complete backup/DR and independent professional validation are explicitly separate exit gates in 3M onward. None of these constraints permits PHI or live dispensing.
