-- Complete Phase 3H: site transfers, recall cases, and purchase-order reconciliation

ALTER TYPE "InventoryTransactionType" ADD VALUE IF NOT EXISTS 'TRANSFER_OUT';
ALTER TYPE "InventoryTransactionType" ADD VALUE IF NOT EXISTS 'TRANSFER_IN';
ALTER TYPE "InventoryTransactionType" ADD VALUE IF NOT EXISTS 'TRANSFER_CANCEL_RETURN';

CREATE TYPE "InventoryTransferStatus" AS ENUM ('IN_TRANSIT', 'RECEIVED', 'CANCELLED');
CREATE TYPE "RecallStatus" AS ENUM ('ACTIVE', 'CLOSED');
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('OPEN', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

CREATE TABLE "InventoryTransfer" (
  "id" TEXT NOT NULL,
  "sourceSiteId" TEXT NOT NULL,
  "destinationSiteId" TEXT NOT NULL,
  "sourceInventoryBalanceId" TEXT NOT NULL,
  "destinationInventoryBalanceId" TEXT,
  "productId" TEXT NOT NULL,
  "lotNumber" TEXT NOT NULL,
  "expirationDate" TIMESTAMP(3) NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL,
  "status" "InventoryTransferStatus" NOT NULL DEFAULT 'IN_TRANSIT',
  "note" TEXT,
  "initiatedById" TEXT NOT NULL,
  "receivedById" TEXT,
  "cancelledById" TEXT,
  "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "receivedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),

  CONSTRAINT "InventoryTransfer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryTransfer_positive_quantity" CHECK ("quantity" > 0),
  CONSTRAINT "InventoryTransfer_distinct_sites" CHECK ("sourceSiteId" <> "destinationSiteId")
);

CREATE TABLE "RecallCase" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "lotNumber" TEXT,
  "lotNumberSearch" TEXT,
  "reference" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" "RecallStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" TEXT NOT NULL,
  "closedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "closureNote" TEXT,

  CONSTRAINT "RecallCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecallAffectedFill" (
  "id" TEXT NOT NULL,
  "recallCaseId" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RecallAffectedFill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseOrder" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "orderNumber" TEXT NOT NULL,
  "supplierName" TEXT NOT NULL,
  "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'OPEN',
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "cancelledById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledAt" TIMESTAMP(3),

  CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseOrderLine" (
  "id" TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "quantityOrdered" DECIMAL(14,3) NOT NULL,
  "quantityReceived" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "unitCost" DECIMAL(12,6),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseOrderLine_positive_ordered" CHECK ("quantityOrdered" > 0),
  CONSTRAINT "PurchaseOrderLine_received_range" CHECK ("quantityReceived" >= 0 AND "quantityReceived" <= "quantityOrdered")
);

CREATE TABLE "PurchaseOrderReceipt" (
  "id" TEXT NOT NULL,
  "purchaseOrderLineId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "inventoryTransactionId" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL,
  "lotNumber" TEXT NOT NULL,
  "expirationDate" TIMESTAMP(3) NOT NULL,
  "invoiceReference" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PurchaseOrderReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PurchaseOrderReceipt_positive_quantity" CHECK ("quantity" > 0)
);

ALTER TABLE "InventoryHold" ADD COLUMN "recallCaseId" TEXT;
ALTER TABLE "InventoryTransaction" ADD COLUMN "inventoryTransferId" TEXT;

CREATE INDEX "InventoryTransfer_sourceSiteId_status_shippedAt_idx"
  ON "InventoryTransfer"("sourceSiteId", "status", "shippedAt");
CREATE INDEX "InventoryTransfer_destinationSiteId_status_shippedAt_idx"
  ON "InventoryTransfer"("destinationSiteId", "status", "shippedAt");
CREATE INDEX "InventoryTransfer_sourceInventoryBalanceId_status_idx"
  ON "InventoryTransfer"("sourceInventoryBalanceId", "status");

CREATE INDEX "RecallCase_siteId_status_createdAt_idx"
  ON "RecallCase"("siteId", "status", "createdAt");
CREATE INDEX "RecallCase_siteId_productId_lotNumberSearch_status_idx"
  ON "RecallCase"("siteId", "productId", "lotNumberSearch", "status");
CREATE INDEX "RecallCase_reference_idx" ON "RecallCase"("reference");

