-- Phase 3H inventory architecture expansion:
-- locations, demand/backorder, policy, receiving discrepancies/idempotency,
-- transfer custody, cost layers, and derived operational intelligence.

CREATE TYPE "InventoryLocationType" AS ENUM (
  'DISPENSING',
  'RECEIVING',
  'REFRIGERATOR',
  'FREEZER',
  'SAFE',
  'QUARANTINE',
  'RETURN_TO_VENDOR',
  'OVERFLOW',
  'UNASSIGNED',
  'OTHER'
);

CREATE TYPE "InventoryDemandReason" AS ENUM (
  'PARTIAL_COMPLETION',
  'SCHEDULED_FILL',
  'SHORTAGE',
  'MANUAL'
);

CREATE TYPE "InventoryDemandStatus" AS ENUM (
  'OPEN',
  'PARTIALLY_SATISFIED',
  'SATISFIED',
  'CANCELLED'
);

CREATE TYPE "ReceivingDiscrepancyType" AS ENUM (
  'SHORT_SHIPMENT',
  'OVERAGE',
  'WRONG_PRODUCT',
  'DAMAGED_PRODUCT',
  'LOT_EXPIRATION_MISMATCH',
  'INVOICE_MISMATCH',
  'DUPLICATE_SHIPMENT',
  'UNPLANNED_RECEIPT',
  'OTHER'
);

CREATE TYPE "ReceivingDiscrepancyStatus" AS ENUM (
  'OPEN',
  'RESOLVED',
  'DISMISSED'
);

ALTER TABLE "InventoryTransfer" ADD COLUMN "unitCostSnapshot" DECIMAL(12,6);

CREATE TYPE "TransferCustodyEventType" AS ENUM (
  'PACKED',
  'VERIFIED',
  'HANDED_OFF',
  'RECEIVED',
  'DISCREPANCY_REPORTED',
  'CANCELLED'
);

CREATE TABLE "InventoryLocation" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "InventoryLocationType" NOT NULL DEFAULT 'OTHER',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "temperatureMinC" DECIMAL(6,2),
  "temperatureMaxC" DECIMAL(6,2),
  "pickPriority" INTEGER NOT NULL DEFAULT 100,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryLocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryPosition" (
  "id" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryPosition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryPosition_nonnegative_quantity" CHECK ("quantity" >= 0)
);

CREATE TABLE "InventoryLocationMovement" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "fromLocationId" TEXT,
  "toLocationId" TEXT,
  "fromPositionId" TEXT,
  "toPositionId" TEXT,
  "quantity" DECIMAL(14,3) NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryLocationMovement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryLocationMovement_positive_quantity" CHECK ("quantity" > 0),
  CONSTRAINT "InventoryLocationMovement_has_endpoint" CHECK ("fromLocationId" IS NOT NULL OR "toLocationId" IS NOT NULL)
);

CREATE TABLE "InventoryPolicy" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "policyKey" TEXT NOT NULL,
  "medicationId" TEXT,
  "productId" TEXT,
  "reorderPoint" DECIMAL(14,3),
  "parLevel" DECIMAL(14,3),
  "minShelfLifeDays" INTEGER,
  "expirationWarningDays" INTEGER NOT NULL DEFAULT 90,
  "fefoEnabled" BOOLEAN NOT NULL DEFAULT true,
  "preferredSupplierName" TEXT,
  "adjustmentApprovalThreshold" DECIMAL(14,3),
  "requireTransferSecondCheck" BOOLEAN NOT NULL DEFAULT false,
  "staleReservationHours" INTEGER NOT NULL DEFAULT 24,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryPolicy_nonnegative_thresholds" CHECK (
    ("reorderPoint" IS NULL OR "reorderPoint" >= 0)
    AND ("parLevel" IS NULL OR "parLevel" >= 0)
    AND ("minShelfLifeDays" IS NULL OR "minShelfLifeDays" >= 0)
    AND "expirationWarningDays" >= 0
    AND ("adjustmentApprovalThreshold" IS NULL OR "adjustmentApprovalThreshold" >= 0)
    AND "staleReservationHours" >= 1
  )
);

