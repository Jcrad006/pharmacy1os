# Pharmacy1OS — complete TypeScript → Python feature-parity audit

**Audit date:** 2026-10-08 (America/New_York).  
**TypeScript baseline:** [main @ 1c7ae6e2e212](https://github.com/Jcrad006/pharmacy1os/tree/1c7ae6e2e21288f1d95c69d53de99674180bd594)  
**Python baseline:** [python-native-rewrite @ 8d496943ef12](https://github.com/Jcrad006/pharmacy1os/tree/8d496943ef12a0db83977c626c3dcec41a28df5d)

> **Determination: NOT PARITY-COMPLETE.** Original TypeScript/Fastify/React/Prisma source remains in the branch. Python FastAPI/SQLAlchemy/PySide6 is a useful but separate **synthetic-only** rewrite. No real patient dispensing, external payer claims, eRx/fax, legal transfer, physical printer certification or live payment is authorized in either baseline.

## Audit deliverables and measurements

- **138 individual functional assessments**: **38 C** core synthetic functionality exists, **55 P** partial/materially different, **45 M** missing. This is a **qualitative feature inventory, not a weighted percent complete or test coverage score**.
- [All 116 original Fastify endpoint declarations inventoried](PYTHON_PARITY_ROUTE_INVENTORY_2026-10-08.md). Endpoint *conceptual* statuses do not imply URL, schema, HTTP error/status, permission, audit, transaction or idempotency compatibility.
- [All 58 original Prisma data models mapped to nearest Python analog or marked absent](PYTHON_PARITY_DATA_MODEL_CROSSWALK_2026-10-08.md). **15** have no conceptual Python record. Even matched models are not field-complete.
- Benchmarked original [web screens](https://github.com/Jcrad006/pharmacy1os/tree/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/screens), [server routes](https://github.com/Jcrad006/pharmacy1os/tree/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes), [test suite](https://github.com/Jcrad006/pharmacy1os/tree/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/test) and [Prisma schema](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/packages/db/prisma/schema.prisma) against [Python source](https://github.com/Jcrad006/pharmacy1os/tree/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os), [tests](https://github.com/Jcrad006/pharmacy1os/tree/8d496943ef12a0db83977c626c3dcec41a28df5d/python/tests), [Qt native workstation](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/desktop.py) and [Alembic migrations](https://github.com/Jcrad006/pharmacy1os/tree/8d496943ef12a0db83977c626c3dcec41a28df5d/python/migrations).

**Rating criteria:** **C** core workflow exists on the Python *synthetic* implementation (NOT proved one-to-one parity); **P** a substantive slice exists but fields, behavior, API or desktop are incomplete/different; **M** no adequate Python counterpart (some findings explicitly call out capabilities which the original only planned, rather than implemented). Rating applies to each named feature, **not** the whole subsystem. Static source audit only; no interactive Qt operation or full differential acceptance session was performed.

## Source-based feature matrix

### Platform, access, persistence and testing

Original sources: [apps/api/src/app.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/app.ts), [apps/api/src/security](https://github.com/Jcrad006/pharmacy1os/tree/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/security), [packages/db/prisma/schema.prisma](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/packages/db/prisma/schema.prisma). Python sources: [python/pharmacy1os/api.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/api.py), [python/pharmacy1os/auth.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/auth.py), [python/pharmacy1os/models.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/models.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| PL01 | Independent Python API/service | **C** | FastAPI and SQLAlchemy service, no TypeScript runtime for the synthetic Python backend |
| PL02 | Old Fastify server fully replaced | **M** | Fastify source and route contracts remain and no release cutover |
| PL03 | React workstation fully replaced | **P** | Qt desktop exists but significant screen parity gaps remain |
| PL04 | Roles and site boundaries | **P** | Python role and site checks differ from original auth and composite FK policies |
| PL05 | Production identity, MFA and SSO | **M** | Both source baselines remain development-oriented; not an implemented old feature |
| PL06 | Site-scoped audit records | **P** | Both log events; event shapes and reporting contracts differ |
| PL07 | Original endpoint and JSON compatibility | **M** | No verified matching API contracts or compatibility adapter |
| PL08 | Prisma database migration to Python | **M** | Isolated py_* tables; no data conversion |
| PL09 | Migration/DB fixture test suite | **C** | Python Alembic, SQLite and PostgreSQL tests |
| PL10 | Original browser E2E replaced by Qt E2E | **M** | No equivalent automated Qt journey |
| PL11 | PostgreSQL multi-workstation protections | **P** | New row locks and selected tests; original full fault/concurrency suite not reproduced |

### Patient and prescriber records

Original sources: [apps/api/src/routes/patients.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/patients.ts), [apps/api/src/routes/prescribers.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/prescribers.ts), [apps/web/src/screens/Prescribers.tsx](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/screens/Prescribers.tsx). Python sources: [python/pharmacy1os/patient_directory.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/patient_directory.py), [python/pharmacy1os/provider_directory.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/provider_directory.py), [python/pharmacy1os/desktop.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/desktop.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| PP01 | Patient registration | **C** | Core site-scoped record creation |
| PP02 | Patient name/DOB/phone search | **P** | Python normalized search, different full UI/API behavior |
| PP03 | Patient email field | **M** | Present in Prisma Patient, missing in Python Patient |
| PP04 | Patient insurance/coverage association | **M** | No PatientCoverage model or coverage editor |
| PP05 | Prescriber creation and practice level | **C** | Core Python service and native action |
| PP06 | NPI, DEA and state identifier ledger | **P** | Separate Python identifier table; original field and validation semantics differ |
| PP07 | Multiple provider contacts/addresses | **P** | Implemented with field and editor differences |
| PP08 | Primary identifier/contact/address rules | **P** | Partly modeled; contract not equivalent |
| PP09 | Provider search and record detail | **P** | Python searching exists; detailed native edit experience differs |

### Medication, product, receiving and compliance

Original sources: [apps/api/src/routes/catalog.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/catalog.ts), [apps/api/src/routes/receiving.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/receiving.ts), [apps/api/src/productFillCompliance.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/productFillCompliance.ts). Python sources: [python/pharmacy1os/models.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/models.py), [python/pharmacy1os/service.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/service.py), [python/pharmacy1os/barcode.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/barcode.py), [python/pharmacy1os/scanner.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/scanner.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| DR01 | Drug generic name, strength, form | **C** | Core drug record |
| DR02 | Brand, route, active and cold-chain flags | **M** | Original Medication has fields not preserved in Python Drug |
| DR03 | Manufacturer master data | **P** | Python product carries manufacturer name rather than entity |
| DR04 | Drug to multiple NDC products | **C** | Multiple product records per drug |
| DR05 | Package size/type/cost/equivalence data | **P** | Python has unit and unit price only, not full original package/therapeutic schema |
| DR06 | Separate site lot and expiration masters | **P** | Embedded on Python Stock rather than original site-specific master tables |
| DR07 | Barcode registry and scanner parsing | **C** | Basic matching, parser and scanning available |
| DR08 | Unknown barcode assignment during receiving | **P** | Backend flow exists but original UI/API wizard not recreated in full |
| DR09 | Pharmacist correction of a wrong barcode | **P** | Python audited method; full native/API correction interface not equivalent |
| DR10 | GS1 check-digit and variable barcode variants | **P** | Python parser exists; no cross-language equivalence cases established |
| DR11 | DAW/dispense-as-written directives | **M** | Original product selection directive absent |
| DR12 | NTI manufacturer consent | **M** | No analogous Python per-fill consent record |
| DR13 | Biologic interchange communication | **M** | No analog of original biologic task |
| DR14 | Controlled drug schedule classification | **M** | Python only boolean controlled flag |
| DR15 | Product compliance flags and workflow | **M** | Original NDC/medication compliance editors not ported |

### Prescription and clinical workflow

Original sources: [apps/api/src/routes/prescriptions.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/prescriptions.ts), [apps/api/src/routes/clinical.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/clinical.ts), [apps/web/src/screens/ClinicalPanel.tsx](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/screens/ClinicalPanel.tsx). Python sources: [python/pharmacy1os/service.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/service.py), [python/pharmacy1os/lifecycle.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/lifecycle.py), [python/pharmacy1os/scheduling.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/scheduling.py), [python/pharmacy1os/date_rules.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/date_rules.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| RX01 | Create prescription choosing drug | **C** | Core registration and sig/quantity/refills |
| RX02 | Original prescription source type | **M** | No MANUAL/PAPER/FAX/ELECTRONIC/VERBAL/TRANSFER source enum in Python Rx |
| RX03 | Electronic raw message/ID fields | **M** | No equivalent Python Rx ingestion metadata |
| RX04 | Written date/product directive/full Rx fields | **P** | Expiration/do-not-fill fields exist; written date and product directive absent |
| RX05 | Prescription queue and search | **P** | Queue available; sorting/filtering/detail API/UI differs |
| RX06 | General prescription edit and DUR reset | **P** | Python narrow structured-change path, not full original editable state |
| RX07 | On-hold/resume/cancel transitions | **C** | Python guarded lifecycle paths |
| RX08 | Full status transition and fill event matrix | **P** | Different states, error contracts and field provenance |
| RX09 | Original basic transfer status transition | **P** | Python richer manual transfer-out request/attestation; not drop-in compatible |
| RX10 | Transfer-in and external handoff protocol | **M** | No real transfer exchange |
| RX11 | Future fill scheduling/start/cancel | **C** | Python scheduling model, API and Qt action |
| RX12 | Refill accounting and eligibility controls | **P** | Implemented with changed fill lineage and date handling |
| RX13 | Synthetic DUR issue and resolution | **C** | Pharmacist role-controlled issue resolution |
| RX14 | Original pharmacist intervention ledger | **M** | Discrete original InterventionNote record absent |
| RX15 | Prescription expiration/do-not-fill/refill interval | **P** | Python rules exist but no cross-language edge-case proof |
| RX16 | Original Rx detail and audit UI | **P** | Python generic queue/audit and prompts are not fully equivalent |

### Filling, labeling, partials and emergencies

Original sources: [apps/api/src/routes/prescriptions.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/prescriptions.ts), [apps/api/src/productFillCompliance.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/productFillCompliance.ts), [docs/PHASE3J_QUANTITY_ARCHITECTURE.md](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/docs/PHASE3J_QUANTITY_ARCHITECTURE.md). Python sources: [python/pharmacy1os/service.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/service.py), [python/pharmacy1os/fill_completion.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/fill_completion.py), [python/pharmacy1os/emergency_supply.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/emergency_supply.py), [python/pharmacy1os/label_printing.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/label_printing.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| FL01 | Data-entry selected drug matches scanned NDC | **C** | Cross-check product drug ID on source scan |
| FL02 | NDC/LOT/EXP and stock reservation | **C** | Physical lot matching, recall and expiration checks |
| FL03 | Pharmacist commit of physically sourced stock | **C** | Inventory movements and verification gates |
| FL04 | Four distinct sources per physical fill | **C** | Python enforces source count of four |
| FL05 | Multi-manufacturer separate bottle labels | **C** | One per source with NDC, quantity, total and bottle ordinal |
| FL06 | Choose billed product and days supply | **P** | Synthetic strategy exists but original edit and billing details absent |
| FL07 | Remove or correct scanned source before review | **M** | Original per-source DELETE route absent |
| FL08 | Dispense in original container/discard date | **M** | Original packaging controls absent |
| FL09 | Partial interruption and quantity owed | **C** | Python obligation, linked completion and balance |
| FL10 | Completion without extra refill or duplicate payer event | **C** | Python tracks anchor and physical units |
| FL11 | Emergency supply and pharmacist follow-up | **C** | Strict synthetic eligibility and follow-up |
| FL12 | DUR-guarded pharmacist final verification | **C** | Role, state, expiry and stock checks |
| FL13 | Return unsold fill, reverse claim, restock | **C** | Python audited RTS and voids test labels |
| FL14 | Full original versioned label state and fields | **P** | Python snapshots lack original claim/label version and print lifecycle |
| FL15 | Actual thermal printer/device acknowledgement | **M** | Neither version has production hardware output; native Qt only test spool |
| FL16 | Multi-client dispense idempotence and fault recovery | **P** | Targeted row locks; broader multi-workstation proof missing |

### Payers, billing and COB

Original sources: [apps/api/src/routes/thirdParty.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/thirdParty.ts), [apps/api/src/claims/service.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/claims/service.ts), [apps/web/src/screens/ThirdParty.tsx](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/screens/ThirdParty.tsx). Python sources: [python/pharmacy1os/billing.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/billing.py), [python/pharmacy1os/billing_models.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/billing_models.py), [python/pharmacy1os/api.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/api.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| BL01 | Site payer master with BIN, PCN and group | **M** | No full Python Payer entity |
| BL02 | Patient coverage member ID and sequence | **M** | No Python PatientCoverage CRUD/ledger |
| BL03 | Payer billing profile/versioned rules | **P** | Python limited configuration/profile versions |
| BL04 | Coordination of up to four insurers | **P** | Python four payer names without actual coverage-linked COB |
| BL05 | Adjudicate in sandbox test adapter | **P** | Synthetic PAID events without equivalent claim adapter response semantics |
| BL06 | Reject queue and retry after correction | **M** | Original rejected-claims workspace not replicated |
| BL07 | Immutable claim request/response/ref/reject details | **M** | Original ClaimTransaction data envelope not represented |
| BL08 | Patient claim responsibility computation | **M** | Not equivalently populated for checkout |
| BL09 | Standalone claim reversal and resubmission | **P** | RTS reverses test claim; no full billing-workspace action |
| BL10 | Rebill after NDC source correction | **M** | Original configuration/correction pipeline absent |
| BL11 | External claim outbox and retries | **M** | Original schema scaffold not ported; no live transport in either |
| BL12 | Claim-associated printed label lifecycle | **P** | Python print queue is not claim-linked like original |
| BL13 | Live NCPDP claim switch | **M** | Future release integration, absent in both |

### Will Call, point of sale and checkout

Original sources: [apps/api/src/routes/pos.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/pos.ts), [apps/api/src/pos/service.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/pos/service.ts), [apps/web/src/screens/WillCall.tsx](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/screens/WillCall.tsx). Python sources: [python/pharmacy1os/willcall.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/willcall.py), [python/pharmacy1os/pos.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/pos.py), [python/pharmacy1os/desktop.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/desktop.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| PO01 | Stage Ready prescription with bag/bin | **C** | Staging and bag identity |
| PO02 | Verify bag barcode before sale | **C** | Python check for staged pickup |
| PO03 | Rebag and retired barcode history | **C** | Python custody events |
| PO04 | Relocate staged package | **C** | Python relocation event |
| PO05 | Immediate waiter pickup without bag | **C** | Python immediate vs Will Call modes |
| PO06 | Multi-fill pickup, identity, signature and tender | **C** | Synthetic multi-line checkout and audit |
| PO07 | Checkout quote based on claim or exact source price | **P** | Python accepts line amounts, lacks original quote computation |
| PO08 | Cash unit/package pricing snapshots | **P** | Original POS snapshot and price-basis model differs |
| PO09 | Transaction receipt/history screen | **P** | Python has synthetic ledger and receipt; UI and data differ |
| PO10 | Refund and void handling | **P** | Python simulated financial adjustments; no real tender or identical original flow |
| PO11 | Card terminal and real signature capture | **M** | Future integration in both programs, not a conversion regression |

### Inventory operations and architecture

Original sources: [apps/api/src/routes/inventory.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/inventory.ts), [apps/api/src/routes/inventoryOperations.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/inventoryOperations.ts), [apps/api/src/routes/inventoryArchitecture.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/inventoryArchitecture.ts), [apps/web/src/screens/InventoryArchitecture.tsx](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/screens/InventoryArchitecture.tsx). Python sources: [python/pharmacy1os/inventory_ops.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/inventory_ops.py), [python/pharmacy1os/inventory_advanced.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/inventory_advanced.py), [python/pharmacy1os/inventory_planning.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/inventory_planning.py), [python/pharmacy1os/models.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/models.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| IN01 | Site-product-lot-expiration balances | **C** | Core on-hand/reserved/quarantined stock |
| IN02 | Nonnegative physical inventory constraints | **C** | SQL constraints and safety checks |
| IN03 | Transaction ledger, idempotent quantities and cost | **P** | Python movement ledger lacks full original key/cost/ref semantics |
| IN04 | Quarantine, release and dispose | **P** | Basic Python hold/resolve, narrower disposition |
| IN05 | Cycle count create, count, submit and review | **C** | Python review with movement validation |
| IN06 | Wholesaler purchase order and receiving | **C** | Core PO lifecycle and receipt records |
| IN07 | PO unit costs, invoice and discrepancy handling | **P** | Python invoice only, no full cost/discrepancy controls |
| IN08 | Inter-site transfer ship, receive and cancel | **C** | Core movement and source-site checks |
| IN09 | Carrier, seal, tracking and custody events | **M** | Transfer custody data model absent |
| IN10 | Recall product/lot and affected dispenses | **C** | Python RecallCase/RecallExposure |
| IN11 | Reorder point recommendations | **P** | Python advisory planner, not original demand and policy suite |
| IN12 | Physical inventory locations/barcodes | **M** | Original InventoryLocation absent |
| IN13 | Location-specific stock positions and moves | **M** | Original stock position and location-move flow absent |
| IN14 | FEFO allocation and stock pick policy | **M** | Original location-aware allocation absent |
| IN15 | Demand and backorder reconciliation | **M** | Original InventoryDemand absent |
| IN16 | As-of inventory projections | **M** | Original historical balance projection API absent |
| IN17 | Persistent inventory exception lifecycle | **M** | No acknowledged/resolved inventory exception records |
| IN18 | Receiving discrepancy and resolution | **M** | Original ReceivingDiscrepancy absent |
| IN19 | Site inventory settings and thresholds | **P** | Narrow Python product reorder policy |
| IN20 | DSCSA tracing / serialized package records | **M** | Original schema scaffold not ported; external compliance remains unbuilt |

### Imaging, communication and recovery

Original sources: [apps/api/src/routes/documents.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/documents.ts), [apps/api/src/routes/systemMaintenance.ts](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/src/routes/systemMaintenance.ts), [apps/web/src/screens/PrescriptionDocumentPanel.tsx](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/screens/PrescriptionDocumentPanel.tsx). Python sources: [python/pharmacy1os/documents.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/documents.py), [python/pharmacy1os/structured_changes.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/structured_changes.py), [python/pharmacy1os/communications.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/communications.py), [python/pharmacy1os/backup.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/backup.py), [python/pharmacy1os/postgres_backup.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/postgres_backup.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| DO01 | Immutable original scan with checksum | **C** | Python document vault immutable bytes and SHA |
| DO02 | Visual editable opaque text annotations | **C** | Python positional overlays and revisions |
| DO03 | Separate who/what/when/why change record | **C** | DocumentChange audit and source link |
| DO04 | Structured clinical field application from note | **P** | Python narrower edit scope and GUI |
| DO05 | Human-readable eRx render | **P** | Synthetic-only Python render, not real ingestion |
| DO06 | Document integrity detection | **C** | Hash verification |
| DO07 | Vault integrity reports/history API | **P** | Python problem readout; no matching report history view |
| DO08 | Optional encryption and full key governance | **P** | Demo vault encryption, no production KMS practices |
| DO09 | Communications tasks, review and attempts | **P** | Python manual task ledger, no live fax/eRx |
| DO10 | Actual inbound/outbound fax/eRx transport | **M** | Future integration absent in both |
| DO11 | Encrypted signed SQLite backups and verification | **P** | Python backup CLI, not matching original admin service |
| DO12 | PostgreSQL backup and restore rehearsal | **P** | Python PG archive verification; no proven hot restore deployment |
| DO13 | Backup creation and verification HTTP admin screens | **M** | Main TypeScript admin routes not exposed in Python HTTP API |
| DO14 | Administrative vault integrity report history | **M** | No matching server report/retention UI |

### Native desktop workstation

Original sources: [apps/web/src/App.tsx](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/App.tsx), [apps/web/src/screens/PrescriptionDetail.tsx](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/screens/PrescriptionDetail.tsx), [apps/web/src/screens/ThirdParty.tsx](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/web/src/screens/ThirdParty.tsx). Python sources: [python/pharmacy1os/desktop.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/desktop.py), [python/pharmacy1os/label_printing.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/label_printing.py), [python/pharmacy1os/api.py](https://github.com/Jcrad006/pharmacy1os/blob/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os/api.py).

| ID | Original feature | Rating | Assessment |
|---|---|---|---|
| UI01 | Native desktop without Chromium | **C** | PySide6 in-process Python workstation |
| UI02 | Function-key navigation and search focus | **P** | Shortcuts exist, scanner focus/filter differs |
| UI03 | Full prescription detail form and audit panel | **P** | Button/modal-driven native dashboard is less complete |
| UI04 | Patient/provider create/find/edit screens | **P** | Native forms not feature-identical |
| UI05 | Drug catalog and compliance editor | **P** | Basic product dialogs without original compliance editor |
| UI06 | Barcode assignment/correction receiving wizard | **P** | Native receiving exists, correction workflow not equivalent |
| UI07 | Insurer/coverage and rejected-claims workspace | **M** | Only Python profile/claim history native actions |
| UI08 | Inventory physical location, FEFO and exception UI | **M** | Supply-chain actions but no equivalent architecture screens |
| UI09 | Image annotation full UX | **P** | Native graphics exists but untested parity vs React |
| UI10 | Will Call scan-first quote and receipt UX | **P** | Basic flow without original integrated quote interface |
| UI11 | Print dialog and status reconciliation | **P** | Test spool dialog, no physical status confirmation |
| UI12 | Desktop installer/update/distribution | **M** | No completed packaged desktop release |
| UI13 | Automated Qt end-to-end and accessibility suite | **M** | No native journey test or accessibility validation |


## Cross-cutting findings

1. **Data integrity and interoperability:** The old database is Prisma, but the new database uses separate `py_*` tables and independent Alembic migrations. **No safe original-record migration, mapping of existing prescription IDs/history, or rollback has been established.** Python should not overwrite or be considered an upgrade of the old database.
2. **Endpoint compatibility:** The TypeScript web client calls specific Fastify contracts. Python APIs often represent similar ideas with different URLs, authorization models, request/response shapes and state semantics. **The old React app is not a supported frontend for the Python API without adapter and contract testing.**
3. **Core behavior vs equivalent clinical constraints:** Names like `DUR`, `Claim`, `Stock` or `PrintJob` do not prove original safety checks, timing, callbacks, source corrections, role boundaries or label histories were preserved.
4. **Desktop parity:** Native Qt has 13 named views and several synthetic workflows, but many React forms/subpanels are replaced with simple button-plus-dialog interactions. A physical test on supported desktop operating systems is required for actual interface acceptance.
5. **Synthetic external integrations:** Neither source baseline has clinically validated automated DUR knowledge, live NCPDP, eRx transport, EPCS/PDMP, DSCSA verification or production thermal-printer compliance. These are **release blockers** but should not be mislabeled as regression of already-working TypeScript integrations.
6. **New Python features are not old feature parity:** The separate transfer-out attestation prototype, emergency tracking, per-bottle immutable print snapshots, manual communications and offline backup scripts add value; they do **not** close unrelated original TypeScript functionality gaps.

## Test evidence and limits

The original application has a Playwright Chromium dispensing journey and TypeScript API/inventory/clinical/POS tests (see [TypeScript tests](https://github.com/Jcrad006/pharmacy1os/tree/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/test) and [journey](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/apps/api/e2e/dispensing.pw.ts)). At the audited Python code-bearing revision `d2e02d2b3`, CI verified **181 passing Python tests and 7 skips on both 3.12 and 3.13**, plus PostgreSQL schema verification and **7 passing PostgreSQL integration tests**. The latest audit commits are documentation-only; no cross-language equivalence harness has been run. A successful synthetic test is not a substitute for data migration or real clinical/production validation.

**Still missing acceptance evidence:** per-model field conversion tests; original/Python behavioral fixtures with matching input/error/result and audit; all roles/sites; original claim-reversal and manufacturer changes; Qt GUI UI/keyboard/scanner automation; realistic multi-client PostgreSQL stress/fault testing; native installer and device compatibility; security/operational controls.

## Ordered parity closure plan

**P0 — foundational and patient-safety/data-critical**
1. Freeze the two inspected versions. Produce a *field-level* Prisma→SQLAlchemy crosswalk for all 58 models, including required types, enums, uniques, FKs, site isolation, provenance and a recoverable conversion process. Do not merge original databases blindly.
2. Complete original prescription source/written date/DAW/edit/version fields; general Rx editing and DUR reset; intervention notes and compliance-aware product selection/NTI/biologic/controlled schedule constraints.
3. Complete payer master, patient 1–4 coverage records, request/response claim model, coverage-linked synthetic COB, rejection/retry workspace, billing-source correction and rebill/reversal lineage. Keep actual switch disabled.
4. Complete inventory warehouse location and physical stock-position models, allocation/FEFO, demand/backorders, receiving discrepancy/custody and persistent exception resolution. Prove stock invariants under PostgreSQL concurrency.

**P1 — end-user parity**
5. Replace the remaining React prescription-detail, third-party, clinical, catalog, receiving and inventory-architecture forms with native Qt field-complete controls and robust keyboard/scan handling.
6. Recreate exact per-fill billing, days supply, source remove/edit and packaging; original label print lifecycle and printer errors. Keep test-only spool until hardware qualification.
7. Decide how Python API will expose equivalent original 116 route capabilities. Either maintain compatible contracts or version a deliberately incompatible API with a documented client migration. Test both.
8. Expose equivalent backup verification and vault integrity maintenance to authorized administrative users, strengthen roles/identity, encryption, backup/recovery.

**P2 — prove exit, then cut over**
9. Build common deterministic TypeScript/Python behavioral test fixtures and native Qt end-to-end journeys; include negative tests, race conditions, restarts, hardware mocks and recovery.
10. Require no unresolved P/M finding without a documented product de-scope, migration of all preserved data and sign-off, baseline performance goals, and a tested rollback before deprecating original TypeScript.
11. Only after parity is achieved, evaluate the **separate** production roadmap phases: validated identity/RBAC, controlled substances/EPCS, DSCSA, external communications/payers, clinical knowledge, hardware and formal deployment.

## Formal exit criterion

**The conversion is not complete until every implemented original feature has a Python equivalent (or an explicitly approved de-scope), and those choices have passed data integrity, API contract, role/site, end-to-end native UI and recovery acceptance testing.** Keep the original TypeScript program available and unchanged during that work. Neither current implementation should be used with live patient data.
