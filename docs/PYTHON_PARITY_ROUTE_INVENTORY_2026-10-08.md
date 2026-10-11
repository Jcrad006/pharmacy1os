# Pharmacy1OS original route-by-route API parity inventory

**Snapshot:** [main `1c7ae6e2e212`](https://github.com/Jcrad006/pharmacy1os/tree/1c7ae6e2e21288f1d95c69d53de99674180bd594) compared with [Python branch `8d496943ef12`](https://github.com/Jcrad006/pharmacy1os/tree/8d496943ef12a0db83977c626c3dcec41a28df5d). Static code inventory, October 8, 2026.

**116 original Fastify route declarations**, fully inventoried below: **45 C**, **37 P**, **34 M**.

Legend: **C** core *conceptual* synthetic Python workflow; **P** partial or materially different; **M** no meaningful Python equivalent. This is **not an endpoint/JSON contract verification**: routes may have different paths, auth requirements, payloads and results. For that level of verification, run golden-record HTTP compatibility tests.

Python sources: [main API](https://github.com/Jcrad006/pharmacy1os/blob/python-native-rewrite/python/pharmacy1os/api.py), [specialty routers](https://github.com/Jcrad006/pharmacy1os/tree/python-native-rewrite/python/pharmacy1os), [test cases](https://github.com/Jcrad006/pharmacy1os/tree/python-native-rewrite/python/tests).

| Area | Original declared URL/method | Capability | Original source |
|---|---|---|---|
| Catalog | `GET /api/medications` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/catalog.ts) |
| Catalog | `POST /api/medications` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/catalog.ts) |
| Catalog | `PATCH /api/medications/:id/compliance` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/catalog.ts) |
| Catalog | `PATCH /api/products/:id/compliance` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/catalog.ts) |
| Catalog | `POST /api/medications/:id/products` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/catalog.ts) |
| Catalog | `POST /api/products/:id/lots` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/catalog.ts) |
| Catalog | `POST /api/products/:id/expirations` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/catalog.ts) |
| Catalog | `POST /api/products/:id/barcodes` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/catalog.ts) |
| Clinical | `GET /api/prescriptions/:id/clinical` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/clinical.ts) |
| Clinical | `POST /api/prescriptions/:id/dur/issues` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/clinical.ts) |
| Clinical | `PATCH /api/dur/issues/:id/resolve` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/clinical.ts) |
| Clinical | `POST /api/prescriptions/:id/interventions` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/clinical.ts) |
| Development | `GET /api/dev/users` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/development.ts) |
| Documents | `GET /api/prescriptions/:id/documents` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/documents.ts) |
| Documents | `POST /api/prescriptions/:id/documents/original` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/documents.ts) |
| Documents | `POST /api/prescriptions/:id/documents/electronic-render` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/documents.ts) |
| Documents | `GET /api/documents/:id/content` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/documents.ts) |
| Documents | `POST /api/documents/:id/annotations` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/documents.ts) |
| Documents | `POST /api/prescription-changes/:id/apply` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/documents.ts) |
| Documents | `POST /api/annotations/:id/supersede` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/documents.ts) |
| Exceptions | `GET /api/exceptions` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/exceptions.ts) |
| Health | `GET /health` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/health.ts) |
| Inventory | `GET /api/inventory/balances` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `POST /api/inventory/balances/:id/adjust` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `GET /api/inventory/holds` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `POST /api/inventory/balances/:id/quarantine` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `POST /api/inventory/holds/:id/release` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `POST /api/inventory/holds/:id/dispose` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `GET /api/inventory/cycle-counts` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `GET /api/inventory/cycle-counts/:id` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `POST /api/inventory/cycle-counts` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `PATCH /api/inventory/cycle-counts/:id/lines/:lineId` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `POST /api/inventory/cycle-counts/:id/submit` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory | `POST /api/inventory/cycle-counts/:id/review` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventory.ts) |
| Inventory architecture | `GET /api/inventory/locations` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `POST /api/inventory/locations` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `POST /api/inventory/locations/move` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `GET /api/inventory/policies` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `PUT /api/inventory/policies/:policyKey` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `GET /api/inventory/demands` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `POST /api/inventory/demands/reconcile` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `GET /api/inventory/fefo` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `GET /api/inventory/balances/:id/as-of` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `GET /api/inventory/exceptions` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `POST /api/inventory/exceptions/:id/acknowledge` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `POST /api/inventory/exceptions/:id/resolve` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `POST /api/inventory/discrepancies` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `GET /api/inventory/discrepancies` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `POST /api/inventory/discrepancies/:id/resolve` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory architecture | `POST /api/inventory/transfers/:id/custody` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryArchitecture.ts) |
| Inventory operations | `GET /api/inventory/sites` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `GET /api/inventory/transfers` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `POST /api/inventory/transfers` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `POST /api/inventory/transfers/:id/receive` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `POST /api/inventory/transfers/:id/cancel` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `GET /api/inventory/recalls` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `POST /api/inventory/recalls` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `POST /api/inventory/recalls/:id/close` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `GET /api/inventory/purchase-orders` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `POST /api/inventory/purchase-orders` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `POST /api/inventory/purchase-orders/:id/lines/:lineId/receive` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Inventory operations | `POST /api/inventory/purchase-orders/:id/cancel` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/inventoryOperations.ts) |
| Patients | `GET /api/patients` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/patients.ts) |
| Patients | `POST /api/patients` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/patients.ts) |
| POS | `POST /api/fills/:id/will-call/stage` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/pos.ts) |
| POS | `POST /api/fills/:id/will-call/rebag` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/pos.ts) |
| POS | `POST /api/fills/:id/will-call/relocate` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/pos.ts) |
| POS | `GET /api/fills/:id/will-call/history` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/pos.ts) |
| POS | `GET /api/will-call/packages/scan/:barcode` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/pos.ts) |
| POS | `POST /api/pos/quote` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/pos.ts) |
| POS | `POST /api/pos/checkout` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/pos.ts) |
| POS | `GET /api/pos/transactions/:id` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/pos.ts) |
| Prescribers | `GET /api/prescribers` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescribers.ts) |
| Prescribers | `POST /api/prescribers` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescribers.ts) |
| Prescriptions | `GET /api/prescriptions/queue` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `GET /api/prescriptions/will-call` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `GET /api/prescriptions/:id` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `GET /api/prescriptions/:id/audit` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/prescriptions` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `PATCH /api/prescriptions/:id` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `PATCH /api/prescriptions/:id/status` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/prescriptions/:id/fills` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/fills/:id/partial` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/prescriptions/:id/emergency-supply` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/fills/:id/emergency-follow-up/complete` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/fills/:id/scan-barcode` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/fills/:id/scan-product` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `PUT /api/fills/:id/billing-product` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `PUT /api/fills/:id/billing-details` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `PUT /api/fills/:id/packaging` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `DELETE /api/fills/:id/product-sources/:sourceId` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/fills/:id/nti-manufacturer-consent` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/fills/:id/biologic-communication/complete` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/fills/:id/start` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Prescriptions | `POST /api/fills/:id/return-to-stock` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/prescriptions.ts) |
| Receiving | `POST /api/receiving/scan` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/receiving.ts) |
| Receiving | `POST /api/receiving/stock` | **C** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/receiving.ts) |
| Receiving | `POST /api/receiving/assign` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/receiving.ts) |
| Receiving | `POST /api/receiving/barcodes/:id/correct` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/receiving.ts) |
| System maintenance | `GET /api/system/backups` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/systemMaintenance.ts) |
| System maintenance | `POST /api/system/backups` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/systemMaintenance.ts) |
| System maintenance | `POST /api/system/backups/:id/verify` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/systemMaintenance.ts) |
| System maintenance | `POST /api/system/document-vault/integrity-scan` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/systemMaintenance.ts) |
| System maintenance | `GET /api/system/document-vault/integrity-reports` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/systemMaintenance.ts) |
| Third party | `GET /api/third-party/payers` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `POST /api/third-party/payers` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `PATCH /api/third-party/payers/:id` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `GET /api/third-party/payers/:id/history` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `GET /api/patients/:id/coverages` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `PUT /api/patients/:id/coverages/:position` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `DELETE /api/patients/:id/coverages/:position` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `GET /api/third-party/workspace` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `GET /api/fills/:id/claims` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `POST /api/fills/:id/adjudicate` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `POST /api/third-party/claims/:id/reverse` | **P** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |
| Third party | `POST /api/third-party/print-jobs/:id/printed` | **M** | [TS](https://github.com/Jcrad006/pharmacy1os/blob/main/apps/api/src/routes/thirdParty.ts) |

## Required next step

For each endpoint marked C or P, assert **full request schema**, response/error codes, authorization, site scoping, idempotency, audit trail and state transitions using shared TypeScript/Python test fixtures. M routes require implementation or explicit de-scoping. **Do not treat conceptual C as drop-in path/behavior parity.** The original Fastify/React web application cannot be assumed compatible with the new Python API.