CREATE TABLE "InventoryDemand" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "medicationId" TEXT NOT NULL,
  "preferredProductId" TEXT,
  "fillId" TEXT,
  "reason" "InventoryDemandReason" NOT NULL,
  "status" "InventoryDemandStatus" NOT NULL DEFAULT 'OPEN',
  "quantityRequired" DECIMAL(14,3) NOT NULL,
  "quantitySatisfied" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "dueAt" TIMESTAMP(3),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryDemand_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryDemand_quantity_range" CHECK (
    "quantityRequired" > 0
    AND "quantitySatisfied" >= 0
    AND "quantitySatisfied" <= "quantityRequired"
  )
);

CREATE TABLE "InventoryDemandSupplyLink" (
  "id" TEXT NOT NULL,
  "inventoryDemandId" TEXT NOT NULL,
  "purchaseOrderLineId" TEXT NOT NULL,
  "quantityPlanned" DECIMAL(14,3) NOT NULL,
  "quantityReceived" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryDemandSupplyLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryDemandSupplyLink_quantity_range" CHECK (
    "quantityPlanned" > 0
    AND "quantityReceived" >= 0
    AND "quantityReceived" <= "quantityPlanned"
  )
);

CREATE TABLE "ReceivingDiscrepancy" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "purchaseOrderLineId" TEXT,
  "purchaseOrderReceiptId" TEXT,
  "type" "ReceivingDiscrepancyType" NOT NULL,
  "status" "ReceivingDiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
  "expectedQuantity" DECIMAL(14,3),
  "observedQuantity" DECIMAL(14,3),
  "detail" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "resolvedById" TEXT,
  "resolutionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReceivingDiscrepancy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReceivingDiscrepancy_nonnegative_quantities" CHECK (
    ("expectedQuantity" IS NULL OR "expectedQuantity" >= 0)
    AND ("observedQuantity" IS NULL OR "observedQuantity" >= 0)
  )
);

CREATE TABLE "InventoryOperationKey" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "operationType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "resultEntityType" TEXT,
  "resultEntityId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryOperationKey_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryTransferCustodyEvent" (
  "id" TEXT NOT NULL,
  "inventoryTransferId" TEXT NOT NULL,
  "type" "TransferCustodyEventType" NOT NULL,
  "actorId" TEXT NOT NULL,
  "carrier" TEXT,
  "trackingReference" TEXT,
  "sealIdentifier" TEXT,
  "note" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryTransferCustodyEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryCostLayer" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "sourceTransactionId" TEXT NOT NULL,
  "quantityReceived" DECIMAL(14,3) NOT NULL,
  "quantityRemaining" DECIMAL(14,3) NOT NULL,
  "unitCost" DECIMAL(12,6) NOT NULL,
  "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceType" TEXT NOT NULL,
  "reference" TEXT,
  CONSTRAINT "InventoryCostLayer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryCostLayer_quantity_range" CHECK (
    "quantityReceived" > 0
    AND "quantityRemaining" >= 0
    AND "quantityRemaining" <= "quantityReceived"
    AND "unitCost" >= 0
  )
);

CREATE TABLE "InventoryCostConsumption" (
  "id" TEXT NOT NULL,
  "inventoryCostLayerId" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL,
  "unitCost" DECIMAL(12,6) NOT NULL,
  "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversedAt" TIMESTAMP(3),
  CONSTRAINT "InventoryCostConsumption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryCostConsumption_positive_values" CHECK ("quantity" > 0 AND "unitCost" >= 0)
);

CREATE UNIQUE INDEX "InventoryLocation_siteId_code_key" ON "InventoryLocation"("siteId", "code");
CREATE INDEX "InventoryLocation_siteId_type_active_idx" ON "InventoryLocation"("siteId", "type", "active");
CREATE INDEX "InventoryLocation_siteId_pickPriority_idx" ON "InventoryLocation"("siteId", "pickPriority");

