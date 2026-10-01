CREATE TYPE "PosTransactionStatus" AS ENUM ('COMPLETED', 'VOIDED');
CREATE TYPE "PosPriceBasis" AS ENUM ('THIRD_PARTY', 'CASH', 'COMPLETION_ALREADY_BILLED');
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'CHECK', 'OTHER');

CREATE TABLE "PointOfSaleTransaction" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "receiptNumber" TEXT NOT NULL,
  "status" "PosTransactionStatus" NOT NULL DEFAULT 'COMPLETED',
  "totalDue" DECIMAL(12,2) NOT NULL,
  "totalTendered" DECIMAL(12,2) NOT NULL,
  "changeDue" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "idempotencyKey" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "voidedById" TEXT,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt" TIMESTAMP(3),
  "voidReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointOfSaleTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PointOfSaleLine" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "claimTransactionId" TEXT,
  "quantity" DECIMAL(10,3) NOT NULL,
  "priceBasis" "PosPriceBasis" NOT NULL,
  "cashUnitPriceSnapshot" DECIMAL(12,6),
  "cashPricingSnapshot" JSONB NOT NULL DEFAULT '{}',
  "patientResponsibilitySnapshot" DECIMAL(12,2),
  "amountDue" DECIMAL(12,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PointOfSaleLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentTender" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "reference" TEXT,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentTender_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PointOfSaleTransaction_receiptNumber_key"
  ON "PointOfSaleTransaction"("receiptNumber");
CREATE UNIQUE INDEX "PointOfSaleTransaction_idempotencyKey_key"
  ON "PointOfSaleTransaction"("idempotencyKey");
CREATE INDEX "PointOfSaleTransaction_siteId_completedAt_idx"
  ON "PointOfSaleTransaction"("siteId", "completedAt");
CREATE INDEX "PointOfSaleTransaction_patientId_completedAt_idx"
  ON "PointOfSaleTransaction"("patientId", "completedAt");
CREATE INDEX "PointOfSaleTransaction_siteId_status_completedAt_idx"
  ON "PointOfSaleTransaction"("siteId", "status", "completedAt");

CREATE UNIQUE INDEX "PointOfSaleLine_fillId_key"
  ON "PointOfSaleLine"("fillId");
CREATE INDEX "PointOfSaleLine_transactionId_idx"
  ON "PointOfSaleLine"("transactionId");
CREATE INDEX "PointOfSaleLine_claimTransactionId_idx"
  ON "PointOfSaleLine"("claimTransactionId");
CREATE INDEX "PointOfSaleLine_priceBasis_createdAt_idx"
  ON "PointOfSaleLine"("priceBasis", "createdAt");

CREATE INDEX "PaymentTender_transactionId_createdAt_idx"
  ON "PaymentTender"("transactionId", "createdAt");
CREATE INDEX "PaymentTender_actorId_createdAt_idx"
  ON "PaymentTender"("actorId", "createdAt");

ALTER TABLE "PointOfSaleTransaction"
  ADD CONSTRAINT "PointOfSaleTransaction_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointOfSaleTransaction"
  ADD CONSTRAINT "PointOfSaleTransaction_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointOfSaleTransaction"
  ADD CONSTRAINT "PointOfSaleTransaction_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointOfSaleTransaction"
  ADD CONSTRAINT "PointOfSaleTransaction_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PointOfSaleLine"
  ADD CONSTRAINT "PointOfSaleLine_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "PointOfSaleTransaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointOfSaleLine"
  ADD CONSTRAINT "PointOfSaleLine_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointOfSaleLine"
  ADD CONSTRAINT "PointOfSaleLine_claimTransactionId_fkey"
  FOREIGN KEY ("claimTransactionId") REFERENCES "ClaimTransaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaymentTender"
  ADD CONSTRAINT "PaymentTender_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "PointOfSaleTransaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentTender"
  ADD CONSTRAINT "PaymentTender_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PointOfSaleTransaction"
  ADD CONSTRAINT "PointOfSaleTransaction_amounts_check"
  CHECK ("totalDue" >= 0 AND "totalTendered" >= 0 AND "changeDue" >= 0);

ALTER TABLE "PointOfSaleLine"
  ADD CONSTRAINT "PointOfSaleLine_amounts_check"
  CHECK ("quantity" > 0 AND "amountDue" >= 0);

ALTER TABLE "PaymentTender"
  ADD CONSTRAINT "PaymentTender_amount_check"
  CHECK ("amount" > 0);
