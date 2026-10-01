-- Phase 3J: immutable third-party claim transactions and prescription label print queue.

CREATE TYPE "ClaimOperation" AS ENUM ('SUBMIT','REVERSAL');
CREATE TYPE "ClaimOutcome" AS ENUM ('PAID','REJECTED','ERROR','REVERSED');
CREATE TYPE "PrescriptionLabelStatus" AS ENUM ('ACTIVE','VOID');
CREATE TYPE "LabelPrintStatus" AS ENUM ('QUEUED','PRINTED','FAILED','CANCELLED');

ALTER TABLE "PrescriptionFill"
  ADD COLUMN "daysSupply" INTEGER;

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_daysSupply_check"
  CHECK ("daysSupply" IS NULL OR "daysSupply" > 0);

CREATE TABLE "ClaimTransaction" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "payerId" TEXT NOT NULL,
  "coverageIdSnapshot" TEXT NOT NULL,
  "coveragePosition" INTEGER NOT NULL,
  "operation" "ClaimOperation" NOT NULL,
  "outcome" "ClaimOutcome" NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "originalTransactionId" TEXT,
  "claimStandard" "ClaimStandard" NOT NULL,
  "adapterName" TEXT NOT NULL,
  "adapterVersion" TEXT NOT NULL,
  "billedProductId" TEXT NOT NULL,
  "billedNdc" TEXT NOT NULL,
  "memberIdSnapshot" TEXT NOT NULL,
  "personCodeSnapshot" TEXT,
  "groupIdSnapshot" TEXT,
  "payerIntendedQuantity" DECIMAL(10,3) NOT NULL,
  "physicalPartQuantity" DECIMAL(10,3) NOT NULL,
  "daysSupply" INTEGER NOT NULL,
  "requestSnapshot" JSONB NOT NULL,
  "responseSnapshot" JSONB NOT NULL,
  "transactionReference" TEXT,
  "authorizationNumber" TEXT,
  "amountPaid" DECIMAL(12,2),
  "patientResponsibility" DECIMAL(12,2),
  "rejectCodes" JSONB NOT NULL,
  "messages" JSONB NOT NULL,
  "createdById" TEXT NOT NULL,
  "adjudicatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClaimTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClaimTransaction_coveragePosition_check" CHECK ("coveragePosition" BETWEEN 1 AND 4),
  CONSTRAINT "ClaimTransaction_daysSupply_check" CHECK ("daysSupply" > 0),
  CONSTRAINT "ClaimTransaction_quantity_check" CHECK (
    "payerIntendedQuantity" > 0 AND "physicalPartQuantity" > 0
  )
);

CREATE TABLE "PrescriptionLabel" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "PrescriptionLabelStatus" NOT NULL DEFAULT 'ACTIVE',
  "claimTransactionId" TEXT,
  "rxNumberSnapshot" TEXT,
  "patientNameSnapshot" TEXT NOT NULL,
  "prescriberNameSnapshot" TEXT NOT NULL,
  "medicationSnapshot" TEXT NOT NULL,
  "sigSnapshot" TEXT NOT NULL,
  "physicalQuantity" DECIMAL(10,3) NOT NULL,
  "payerIntendedQuantity" DECIMAL(10,3),
  "daysSupply" INTEGER,
  "billedNdcSnapshot" TEXT,
  "sourceSummarySnapshot" JSONB NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt" TIMESTAMP(3),
  "voidReason" TEXT,
  CONSTRAINT "PrescriptionLabel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrescriptionLabel_version_check" CHECK ("version" > 0),
  CONSTRAINT "PrescriptionLabel_quantity_check" CHECK ("physicalQuantity" > 0)
);

CREATE TABLE "LabelPrintJob" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "labelId" TEXT NOT NULL,
  "status" "LabelPrintStatus" NOT NULL DEFAULT 'QUEUED',
  "copies" INTEGER NOT NULL DEFAULT 1,
  "printerName" TEXT,
  "actorId" TEXT,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "printedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  CONSTRAINT "LabelPrintJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LabelPrintJob_copies_check" CHECK ("copies" > 0)
);

CREATE UNIQUE INDEX "ClaimTransaction_idempotencyKey_key"
  ON "ClaimTransaction"("idempotencyKey");
CREATE INDEX "ClaimTransaction_siteId_createdAt_idx"
  ON "ClaimTransaction"("siteId","createdAt");
CREATE INDEX "ClaimTransaction_fillId_coveragePosition_createdAt_idx"
  ON "ClaimTransaction"("fillId","coveragePosition","createdAt");
CREATE INDEX "ClaimTransaction_payerId_outcome_createdAt_idx"
  ON "ClaimTransaction"("payerId","outcome","createdAt");
CREATE INDEX "ClaimTransaction_originalTransactionId_idx"
  ON "ClaimTransaction"("originalTransactionId");

CREATE UNIQUE INDEX "PrescriptionLabel_fillId_version_key"
  ON "PrescriptionLabel"("fillId","version");
CREATE INDEX "PrescriptionLabel_siteId_status_generatedAt_idx"
  ON "PrescriptionLabel"("siteId","status","generatedAt");
CREATE INDEX "PrescriptionLabel_claimTransactionId_idx"
  ON "PrescriptionLabel"("claimTransactionId");

CREATE INDEX "LabelPrintJob_siteId_status_queuedAt_idx"
  ON "LabelPrintJob"("siteId","status","queuedAt");
CREATE INDEX "LabelPrintJob_labelId_status_idx"
  ON "LabelPrintJob"("labelId","status");

ALTER TABLE "ClaimTransaction"
  ADD CONSTRAINT "ClaimTransaction_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimTransaction"
  ADD CONSTRAINT "ClaimTransaction_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimTransaction"
  ADD CONSTRAINT "ClaimTransaction_payerId_fkey"
  FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimTransaction"
  ADD CONSTRAINT "ClaimTransaction_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClaimTransaction"
  ADD CONSTRAINT "ClaimTransaction_originalTransactionId_fkey"
  FOREIGN KEY ("originalTransactionId") REFERENCES "ClaimTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionLabel"
  ADD CONSTRAINT "PrescriptionLabel_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionLabel"
  ADD CONSTRAINT "PrescriptionLabel_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionLabel"
  ADD CONSTRAINT "PrescriptionLabel_claimTransactionId_fkey"
  FOREIGN KEY ("claimTransactionId") REFERENCES "ClaimTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LabelPrintJob"
  ADD CONSTRAINT "LabelPrintJob_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabelPrintJob"
  ADD CONSTRAINT "LabelPrintJob_labelId_fkey"
  FOREIGN KEY ("labelId") REFERENCES "PrescriptionLabel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LabelPrintJob"
  ADD CONSTRAINT "LabelPrintJob_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