CREATE UNIQUE INDEX "InventoryPosition_inventoryBalanceId_locationId_key" ON "InventoryPosition"("inventoryBalanceId", "locationId");
CREATE INDEX "InventoryPosition_locationId_idx" ON "InventoryPosition"("locationId");

CREATE INDEX "InventoryLocationMovement_siteId_occurredAt_idx" ON "InventoryLocationMovement"("siteId", "occurredAt");
CREATE INDEX "InventoryLocationMovement_inventoryBalanceId_occurredAt_idx" ON "InventoryLocationMovement"("inventoryBalanceId", "occurredAt");

CREATE UNIQUE INDEX "InventoryPolicy_siteId_policyKey_key" ON "InventoryPolicy"("siteId", "policyKey");
CREATE INDEX "InventoryPolicy_siteId_medicationId_idx" ON "InventoryPolicy"("siteId", "medicationId");
CREATE INDEX "InventoryPolicy_siteId_productId_idx" ON "InventoryPolicy"("siteId", "productId");

CREATE UNIQUE INDEX "InventoryDemand_fillId_key" ON "InventoryDemand"("fillId");
CREATE INDEX "InventoryDemand_siteId_status_dueAt_idx" ON "InventoryDemand"("siteId", "status", "dueAt");
CREATE INDEX "InventoryDemand_siteId_medicationId_status_idx" ON "InventoryDemand"("siteId", "medicationId", "status");

CREATE UNIQUE INDEX "InventoryDemandSupplyLink_inventoryDemandId_purchaseOrderLineId_key" ON "InventoryDemandSupplyLink"("inventoryDemandId", "purchaseOrderLineId");
CREATE INDEX "InventoryDemandSupplyLink_purchaseOrderLineId_idx" ON "InventoryDemandSupplyLink"("purchaseOrderLineId");

CREATE INDEX "ReceivingDiscrepancy_siteId_status_createdAt_idx" ON "ReceivingDiscrepancy"("siteId", "status", "createdAt");
CREATE INDEX "ReceivingDiscrepancy_purchaseOrderLineId_status_idx" ON "ReceivingDiscrepancy"("purchaseOrderLineId", "status");
CREATE INDEX "ReceivingDiscrepancy_purchaseOrderReceiptId_idx" ON "ReceivingDiscrepancy"("purchaseOrderReceiptId");

CREATE UNIQUE INDEX "InventoryOperationKey_siteId_operationType_idempotencyKey_key" ON "InventoryOperationKey"("siteId", "operationType", "idempotencyKey");
CREATE INDEX "InventoryOperationKey_createdAt_idx" ON "InventoryOperationKey"("createdAt");

CREATE INDEX "InventoryTransferCustodyEvent_inventoryTransferId_occurredAt_idx" ON "InventoryTransferCustodyEvent"("inventoryTransferId", "occurredAt");

CREATE UNIQUE INDEX "InventoryCostLayer_sourceTransactionId_key" ON "InventoryCostLayer"("sourceTransactionId");
CREATE INDEX "InventoryCostLayer_siteId_productId_acquiredAt_idx" ON "InventoryCostLayer"("siteId", "productId", "acquiredAt");
CREATE INDEX "InventoryCostLayer_inventoryBalanceId_acquiredAt_idx" ON "InventoryCostLayer"("inventoryBalanceId", "acquiredAt");

CREATE INDEX "InventoryCostConsumption_fillId_consumedAt_idx" ON "InventoryCostConsumption"("fillId", "consumedAt");
CREATE INDEX "InventoryCostConsumption_inventoryCostLayerId_consumedAt_idx" ON "InventoryCostConsumption"("inventoryCostLayerId", "consumedAt");

