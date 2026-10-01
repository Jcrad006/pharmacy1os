-- Phase 3H architecture hardening:
-- physical locations, allocations, demand/backorders, policy, discrepancies,
-- idempotency/cost history, inventory exceptions, and transfer custody.

CREATE TYPE "InventoryLocationType" AS ENUM (
  'SHELF','BIN','REFRIGERATOR','FREEZER','SAFE','RECEIVING',
  'QUARANTINE','RETURN_TO_VENDOR','WILL_CALL','OTHER'
);
CREATE TYPE "InventoryStockState" AS ENUM ('AVAILABLE','QUARANTINED');
CREATE TYPE "InventoryAllocationStatus" AS ENUM ('ACTIVE','COMMITTED','RELEASED');
CREATE TYPE "InventoryDemandStatus" AS ENUM ('OPEN','READY','FULFILLED','CANCELLED');
CREATE TYPE "InventoryDemandSource" AS ENUM ('FILL','COMPLETION','REORDER','MANUAL');
CREATE TYPE "InventoryPolicyScope" AS ENUM ('SITE','PRODUCT');
CREATE TYPE "ReceivingDiscrepancyType" AS ENUM (
  'SHORT_SHIPMENT','OVERAGE','WRONG_PRODUCT','DAMAGED_PRODUCT',
  'LOT_EXPIRATION_MISMATCH','INVOICE_MISMATCH','DUPLICATE_SHIPMENT',
  'UNEXPECTED_PRODUCT','OTHER'
);
CREATE TYPE "ReceivingDiscrepancyStatus" AS ENUM ('OPEN','RESOLVED');
CREATE TYPE "InventoryExceptionType" AS ENUM (
  'BELOW_REORDER_POINT','EXPIRING_SOON','STALE_RESERVATION','TRANSFER_STUCK',
  'PURCHASE_ORDER_OVERDUE','UNALLOCATED_DEMAND','POSITION_IMBALANCE',
  'MISSING_ACQUISITION_COST'
);
CREATE TYPE "InventoryExceptionStatus" AS ENUM ('OPEN','ACKNOWLEDGED','RESOLVED');
CREATE TYPE "InventoryCustodyEventType" AS ENUM (
  'PACKED','VERIFIED','HANDED_OFF','RECEIVED','EXCEPTION'
);

ALTER TABLE "InventoryTransaction"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "unitCost" DECIMAL(12,6),
  ADD COLUMN "extendedCost" DECIMAL(14,4);

ALTER TABLE "InventoryTransfer"
  ADD COLUMN "carrier" TEXT,
  ADD COLUMN "trackingNumber" TEXT,
  ADD COLUMN "sealIdentifier" TEXT,
  ADD COLUMN "custodyReference" TEXT;

ALTER TABLE "PurchaseOrderReceipt"
  ADD COLUMN "unitCost" DECIMAL(12,6),
  ADD COLUMN "extendedCost" DECIMAL(14,4),
  ADD COLUMN "idempotencyKey" TEXT;

CREATE TABLE "InventoryLocation" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "InventoryLocationType" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "isDefaultReceiving" BOOLEAN NOT NULL DEFAULT false,
  "isDefaultDispensing" BOOLEAN NOT NULL DEFAULT false,
  "isQuarantine" BOOLEAN NOT NULL DEFAULT false,
  "temperatureMinC" DECIMAL(6,2),
  "temperatureMaxC" DECIMAL(6,2),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryStockPosition" (
  "id" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "state" "InventoryStockState" NOT NULL DEFAULT 'AVAILABLE',
  "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryStockPosition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryStockPosition_nonnegative" CHECK ("quantity" >= 0)
);

CREATE TABLE "InventoryAllocation" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "actorId" TEXT,
  "quantity" DECIMAL(14,3) NOT NULL,
  "status" "InventoryAllocationStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "InventoryAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryAllocation_positive_quantity" CHECK ("quantity" > 0)
);

