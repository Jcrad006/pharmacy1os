-- Phase 3H: cycle count sessions, line-level physical counts, and reviewed reconciliation

CREATE TYPE "CycleCountStatus" AS ENUM (
  'OPEN',
  'SUBMITTED',
  'APPROVED',
  'REJECTED'
);

CREATE TABLE "CycleCountSession" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "status" "CycleCountStatus" NOT NULL DEFAULT 'OPEN',
  "createdById" TEXT NOT NULL,
  "submittedById" TEXT,
  "reviewedById" TEXT,
  "note" TEXT,
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),

  CONSTRAINT "CycleCountSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CycleCountLine" (
  "id" TEXT NOT NULL,
  "cycleCountSessionId" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "expectedOnHand" DECIMAL(14,3),
  "expectedReserved" DECIMAL(14,3),
  "countedQuantity" DECIMAL(14,3),
  "discrepancy" DECIMAL(14,3),
  "countedById" TEXT,
  "countedAt" TIMESTAMP(3),
  "reconciledTransactionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CycleCountLine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CycleCountLine_count_nonnegative" CHECK ("countedQuantity" IS NULL OR "countedQuantity" >= 0)
);

CREATE INDEX "CycleCountSession_siteId_status_createdAt_idx"
  ON "CycleCountSession"("siteId", "status", "createdAt");

CREATE INDEX "CycleCountSession_createdById_createdAt_idx"
  ON "CycleCountSession"("createdById", "createdAt");

CREATE INDEX "CycleCountSession_submittedById_submittedAt_idx"
  ON "CycleCountSession"("submittedById", "submittedAt");

CREATE INDEX "CycleCountSession_reviewedById_reviewedAt_idx"
  ON "CycleCountSession"("reviewedById", "reviewedAt");

CREATE UNIQUE INDEX "CycleCountLine_cycleCountSessionId_inventoryBalanceId_key"
  ON "CycleCountLine"("cycleCountSessionId", "inventoryBalanceId");

CREATE UNIQUE INDEX "CycleCountLine_reconciledTransactionId_key"
  ON "CycleCountLine"("reconciledTransactionId");

CREATE INDEX "CycleCountLine_inventoryBalanceId_createdAt_idx"
  ON "CycleCountLine"("inventoryBalanceId", "createdAt");

CREATE INDEX "CycleCountLine_countedById_countedAt_idx"
  ON "CycleCountLine"("countedById", "countedAt");

ALTER TABLE "CycleCountSession"
  ADD CONSTRAINT "CycleCountSession_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCountSession"
  ADD CONSTRAINT "CycleCountSession_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCountSession"
  ADD CONSTRAINT "CycleCountSession_submittedById_fkey"
  FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCountSession"
  ADD CONSTRAINT "CycleCountSession_reviewedById_fkey"
  FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_cycleCountSessionId_fkey"
  FOREIGN KEY ("cycleCountSessionId") REFERENCES "CycleCountSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_countedById_fkey"
  FOREIGN KEY ("countedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CycleCountLine"
  ADD CONSTRAINT "CycleCountLine_reconciledTransactionId_fkey"
  FOREIGN KEY ("reconciledTransactionId") REFERENCES "InventoryTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
