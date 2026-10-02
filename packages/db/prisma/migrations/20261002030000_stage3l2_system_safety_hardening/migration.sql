-- Stage 3L.2 system safety hardening primitives

CREATE TYPE "ExternalClaimOperationStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'AMBIGUOUS');
CREATE TYPE "ControlledSubstanceSchedule" AS ENUM ('NONE', 'II', 'III', 'IV', 'V');

ALTER TABLE "Medication"
  ADD COLUMN "controlledSubstanceSchedule" "ControlledSubstanceSchedule" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "requiresColdChain" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Prescription"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PrescriptionFill"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PrescriptionChangeRecord"
  ADD COLUMN "requiresStructuredApply" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "appliedField" TEXT,
  ADD COLUMN "beforeValue" JSONB,
  ADD COLUMN "afterValue" JSONB,
  ADD COLUMN "appliedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

ALTER TABLE "PrescriptionChangeRecord"
  ADD CONSTRAINT "PrescriptionChangeRecord_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PointOfSaleTransaction"
  ADD COLUMN "requestFingerprint" TEXT;

UPDATE "PointOfSaleTransaction"
SET "requestFingerprint" = 'legacy:' || "id"
WHERE "requestFingerprint" IS NULL;

ALTER TABLE "PointOfSaleTransaction"
  ALTER COLUMN "requestFingerprint" SET NOT NULL;

ALTER TABLE "InventoryTransaction"
  ADD COLUMN "idempotencyFingerprint" TEXT;

ALTER TABLE "PurchaseOrderReceipt"
  ADD COLUMN "idempotencyFingerprint" TEXT;

ALTER TABLE "InventoryAllocation"
  ADD COLUMN "inventoryStockPositionId" TEXT;

ALTER TABLE "InventoryAllocation"
  ADD CONSTRAINT "InventoryAllocation_inventoryStockPositionId_fkey"
  FOREIGN KEY ("inventoryStockPositionId") REFERENCES "InventoryStockPosition"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "InventoryAllocation_inventoryStockPositionId_status_idx"
  ON "InventoryAllocation"("inventoryStockPositionId", "status");

CREATE TABLE "ExternalClaimOperation" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "coveragePosition" INTEGER NOT NULL,
  "operation" "ClaimOperation" NOT NULL,
  "originalTransactionId" TEXT,
  "operationKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "requestSnapshot" JSONB NOT NULL,
  "status" "ExternalClaimOperationStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "transactionReference" TEXT,
  "responseSnapshot" JSONB,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ExternalClaimOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalClaimOperation_operationKey_key"
  ON "ExternalClaimOperation"("operationKey");

CREATE INDEX "ExternalClaimOperation_siteId_status_updatedAt_idx"
  ON "ExternalClaimOperation"("siteId", "status", "updatedAt");

CREATE INDEX "ExternalClaimOperation_fillId_coveragePosition_operation_updatedAt_idx"
  ON "ExternalClaimOperation"("fillId", "coveragePosition", "operation", "updatedAt");

ALTER TABLE "ExternalClaimOperation"
  ADD CONSTRAINT "ExternalClaimOperation_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ExternalClaimOperation"
  ADD CONSTRAINT "ExternalClaimOperation_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
