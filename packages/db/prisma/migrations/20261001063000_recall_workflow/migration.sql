-- Phase 3H: lot recall workflow and affected-fill traceability

CREATE TYPE "InventoryRecallStatus" AS ENUM (
  'OPEN',
  'CLOSED'
);

CREATE TABLE "InventoryRecall" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productLotId" TEXT NOT NULL,
  "status" "InventoryRecallStatus" NOT NULL DEFAULT 'OPEN',
  "source" TEXT,
  "referenceNumber" TEXT,
  "reason" TEXT NOT NULL,
  "initiatedById" TEXT NOT NULL,
  "closedById" TEXT,
  "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "closureNote" TEXT,

  CONSTRAINT "InventoryRecall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InventoryRecall_siteId_productLotId_status_idx"
  ON "InventoryRecall"("siteId", "productLotId", "status");
CREATE INDEX "InventoryRecall_siteId_status_initiatedAt_idx"
  ON "InventoryRecall"("siteId", "status", "initiatedAt");
CREATE INDEX "InventoryRecall_productId_productLotId_idx"
  ON "InventoryRecall"("productId", "productLotId");
CREATE INDEX "InventoryRecall_referenceNumber_idx"
  ON "InventoryRecall"("referenceNumber");
CREATE INDEX "InventoryRecall_initiatedById_initiatedAt_idx"
  ON "InventoryRecall"("initiatedById", "initiatedAt");
CREATE INDEX "InventoryRecall_closedById_closedAt_idx"
  ON "InventoryRecall"("closedById", "closedAt");

ALTER TABLE "InventoryRecall"
  ADD CONSTRAINT "InventoryRecall_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryRecall"
  ADD CONSTRAINT "InventoryRecall_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryRecall"
  ADD CONSTRAINT "InventoryRecall_productLotId_fkey"
  FOREIGN KEY ("productLotId") REFERENCES "ProductLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryRecall"
  ADD CONSTRAINT "InventoryRecall_initiatedById_fkey"
  FOREIGN KEY ("initiatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryRecall"
  ADD CONSTRAINT "InventoryRecall_closedById_fkey"
  FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "InventoryRecallAffectedFill" (
  "id" TEXT NOT NULL,
  "recallId" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "fillStatusAtIdentification" "FillStatus" NOT NULL,
  "prescriptionStatusAtIdentification" "PrescriptionStatus" NOT NULL,
  "identifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InventoryRecallAffectedFill_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryRecallAffectedFill_recallId_fillId_key"
  ON "InventoryRecallAffectedFill"("recallId", "fillId");
CREATE INDEX "InventoryRecallAffectedFill_fillId_identifiedAt_idx"
  ON "InventoryRecallAffectedFill"("fillId", "identifiedAt");

ALTER TABLE "InventoryRecallAffectedFill"
  ADD CONSTRAINT "InventoryRecallAffectedFill_recallId_fkey"
  FOREIGN KEY ("recallId") REFERENCES "InventoryRecall"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryRecallAffectedFill"
  ADD CONSTRAINT "InventoryRecallAffectedFill_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryHold"
  ADD COLUMN "recallId" TEXT;

CREATE INDEX "InventoryHold_recallId_status_idx"
  ON "InventoryHold"("recallId", "status");

ALTER TABLE "InventoryHold"
  ADD CONSTRAINT "InventoryHold_recallId_fkey"
  FOREIGN KEY ("recallId") REFERENCES "InventoryRecall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