CREATE TABLE "InventoryDemand" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "medicationId" TEXT NOT NULL,
  "productId" TEXT,
  "fillId" TEXT,
  "source" "InventoryDemandSource" NOT NULL,
  "requiredQuantity" DECIMAL(14,3) NOT NULL,
  "availableQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "status" "InventoryDemandStatus" NOT NULL DEFAULT 'OPEN',
  "neededBy" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fulfilledAt" TIMESTAMP(3),
  CONSTRAINT "InventoryDemand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryDemand_positive_quantity" CHECK ("requiredQuantity" > 0),
  CONSTRAINT "InventoryDemand_nonnegative_available" CHECK ("availableQuantity" >= 0)
);

CREATE TABLE "InventoryPolicy" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "scope" "InventoryPolicyScope" NOT NULL,
  "policyKey" TEXT NOT NULL,
  "productId" TEXT,
  "reorderPoint" DECIMAL(14,3),
  "targetStockLevel" DECIMAL(14,3),
  "minShelfLifeDays" INTEGER NOT NULL DEFAULT 30,
  "expirationWarningDays" INTEGER NOT NULL DEFAULT 90,
  "fefoEnabled" BOOLEAN NOT NULL DEFAULT true,
  "staleReservationHours" INTEGER NOT NULL DEFAULT 24,
  "staleTransferHours" INTEGER NOT NULL DEFAULT 48,
  "purchaseOrderOverdueDays" INTEGER NOT NULL DEFAULT 3,
  "technicianAdjustmentThreshold" DECIMAL(14,3),
  "preferredSupplierName" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryPolicy_nonnegative_reorder" CHECK ("reorderPoint" IS NULL OR "reorderPoint" >= 0),
  CONSTRAINT "InventoryPolicy_nonnegative_target" CHECK ("targetStockLevel" IS NULL OR "targetStockLevel" >= 0),
  CONSTRAINT "InventoryPolicy_positive_days" CHECK (
    "minShelfLifeDays" >= 0 AND "expirationWarningDays" >= 0
    AND "staleReservationHours" > 0 AND "staleTransferHours" > 0
    AND "purchaseOrderOverdueDays" >= 0
  )
);

