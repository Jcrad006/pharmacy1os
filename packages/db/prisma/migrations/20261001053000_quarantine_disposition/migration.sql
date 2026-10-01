-- Phase 3H: quarantine, damaged/expired stock control, and audited disposition

ALTER TYPE "InventoryTransactionType" ADD VALUE IF NOT EXISTS 'QUARANTINE';
ALTER TYPE "InventoryTransactionType" ADD VALUE IF NOT EXISTS 'RELEASE_QUARANTINE';
ALTER TYPE "InventoryTransactionType" ADD VALUE IF NOT EXISTS 'DISPOSE';

CREATE TYPE "InventoryHoldStatus" AS ENUM (
  'ACTIVE',
  'RELEASED',
  'DISPOSED'
);

CREATE TYPE "InventoryHoldReason" AS ENUM (
  'DAMAGED',
  'EXPIRED',
  'RECALL',
  'SUSPECT_PRODUCT',
  'TEMPERATURE_EXCURSION',
  'OTHER'
);

CREATE TYPE "InventoryDispositionType" AS ENUM (
  'DESTROY',
  'RETURN_TO_VENDOR',
  'REVERSE_DISTRIBUTOR',
  'OTHER'
);

ALTER TABLE "InventoryBalance"
  ADD COLUMN "quarantinedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0;

ALTER TABLE "InventoryBalance"
  DROP CONSTRAINT IF EXISTS "InventoryBalance_reserved_not_over_on_hand";

ALTER TABLE "InventoryBalance"
  ADD CONSTRAINT "InventoryBalance_nonnegative_quarantined"
  CHECK ("quarantinedQuantity" >= 0);

ALTER TABLE "InventoryBalance"
  ADD CONSTRAINT "InventoryBalance_allocated_not_over_on_hand"
  CHECK (("reservedQuantity" + "quarantinedQuantity") <= "onHandQuantity");

ALTER TABLE "CycleCountLine"
  ADD COLUMN "expectedQuarantined" DECIMAL(14,3);

CREATE TABLE "InventoryHold" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL,
  "reasonCode" "InventoryHoldReason" NOT NULL,
  "note" TEXT,
  "status" "InventoryHoldStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" TEXT NOT NULL,
  "resolvedById" TEXT,
  "resolutionNote" TEXT,
  "dispositionType" "InventoryDispositionType",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InventoryHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryHold_positive_quantity" CHECK ("quantity" > 0)
);

CREATE INDEX "InventoryHold_siteId_status_createdAt_idx"
  ON "InventoryHold"("siteId", "status", "createdAt");
CREATE INDEX "InventoryHold_inventoryBalanceId_status_idx"
  ON "InventoryHold"("inventoryBalanceId", "status");
CREATE INDEX "InventoryHold_reasonCode_status_idx"
  ON "InventoryHold"("reasonCode", "status");
CREATE INDEX "InventoryHold_createdById_createdAt_idx"
  ON "InventoryHold"("createdById", "createdAt");
CREATE INDEX "InventoryHold_resolvedById_resolvedAt_idx"
  ON "InventoryHold"("resolvedById", "resolvedAt");

ALTER TABLE "InventoryHold"
  ADD CONSTRAINT "InventoryHold_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryHold"
  ADD CONSTRAINT "InventoryHold_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryHold"
  ADD CONSTRAINT "InventoryHold_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryHold"
  ADD CONSTRAINT "InventoryHold_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryTransaction"
  ADD COLUMN "quarantinedDelta" DECIMAL(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN "inventoryHoldId" TEXT;

CREATE INDEX "InventoryTransaction_inventoryHoldId_occurredAt_idx"
  ON "InventoryTransaction"("inventoryHoldId", "occurredAt");

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_inventoryHoldId_fkey"
  FOREIGN KEY ("inventoryHoldId") REFERENCES "InventoryHold"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