ALTER TABLE "InventoryLocation" ADD CONSTRAINT "InventoryLocation_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryPosition" ADD CONSTRAINT "InventoryPosition_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryPosition" ADD CONSTRAINT "InventoryPosition_locationId_fkey"
  FOREIGN KEY ("locationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_fromLocationId_fkey"
  FOREIGN KEY ("fromLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_toLocationId_fkey"
  FOREIGN KEY ("toLocationId") REFERENCES "InventoryLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_fromPositionId_fkey"
  FOREIGN KEY ("fromPositionId") REFERENCES "InventoryPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_toPositionId_fkey"
  FOREIGN KEY ("toPositionId") REFERENCES "InventoryPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryLocationMovement" ADD CONSTRAINT "InventoryLocationMovement_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryPolicy" ADD CONSTRAINT "InventoryPolicy_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryPolicy" ADD CONSTRAINT "InventoryPolicy_medicationId_fkey"
  FOREIGN KEY ("medicationId") REFERENCES "Medication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryPolicy" ADD CONSTRAINT "InventoryPolicy_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryDemand" ADD CONSTRAINT "InventoryDemand_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryDemand" ADD CONSTRAINT "InventoryDemand_medicationId_fkey"
  FOREIGN KEY ("medicationId") REFERENCES "Medication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryDemand" ADD CONSTRAINT "InventoryDemand_preferredProductId_fkey"
  FOREIGN KEY ("preferredProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryDemand" ADD CONSTRAINT "InventoryDemand_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryDemandSupplyLink" ADD CONSTRAINT "InventoryDemandSupplyLink_inventoryDemandId_fkey"
  FOREIGN KEY ("inventoryDemandId") REFERENCES "InventoryDemand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryDemandSupplyLink" ADD CONSTRAINT "InventoryDemandSupplyLink_purchaseOrderLineId_fkey"
  FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReceivingDiscrepancy" ADD CONSTRAINT "ReceivingDiscrepancy_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy" ADD CONSTRAINT "ReceivingDiscrepancy_purchaseOrderLineId_fkey"
  FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy" ADD CONSTRAINT "ReceivingDiscrepancy_purchaseOrderReceiptId_fkey"
  FOREIGN KEY ("purchaseOrderReceiptId") REFERENCES "PurchaseOrderReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy" ADD CONSTRAINT "ReceivingDiscrepancy_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceivingDiscrepancy" ADD CONSTRAINT "ReceivingDiscrepancy_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryOperationKey" ADD CONSTRAINT "InventoryOperationKey_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryTransferCustodyEvent" ADD CONSTRAINT "InventoryTransferCustodyEvent_inventoryTransferId_fkey"
  FOREIGN KEY ("inventoryTransferId") REFERENCES "InventoryTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryTransferCustodyEvent" ADD CONSTRAINT "InventoryTransferCustodyEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryCostLayer" ADD CONSTRAINT "InventoryCostLayer_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryCostLayer" ADD CONSTRAINT "InventoryCostLayer_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryCostLayer" ADD CONSTRAINT "InventoryCostLayer_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryCostLayer" ADD CONSTRAINT "InventoryCostLayer_sourceTransactionId_fkey"
  FOREIGN KEY ("sourceTransactionId") REFERENCES "InventoryTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryCostConsumption" ADD CONSTRAINT "InventoryCostConsumption_inventoryCostLayerId_fkey"
  FOREIGN KEY ("inventoryCostLayerId") REFERENCES "InventoryCostLayer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryCostConsumption" ADD CONSTRAINT "InventoryCostConsumption_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryCostConsumption" ADD CONSTRAINT "InventoryCostConsumption_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill every existing site with a safe legacy location and every existing
-- balance into that location. This preserves current ledger quantities while
-- making physical-location coverage explicit from the migration forward.
INSERT INTO "InventoryLocation" (
  "id", "siteId", "code", "name", "type", "active", "pickPriority", "createdAt", "updatedAt"
)
SELECT
  "id" || ':location:unassigned',
  "id",
  'UNASSIGNED',
  'Unassigned / legacy stock',
  'UNASSIGNED',
  true,
  1000,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "PharmacySite";

INSERT INTO "InventoryPosition" (
  "id", "inventoryBalanceId", "locationId", "quantity", "createdAt", "updatedAt"
)
SELECT
  b."id" || ':position:unassigned',
  b."id",
  b."siteId" || ':location:unassigned',
  b."onHandQuantity",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "InventoryBalance" b;