CREATE TABLE "ReceivingDiscrepancy" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "purchaseOrderId" TEXT,
  "purchaseOrderLineId" TEXT,
  "receiptId" TEXT,
  "expectedProductId" TEXT,
  "observedProductId" TEXT,
  "type" "ReceivingDiscrepancyType" NOT NULL,
  "expectedQuantity" DECIMAL(14,3),
  "observedQuantity" DECIMAL(14,3),
  "note" TEXT,
  "status" "ReceivingDiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
  "createdById" TEXT NOT NULL,
  "resolvedById" TEXT,
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "ReceivingDiscrepancy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryException" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "type" "InventoryExceptionType" NOT NULL,
  "status" "InventoryExceptionStatus" NOT NULL DEFAULT 'OPEN',
  "severity" "DurSeverity" NOT NULL DEFAULT 'WARNING',
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "title" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedById" TEXT,
  "acknowledgedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "resolutionNote" TEXT,
  CONSTRAINT "InventoryException_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryTransferCustodyEvent" (
  "id" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "type" "InventoryCustodyEventType" NOT NULL,
  "carrier" TEXT,
  "trackingNumber" TEXT,
  "sealIdentifier" TEXT,
  "note" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryTransferCustodyEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryTransaction_idempotencyKey_key"
  ON "InventoryTransaction"("idempotencyKey");
CREATE INDEX "InventoryTransaction_idempotencyKey_idx"
  ON "InventoryTransaction"("idempotencyKey");

CREATE UNIQUE INDEX "PurchaseOrderReceipt_idempotencyKey_key"
  ON "PurchaseOrderReceipt"("idempotencyKey");

CREATE UNIQUE INDEX "InventoryLocation_siteId_code_key"
  ON "InventoryLocation"("siteId","code");
CREATE INDEX "InventoryLocation_siteId_active_type_idx"
  ON "InventoryLocation"("siteId","active","type");

CREATE UNIQUE INDEX "InventoryStockPosition_inventoryBalanceId_locationId_state_key"
  ON "InventoryStockPosition"("inventoryBalanceId","locationId","state");
CREATE INDEX "InventoryStockPosition_locationId_state_idx"
  ON "InventoryStockPosition"("locationId","state");
CREATE INDEX "InventoryStockPosition_inventoryBalanceId_state_idx"
  ON "InventoryStockPosition"("inventoryBalanceId","state");

CREATE INDEX "InventoryAllocation_siteId_status_createdAt_idx"
  ON "InventoryAllocation"("siteId","status","createdAt");
CREATE INDEX "InventoryAllocation_fillId_status_idx"
  ON "InventoryAllocation"("fillId","status");
CREATE INDEX "InventoryAllocation_inventoryBalanceId_status_idx"
  ON "InventoryAllocation"("inventoryBalanceId","status");

CREATE UNIQUE INDEX "InventoryDemand_fillId_key" ON "InventoryDemand"("fillId");
CREATE INDEX "InventoryDemand_siteId_status_neededBy_idx"
  ON "InventoryDemand"("siteId","status","neededBy");
CREATE INDEX "InventoryDemand_medicationId_status_idx"
  ON "InventoryDemand"("medicationId","status");
CREATE INDEX "InventoryDemand_productId_status_idx"
  ON "InventoryDemand"("productId","status");

CREATE UNIQUE INDEX "InventoryPolicy_siteId_policyKey_key"
  ON "InventoryPolicy"("siteId","policyKey");
CREATE INDEX "InventoryPolicy_siteId_scope_active_idx"
  ON "InventoryPolicy"("siteId","scope","active");
CREATE INDEX "InventoryPolicy_productId_active_idx"
  ON "InventoryPolicy"("productId","active");

CREATE INDEX "ReceivingDiscrepancy_siteId_status_createdAt_idx"
  ON "ReceivingDiscrepancy"("siteId","status","createdAt");
CREATE INDEX "ReceivingDiscrepancy_purchaseOrderId_status_idx"
  ON "ReceivingDiscrepancy"("purchaseOrderId","status");
CREATE INDEX "ReceivingDiscrepancy_purchaseOrderLineId_status_idx"
  ON "ReceivingDiscrepancy"("purchaseOrderLineId","status");

CREATE UNIQUE INDEX "InventoryException_siteId_fingerprint_key"
  ON "InventoryException"("siteId","fingerprint");
CREATE INDEX "InventoryException_siteId_status_severity_lastDetectedAt_idx"
  ON "InventoryException"("siteId","status","severity","lastDetectedAt");
CREATE INDEX "InventoryException_type_status_idx"
  ON "InventoryException"("type","status");

CREATE INDEX "InventoryTransferCustodyEvent_transferId_occurredAt_idx"
  ON "InventoryTransferCustodyEvent"("transferId","occurredAt");
CREATE INDEX "InventoryTransferCustodyEvent_siteId_occurredAt_idx"
  ON "InventoryTransferCustodyEvent"("siteId","occurredAt");

ALTER TABLE "InventoryLocation"
  ADD CONSTRAINT "InventoryLocation_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryStockPosition"
  ADD CONSTRAINT "InventoryStockPosition_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryStockPosition"
  ADD CONSTRAINT "InventoryStockPosition_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryAllocation"
  ADD CONSTRAINT "InventoryAllocation_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryAllocation"
  ADD CONSTRAINT "InventoryAllocation_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryAllocation"
  ADD CONSTRAINT "InventoryAllocation_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryAllocation"
  ADD CONSTRAINT "InventoryAllocation_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryDemand"
  ADD CONSTRAINT "InventoryDemand_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryDemand"
  ADD CONSTRAINT "InventoryDemand_medicationId_fkey"
  FOREIGN KEY ("medicationId") REFERENCES "Medication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryDemand"
  ADD CONSTRAINT "InventoryDemand_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryDemand"
  ADD CONSTRAINT "InventoryDemand_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryPolicy"
  ADD CONSTRAINT "InventoryPolicy_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryPolicy"
  ADD CONSTRAINT "InventoryPolicy_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReceivingDiscrepancy"
  ADD CONSTRAINT "ReceivingDiscrepancy_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy"
  ADD CONSTRAINT "ReceivingDiscrepancy_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy"
  ADD CONSTRAINT "ReceivingDiscrepancy_purchaseOrderLineId_fkey"
  FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy"
  ADD CONSTRAINT "ReceivingDiscrepancy_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "PurchaseOrderReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy"
  ADD CONSTRAINT "ReceivingDiscrepancy_expectedProductId_fkey"
  FOREIGN KEY ("expectedProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy"
  ADD CONSTRAINT "ReceivingDiscrepancy_observedProductId_fkey"
  FOREIGN KEY ("observedProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy"
  ADD CONSTRAINT "ReceivingDiscrepancy_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy"
  ADD CONSTRAINT "ReceivingDiscrepancy_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryException"
  ADD CONSTRAINT "InventoryException_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryException"
  ADD CONSTRAINT "InventoryException_acknowledgedById_fkey"
  FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryException"
  ADD CONSTRAINT "InventoryException_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryTransferCustodyEvent"
  ADD CONSTRAINT "InventoryTransferCustodyEvent_transferId_fkey"
  FOREIGN KEY ("transferId") REFERENCES "InventoryTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferCustodyEvent"
  ADD CONSTRAINT "InventoryTransferCustodyEvent_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferCustodyEvent"
  ADD CONSTRAINT "InventoryTransferCustodyEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Default physical locations for every existing pharmacy site.
INSERT INTO "InventoryLocation" (
  "id","siteId","code","name","type","active",
  "isDefaultReceiving","isDefaultDispensing","isQuarantine","updatedAt"
)
SELECT
  'location-storage-' || "id",
  "id",
  'STORAGE',
  'Primary Stock',
  'SHELF',
  true,
  true,
  true,
  false,
  CURRENT_TIMESTAMP
FROM "PharmacySite";

INSERT INTO "InventoryLocation" (
  "id","siteId","code","name","type","active",
  "isDefaultReceiving","isDefaultDispensing","isQuarantine","updatedAt"
)
SELECT
  'location-quarantine-' || "id",
  "id",
  'QUARANTINE',
  'Quarantine',
  'QUARANTINE',
  true,
  false,
  false,
  true,
  CURRENT_TIMESTAMP
FROM "PharmacySite";

-- Backfill physical positions so position quantities equal current physical on-hand.
INSERT INTO "InventoryStockPosition" (
  "id","inventoryBalanceId","locationId","state","quantity","updatedAt"
)
SELECT
  'position-available-' || b."id",
  b."id",
  'location-storage-' || b."siteId",
  'AVAILABLE',
  b."onHandQuantity" - b."quarantinedQuantity",
  CURRENT_TIMESTAMP
FROM "InventoryBalance" b
WHERE b."onHandQuantity" - b."quarantinedQuantity" > 0;

INSERT INTO "InventoryStockPosition" (
  "id","inventoryBalanceId","locationId","state","quantity","updatedAt"
)
SELECT
  'position-quarantine-' || b."id",
  b."id",
  'location-quarantine-' || b."siteId",
  'QUARANTINED',
  b."quarantinedQuantity",
  CURRENT_TIMESTAMP
FROM "InventoryBalance" b
WHERE b."quarantinedQuantity" > 0;

-- Seed a site-default inventory policy. Product-specific policies override this in code.
INSERT INTO "InventoryPolicy" (
  "id","siteId","scope","policyKey","minShelfLifeDays","expirationWarningDays",
  "fefoEnabled","staleReservationHours","staleTransferHours",
  "purchaseOrderOverdueDays","active","updatedAt"
)
SELECT
  'policy-default-' || "id",
  "id",
  'SITE',
  'SITE_DEFAULT',
  30,
  90,
  true,
  24,
  48,
  3,
  true,
  CURRENT_TIMESTAMP
FROM "PharmacySite";
