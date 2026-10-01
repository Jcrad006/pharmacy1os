-- Phase 3H: inventory ledger and dispensing reservations

CREATE TYPE "InventoryTransactionType" AS ENUM (
  'RECEIVE',
  'RESERVE',
  'RELEASE',
  'DISPENSE',
  'RETURN_TO_STOCK',
  'ADJUSTMENT'
);

ALTER TABLE "PrescriptionFill"
  ADD COLUMN "inventoryBalanceId" TEXT,
  ADD COLUMN "inventoryReservedAt" TIMESTAMP(3),
  ADD COLUMN "inventoryCommittedAt" TIMESTAMP(3),
  ADD COLUMN "inventoryReturnedAt" TIMESTAMP(3);

CREATE TABLE "InventoryBalance" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productLotId" TEXT NOT NULL,
  "productExpirationId" TEXT NOT NULL,
  "onHandQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "reservedQuantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryBalance_nonnegative_on_hand" CHECK ("onHandQuantity" >= 0),
  CONSTRAINT "InventoryBalance_nonnegative_reserved" CHECK ("reservedQuantity" >= 0),
  CONSTRAINT "InventoryBalance_reserved_not_over_on_hand" CHECK ("reservedQuantity" <= "onHandQuantity")
);

CREATE TABLE "InventoryTransaction" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "fillId" TEXT,
  "actorId" TEXT,
  "type" "InventoryTransactionType" NOT NULL,
  "onHandDelta" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "reservedDelta" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "reason" TEXT,
  "source" TEXT,
  "reference" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InventoryTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryBalance_siteId_productId_productLotId_productExpirationId_key"
  ON "InventoryBalance"("siteId", "productId", "productLotId", "productExpirationId");
CREATE INDEX "InventoryBalance_siteId_productId_idx"
  ON "InventoryBalance"("siteId", "productId");
CREATE INDEX "InventoryBalance_productLotId_idx"
  ON "InventoryBalance"("productLotId");
CREATE INDEX "InventoryBalance_productExpirationId_idx"
  ON "InventoryBalance"("productExpirationId");

CREATE INDEX "InventoryTransaction_siteId_occurredAt_idx"
  ON "InventoryTransaction"("siteId", "occurredAt");
CREATE INDEX "InventoryTransaction_inventoryBalanceId_occurredAt_idx"
  ON "InventoryTransaction"("inventoryBalanceId", "occurredAt");
CREATE INDEX "InventoryTransaction_fillId_occurredAt_idx"
  ON "InventoryTransaction"("fillId", "occurredAt");
CREATE INDEX "InventoryTransaction_actorId_occurredAt_idx"
  ON "InventoryTransaction"("actorId", "occurredAt");

CREATE INDEX "PrescriptionFill_inventoryBalanceId_idx"
  ON "PrescriptionFill"("inventoryBalanceId");

ALTER TABLE "InventoryBalance"
  ADD CONSTRAINT "InventoryBalance_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryBalance"
  ADD CONSTRAINT "InventoryBalance_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryBalance"
  ADD CONSTRAINT "InventoryBalance_productLotId_fkey"
  FOREIGN KEY ("productLotId") REFERENCES "ProductLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryBalance"
  ADD CONSTRAINT "InventoryBalance_productExpirationId_fkey"
  FOREIGN KEY ("productExpirationId") REFERENCES "ProductExpiration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryTransaction"
  ADD CONSTRAINT "InventoryTransaction_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
