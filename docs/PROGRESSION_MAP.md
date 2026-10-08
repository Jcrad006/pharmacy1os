# Pharmacy1OS — Progression Map

**Status:** Adopted planning baseline following merged Stage 3L.2 (PR #39).
**Baseline commit:** `b655fafa284b367a384747d1f453fd0a41cac900`
**Created:** 2026-10-08
**Role:** The *sequencing and release-gate companion* to [ROADMAP.md](ROADMAP.md). The roadmap tracks implemented functionality; this progression map defines what to build next, why the order matters, and what evidence is needed before advancing.

> **Clinical-use boundary:** Pharmacy1OS is a synthetic development prototype, not approved or validated for live dispensing or real PHI. Completion of a software stage does not imply legal compliance, EPCS certification, DSCSA readiness, security certification, or permission to pilot with real patient data.

## Progression at a glance

```text
Merged foundation through 3L.2
         |
         v
3L.3 Engineering reliability and deterministic builds
         |
         v
3M   Production identity, RBAC, and security
         |
         v
3N   Operational resilience and disaster recovery
         |
         v
3O   Versioned clinical and jurisdiction policy engine
         |
         +------------------------+
         v                        v
3P   Controlled substances      3Q   DSCSA traceability
     EPCS/PDMP architecture           and package verification
         +------------------------+
         |
         v
3R   Complete POS financial lifecycle
         |
         v
3S   Local device / hardware service
         |
         v
3T   Durable fax and eRx communications
         |
         v
3U   Live third-party claim transport and reconciliation
         |
         v
3V   Clinical knowledge and validated DUR integration
         |
         v
4A   Reporting, operational dashboards, compliance intelligence
         |
         v
5A   Deployment and formal release validation candidate
         |
         v
5B   Independent controlled-pilot readiness assessment
```

The display is the recommended **default implementation sequence**, not a claim that every subtask must execute strictly one after another. Independent research, vendor selection, compliance review, and procurement may occur in parallel. No live regulated connectivity or clinical use is enabled merely because a prerequisite stage has merged.

## Development rules applying to every stage

1. **Scope a branch/PR to its named stage.** Document any intentionally deferred work rather than presenting scaffolding as production-ready.
2. **Safety boundaries are server-enforced**, not only UI warnings; critical transitions fail closed.
3. **Schema migrations are backwards-safe**, with migration/seed validation against PostgreSQL and attention to existing records.
4. **Prove the stage with targeted and negative-path tests**, plus typecheck, full integration suite, security gates, and build. Add concurrency/fault-injection tests when relevant.
5. **Use durable audit and provenance records** for high-risk clinical/financial actions; distinguish ordinary user authorization from production authentication.
6. **Require human/independent review where appropriate** for clinical rules, controlled substances, privacy/security, EPCS and DSCSA; automated tests alone do not validate legal correctness.
7. **Keep artificial/synthetic adapters visibly separate** from live claims, hardware payments, actual eRx, and real clinical knowledge.
8. **Advance only after an explicit exit-gate review**; recording a stage as complete in GitHub means its defined code/tests/docs landed, not that the entire product can be deployed.

## Stage 3L.3 — Engineering reliability and deterministic builds

**Purpose:** Make the existing engine reliably testable, reproducible, and adversarially verified before adding new integrations.

**Build:**
- Commit `pnpm-lock.yaml`; enforce frozen-lockfile installation and controlled dependency updates.
- Add software bill of materials (SBOM), source-code security checks (SAST), and clear vulnerability update policy in CI.
- Establish browser end-to-end (E2E) tests for `Data Entry → Product Fill → claim sandbox → label → Pharmacist Review → READY → Will Call / immediate pickup → POS`.
- Add property/fuzz testing for GS1 parsing, quantities/rounding, fill-numbering, status transitions, and idempotency fingerprints.
- Add adversarial concurrency/fault-injection tests for Rx transitions, duplicate scans, inventory allocations, claim operations, POS, and interrupted writes.
- Audit numeric/relationship/status invariants and enforce applicable PostgreSQL constraints; ensure cross-site integrity and robust migration backfill.

**Exit gate:** Deterministic installs, clean security/build/test pipeline, a full browser journey, concurrency/fault tests, and documented database-invariant review.

## Stage 3M — Production identity and security

**Purpose:** Replace development user impersonation with real identity and controlled access.

**Build:** Standards-based OIDC/OAuth2 integration with a supported local/self-hosted identity-provider option; unique staff identities; secure sessions, expiry and revocation; MFA policy; idle workstation lock; user lifecycle; site-specific role assignments; pharmacist-in-charge/admin/technician/intern/cashier/inventory/auditor roles; audited role overrides and temporary elevation; second-person authorization for designated sensitive actions; security logs, access audit controls, secret handling, TLS/reverse-proxy and rate-limit policies.

**Exit gate:** No synthetic identity paths in production; tested login/logout/session revocation; permission escalation denied; multi-site role isolation; validated admin lifecycle; documented threat model and independent security review. Production startup may only be enabled when the real security implementation—not a configuration toggle alone—exists.

## Stage 3N — Operational resilience and disaster recovery

**Purpose:** Turn the existing coordinated backup primitive into a recoverable service.

**Build:** Scheduled encrypted database+document-vault backups; suitable retention/rotation; off-machine, restricted/immutable replication; backup-key lifecycle; alerts and dashboards; capacity and disk-space preflight; storage/database health telemetry; graceful shutdown and recovery procedures; destruction/restore drill on a clean server; recovery-time and recovery-point measurements; evidence that patient/Rx/source image/inventory/claim/audit relationships recover intact.

**Exit gate:** Repeatable independent restore into a clean environment, verified backup authenticity/integrity, recovery metrics recorded, failure alerting proven, and documented operational runbook.

## Stage 3O — Versioned clinical and jurisdiction policy engine

**Purpose:** Avoid scattering changing pharmacy-law rules through route-level conditions.

**Build:** Effective-dated policies by federal/state jurisdiction and applicable drug/schedule; rule/source references and version history; explicitly chosen ruleset snapshot per decision; exception/override controls; tests for dates, time zones, DST, holidays, prescription expiration, partial/emergency fills, refills, transfers, substitution, NTI/biologics, communications and special restrictions. Policy content must undergo pharmacist/legal/compliance review before use.

**Exit gate:** Decisions are reproducible against the versioned rules used at the time; jurisdiction overrides and effective-date changes are testable and audited.

## Stage 3P — Controlled substances, EPCS, and PDMP architecture

**Purpose:** Build a separate controlled-substance safety domain instead of loosening the current fail-closed block.

**Build:** Schedule-specific validity/refill/partial/emergency/transfer workflow; controlled inventory accountability; DEA and prescriber authority checks; stronger correction/role separation; EPCS source authenticity/signature/intermediary provenance/audit requirements; NC CSRS/PDMP connector boundary; exception workflows and audit evidence.

**Exit gate:** Independently reviewed jurisdictional rules and negative-path tests. Real EPCS use requires any applicable third-party DEA-required audit/certification, provider participation, and production validation. A working code path alone does not meet this gate.

## Stage 3Q — DSCSA serialization and traceability

**Purpose:** Expand the existing GS1 serial and trace-record schema into actual dispenser product-tracing workflows.

**Build:** Serialized package intake and disposition; trading-partner identity/authorization; trace-transaction linkage, retention, exception and reconciliation flows; interoperable EPCIS where applicable; suspect/illegitimate product quarantine, verification, response and notification workflows; link recalled/dispensed package history to patients and sites.

**Exit gate:** Interoperability, retention, verification, suspect-product, and site-movement scenarios exercised against applicable authoritative requirements and trading partner/vendor test environments. Schema scaffolding is not compliance.

## Stage 3R — Complete POS financial lifecycle

**Purpose:** Make sales reversible/auditable without introducing duplicate financial events.

**Build:** Transaction/receipt lookup; receipt reprint; controlled sale void/refund/partial refund policies; coordinated original/compensating claim, patient tender and stock-disposition records; durable reconciliation; payment-terminal adapter that does not store raw card data; cash drawer, receipt and signature-device interfaces.

**Exit gate:** No double refunds/sales; every correction is attributable and auditable; simulated terminal failures and claim reversal failures are recoverable; refund and inventory disposition rules reviewed.

## Stage 3S — Local hardware integration

**Purpose:** Make the workstation operate actual local devices via a controlled abstraction.

**Build:** Pharmacy1OS Device Service with authenticated API and device permissions; Linux SANE scanner path first, other vendor-specific scanning drivers where needed; multi-page image/PDF/TIFF viewer/annotation; barcode scanner assignment; label and receipt printers; signature pads; device status, retries, spooler and failure handling.

**Exit gate:** End-to-end device tests with representative supported hardware, documented setup/recovery procedure, and no silent failure between print/scan request and physical completion.

## Stage 3T — Durable external communications

**Purpose:** Ingest/send fax and electronic prescriptions without allowing network retries to duplicate work.

**Build:** Durable inbound/outbound message queue, payload provenance, deduplication, acknowledgement/retry semantics, dead-letter/reconciliation queue; fax-to-immutable-image intake; structured eRx-to-human-readable Rx presentation; patient/prescriber matching with human exception review; signature/source validation where applicable.

**Exit gate:** Transport retries, outages, duplicate inbound messages and parsing exceptions pass integration tests; regulated eRx/EPCS is not enabled absent validated vendor/certification prerequisites.

## Stage 3U — Live third-party claim transport

**Purpose:** Replace synthetic claims with recoverable, reconciled payer transactions.

**Build:** Approved NCPDP/clearinghouse adapter and credential lifecycle, payer-specific rules, COB up to four payers, reversal/rebill, logical-vs-physical quantity handling, durable operation/outbox reconciliation for ambiguous timeouts, idempotency tested against external provider behavior, claim exception workstation.

**Exit gate:** Certification/vendor test cases, reconciliation of ambiguous responses, payer-rule review and rollback/recovery drills. Live transport remains off until authorized partner connectivity exists.

## Stage 3V — Clinical knowledge and DUR integration

**Purpose:** Introduce validated clinical decision support into the existing review model.

**Build:** Vendor-independent drug-knowledge interface; allergies, interactions, duplicate therapy, renal/hepatic, age/pregnancy, contraindications and dose-range checks; appropriate patient clinical data/provenance; pharmacist override and documentation; source/version metadata, false-positive management and testing.

**Exit gate:** Clinical content is current/licensed, quality-reviewed, versioned, tested with representative cases and integrated into real pharmacist review; synthetic date rules are not represented as complete DUR.

## Stage 4A — Reporting, dashboards, and operational intelligence

**Purpose:** Convert the stable system of record into practical operational/compliance oversight.

**Build:** Workflow aging, dispensing and inventory reconciliation, claims/POS exceptions, recalls, incomplete clinical actions, backup/integrity/security alerts, role/audit reporting, exports with privacy controls.

**Exit gate:** Reports reconcile to source ledgers and snapshots, role restrictions are validated, and discrepancies are visible rather than silently resolved.

## Stage 5A — Deployment and formal release validation candidate

**Purpose:** Produce an installable, supportable pharmacy-server/workstation deployment candidate.

**Build:** Deployment automation, secrets provisioning, secure updates/rollbacks, database migration controls, supported Linux environment, observability and incident response, performance/load/failure testing, regulated interface validation, security/privacy/regulatory gap analysis, release gates, support/runbook documentation.

**Exit gate:** Repeatable installation and rollback, clean threat/security review, measured recovery/performance characteristics, critical defects closed, formal release evidence collected.

## Stage 5B — Controlled pilot readiness assessment

**Purpose:** Establish whether a narrowly controlled real-world evaluation is justifiable.

**Build:** Independent pharmacist workflow validation, clinical/human-factors evaluation, privacy/security assessment, applicable legal/regulatory and EPCS/DSCSA reviews, partner/vendor authorization, disaster-recovery drill, external penetration testing, and written pilot acceptance criteria, training and incident procedures.

**Exit gate:** Documented external/professional approvals and regulatory compliance wherever required. **Do not use real patient data or live pharmacy dispensing until this readiness assessment is explicitly passed.**

## Cross-stage dependency and execution notes

- **Immediate next stage is 3L.3**, followed by 3M identity/security, 3N disaster recovery, then 3O policy. This priority overrides the prior tendency to postpone security and recovery until Phase 5.
- **3P and 3Q** can be developed in parallel once 3O and relevant identity/inventory controls are stable, but both require independent domain-specific readiness reviews.
- **3R–3V** rely on durable audit, identity, fault recovery, and rules. Hardware can be prototyped independently, but live regulated integrations must not be enabled early.
- Some tasks require outside parties: identity hosting/infrastructure, pharmacy-law review, live payers, EPCS audit/certification, DSCSA trading partners, card processors, equipment, and pharmacy-site validation. In-repository scaffolding does not complete those obligations.
- Any serious newly discovered patient-safety or data-integrity defect takes precedence over progression and should be handled as a safety patch before the next feature stage.

## Maintaining this map

When a stage is merged:
1. Record the PR and merge commit in [ROADMAP.md](ROADMAP.md).
2. Update this progression map only for deliberate scope/order changes; do **not** mark entire stages complete because a model, adapter, or prototype has been added.
3. Carry forward unfinished safety blockers explicitly.
4. Treat the next uncompleted stage and its exit criteria as the default starting point when a user says “continue Pharmacy1OS.”

This map is the agreed **planning baseline**; implementation status remains governed by the actual GitHub repository and validated CI evidence.
