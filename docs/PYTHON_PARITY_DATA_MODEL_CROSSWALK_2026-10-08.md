# Pharmacy1OS Prisma-to-SQLAlchemy data model crosswalk

**Baseline:** [Prisma `main@1c7ae6e`](https://github.com/Jcrad006/pharmacy1os/blob/1c7ae6e2e21288f1d95c69d53de99674180bd594/packages/db/prisma/schema.prisma) vs. [Python `python-native-rewrite@8d49694`](https://github.com/Jcrad006/pharmacy1os/tree/8d496943ef12a0db83977c626c3dcec41a28df5d/python/pharmacy1os). Static schema inspection October 8, 2026.

**58 original Prisma model definitions** tracked; **15 lack a conceptual Python model**. Mapped models are not guaranteed equivalent at the field, uniqueness, foreign-key, workflow, or temporal level. Python stores synthetic data in isolated `py_*` tables, with Alembic instead of Prisma migrations. There is **no implemented migration path for existing Prisma data**.

| Original Prisma model | Closest Python record / disposition |
|---|---|
| `PharmacySite` | Site |
| `User` | Staff |
| `Patient` | Patient |
| `Prescriber` | Prescriber |
| `PrescriberIdentifier` | ProviderIdentifier |
| `PrescriberContact` | ProviderContact |
| `PrescriberAddress` | ProviderAddress |
| `Medication` | Drug (many fields absent) |
| `Manufacturer` | Product.manufacturer text only |
| `Product` | Product (reduced) |
| `ProductBarcode` | Barcode |
| `ProductLot` | Stock.lot (embedded) |
| `ProductExpiration` | Stock.expires (embedded) |
| `Prescription` | Prescription (reduced) |
| `PrescriptionFill` | Fill + FillObligation + FillCompletion + EmergencySupply |
| `Document` | Document |
| `PrescriptionAnnotation` | DocumentAnnotation |
| `PrescriptionChangeRecord` | DocumentChange + StructuredChangeApplication |
| `Payer` | **NONE: no payer master** |
| `PayerBillingProfile` | PayerBillingProfile (reduced) |
| `PatientCoverage` | **NONE** |
| `ClaimTransaction` | Claim + ClaimOperation (reduced) |
| `ExternalClaimOperation` | **NONE (TS schema scaffold)** |
| `SupplyChainTraceRecord` | **NONE (TS schema scaffold)** |
| `SerializedPackage` | **NONE (TS schema scaffold)** |
| `PrescriptionLabel` | Label + LabelPrintJob (reduced) |
| `LabelPrintJob` | LabelPrintJob (different state machine) |
| `PointOfSaleTransaction` | PosTransaction (reduced) |
| `PointOfSaleLine` | PosLine (reduced) |
| `PaymentTender` | PosTender |
| `WillCallPackage` | WillCall |
| `WillCallBagBarcode` | WillCallBarcodeRecord |
| `WillCallEvent` | WillCallCustodyEvent |
| `FillProductSource` | FillSource (reduced) |
| `NtiManufacturerConsent` | **NONE** |
| `BiologicCommunicationTask` | **NONE** |
| `InventoryBalance` | Stock |
| `CycleCountSession` | CycleCountSession |
| `CycleCountLine` | CycleCountLine |
| `InventoryHold` | InventoryHold |
| `InventoryTransaction` | InventoryMovement (reduced) |
| `InventoryTransfer` | InventoryTransfer (reduced) |
| `RecallCase` | RecallCase |
| `RecallAffectedFill` | RecallExposure |
| `PurchaseOrder` | PurchaseOrder |
| `PurchaseOrderLine` | PurchaseOrderLine (cost fields absent) |
| `PurchaseOrderReceipt` | PurchaseOrderReceipt (reduced) |
| `InventoryLocation` | **NONE** |
| `InventoryStockPosition` | **NONE** |
| `InventoryAllocation` | **NONE** |
| `InventoryDemand` | **NONE** |
| `InventoryPolicy` | ReorderPolicy (limited) |
| `ReceivingDiscrepancy` | **NONE** |
| `InventoryException` | **NONE (read-only computed ExceptionService only)** |
| `InventoryTransferCustodyEvent` | **NONE** |
| `DurIssue` | DUR |
| `InterventionNote` | **NONE** |
| `AuditEvent` | Audit |

## High-impact modeling gaps

1. **Person and directory:** Patient email and several normalized search/contact fields; prescriber record/identifier constraints and hierarchical IDs.
2. **Medication, product and safety:** Brand/route, manufacturer table, package size and package pricing, therapeutic equivalence and DAW, dosage-form and biologic/NTI/cold-chain metadata, controlled-substance schedule. Python stores stock lot and expiration without separate ProductLot/ProductExpiration masters.
3. **Prescription and filling:** Original source type, written date, electronic raw/message reference, prescribed product/directive, days supply, discard/original-container fields, detailed full intended vs physical/owed dimensions, state and version semantics, claim lineage.
4. **Insurance:** No payer master, patient coverage or original ClaimTransaction response envelope; no external claim outbox.
5. **Warehouse:** No location, stock position, allocation, demand/backorder, receiving discrepancy, transfer custody event, or persisted inventory exception model.
6. **Compliance:** No NTI manufacturer consent, biologic communication task or discrete pharmacist InterventionNote.
7. **Label/POS:** No exact claim-linked versioned labels, print lifecycle and terminal-status integration. Python adds an immutable synthetic label print snapshot and audit event but it does not restore all original label fields.
8. **Governance:** Audit event shapes/keys, site relationship constraints, exact precision/defaults and idempotency fields differ.

## Gate for full parity

For each model, produce a **field-to-field schema contract** with (a) original field name/type/nullability/default/enum, (b) target field, (c) transformation of existing values, (d) whether history is lost or retained, (e) relation/site boundary and foreign keys, and (f) database migration test. All original field losses must be explicit and reviewed. A conceptual crosswalk is necessary but **not sufficient** for a production data cutover.

See [full feature audit](PYTHON_PARITY_AUDIT_2026-10-08.md) and [original API endpoint inventory](PYTHON_PARITY_ROUTE_INVENTORY_2026-10-08.md).