CREATE UNIQUE INDEX "RecallAffectedFill_recallCaseId_fillId_key"
  ON "RecallAffectedFill"("recallCaseId", "fillId");
CREATE INDEX "RecallAffectedFill_fillId_idx" ON "RecallAffectedFill"("fillId");

CREATE UNIQUE INDEX "PurchaseOrder_siteId_orderNumber_key"
  ON "PurchaseOrder"("siteId", "orderNumber");
CREATE INDEX "PurchaseOrder_siteId_status_createdAt_idx"
  ON "PurchaseOrder"("siteId", "status", "createdAt");
CREATE INDEX "PurchaseOrder_supplierName_idx" ON "PurchaseOrder"("supplierName");

CREATE INDEX "PurchaseOrderLine_purchaseOrderId_idx"
  ON "PurchaseOrderLine"("purchaseOrderId");
CREATE INDEX "PurchaseOrderLine_productId_idx"
  ON "PurchaseOrderLine"("productId");

CREATE UNIQUE INDEX "PurchaseOrderReceipt_inventoryTransactionId_key"
  ON "PurchaseOrderReceipt"("inventoryTransactionId");
CREATE INDEX "PurchaseOrderReceipt_purchaseOrderLineId_receivedAt_idx"
  ON "PurchaseOrderReceipt"("purchaseOrderLineId", "receivedAt");
CREATE INDEX "PurchaseOrderReceipt_inventoryBalanceId_receivedAt_idx"
  ON "PurchaseOrderReceipt"("inventoryBalanceId", "receivedAt");

CREATE INDEX "InventoryHold_recallCaseId_status_idx"
  ON "InventoryHold"("recallCaseId", "status");
CREATE INDEX "InventoryTransaction_inventoryTransferId_occurredAt_idx"
  ON "InventoryTransaction"("inventoryTransferId", "occurredAt");

ALTER TABLE "InventoryTransfer"
  ADD CONSTRAINT "InventoryTransfer_sourceSiteId_fkey"
  FOREIGN KEY ("sourceSiteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer"
  ADD CONSTRAINT "InventoryTransfer_destinationSiteId_fkey"
  FOREIGN KEY ("destinationSiteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer"
  ADD CONSTRAINT "InventoryTransfer_sourceInventoryBalanceId_fkey"
  FOREIGN KEY ("sourceInventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer"
  ADD CONSTRAINT "InventoryTransfer_destinationInventoryBalanceId_fkey"
  FOREIGN KEY ("destinationInventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer"
  ADD CONSTRAINT "InventoryTransfer_initiatedById_fkey"
  FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer"
  ADD CONSTRAINT "InventoryTransfer_receivedById_fkey"
  FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryTransfer"
  ADD CONSTRAINT "InventoryTransfer_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecallCase"
  ADD CONSTRAINT "RecallCase_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecallCase"
  ADD CONSTRAINT "RecallCase_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecallCase"
  ADD CONSTRAINT "RecallCase_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecallCase"
  ADD CONSTRAINT "RecallCase_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecallAffectedFill"
  ADD CONSTRAINT "RecallAffectedFill_recallCaseId_fkey"
  FOREIGN KEY ("recallCaseId") REFERENCES "RecallCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecallAffectedFill"
  ADD CONSTRAINT "RecallAffectedFill_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryHold"
  ADD CONSTRAINT "InventoryHold_recallCaseId_fkey"
  FOREIGN KEY ("recallCaseId") REFERENCES "RecallCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_inventoryTransferId_fkey"
  FOREIGN KEY ("inventoryTransferId") REFERENCES "InventoryTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrder"
  ADD CONSTRAINT "PurchaseOrder_cancelledById_fkey"
  FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderLine"
  ADD CONSTRAINT "PurchaseOrderLine_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderReceipt"
  ADD CONSTRAINT "PurchaseOrderReceipt_purchaseOrderLineId_fkey"
  FOREIGN KEY ("purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderReceipt"
  ADD CONSTRAINT "PurchaseOrderReceipt_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderReceipt"
  ADD CONSTRAINT "PurchaseOrderReceipt_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseOrderReceipt"
  ADD CONSTRAINT "PurchaseOrderReceipt_inventoryTransactionId_fkey"
  FOREIGN KEY ("inventoryTransactionId") REFERENCES "InventoryTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
