-- Pre-3J COB, split-source dispensing, and North Carolina compliance foundation.

ALTER TYPE "InventoryAllocationStatus" ADD VALUE IF NOT EXISTS 'RETURNED';

CREATE TYPE "CoverageRelationship" AS ENUM ('SELF','SPOUSE','CHILD','OTHER');
CREATE TYPE "ClaimStandard" AS ENUM ('D0','F6');
CREATE TYPE "BillingNdcStrategy" AS ENUM (
  'REQUIRE_MANUAL_SELECTION',
  'SINGLE_SOURCE_ONLY',
  'PAYER_CONFIGURED'
);
CREATE TYPE "ProductSelectionDirective" AS ENUM (
  'UNSPECIFIED',
  'SELECTION_PERMITTED',
  'DISPENSE_AS_WRITTEN'
);
CREATE TYPE "BiologicCommunicationStatus" AS ENUM ('OPEN','COMPLETED','EXEMPT');

ALTER TABLE "Medication"
  ADD COLUMN "ncNarrowTherapeuticIndex" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isBiological" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "hasFdaInterchangeableBiologicAlternative" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Product"
  ADD COLUMN "therapeuticEquivalenceCode" TEXT,
  ADD COLUMN "isInterchangeableBiological" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Prescription"
  ADD COLUMN "prescribedProductId" TEXT,
  ADD COLUMN "productSelectionDirective" "ProductSelectionDirective" NOT NULL DEFAULT 'UNSPECIFIED';

ALTER TABLE "PrescriptionFill"
  ADD COLUMN "billingProductId" TEXT,
  ADD COLUMN "patientDiscardDate" TIMESTAMP(3),
  ADD COLUMN "dispensedInOriginalContainer" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "InventoryAllocation"
  ADD COLUMN "fillProductSourceId" TEXT;

CREATE TABLE "Payer" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "bin" TEXT,
  "pcn" TEXT,
  "defaultGroupId" TEXT,
  "claimStandard" "ClaimStandard" NOT NULL DEFAULT 'D0',
  "billingNdcStrategy" "BillingNdcStrategy" NOT NULL DEFAULT 'REQUIRE_MANUAL_SELECTION',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PatientCoverage" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "payerId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "memberId" TEXT NOT NULL,
  "personCode" TEXT,
  "groupId" TEXT,
  "relationship" "CoverageRelationship" NOT NULL DEFAULT 'SELF',
  "cardholderName" TEXT,
  "cardholderDateOfBirth" TIMESTAMP(3),
  "effectiveDate" TIMESTAMP(3),
  "terminationDate" TIMESTAMP(3),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PatientCoverage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PatientCoverage_position_check" CHECK ("position" BETWEEN 1 AND 4),
  CONSTRAINT "PatientCoverage_date_check" CHECK (
    "terminationDate" IS NULL OR "effectiveDate" IS NULL OR "terminationDate" >= "effectiveDate"
  )
);

CREATE TABLE "FillProductSource" (
  "id" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "productId" TEXT NOT NULL,
  "manufacturerId" TEXT NOT NULL,
  "productLotId" TEXT NOT NULL,
  "productExpirationId" TEXT NOT NULL,
  "inventoryBalanceId" TEXT NOT NULL,
  "quantity" DECIMAL(10,3) NOT NULL,
  "ndcSnapshot" TEXT NOT NULL,
  "manufacturerSnapshot" TEXT NOT NULL,
  "lotNumberSnapshot" TEXT NOT NULL,
  "expirationSnapshot" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt" TIMESTAMP(3),
  "returnedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FillProductSource_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FillProductSource_sequence_check" CHECK ("sequence" BETWEEN 1 AND 4),
  CONSTRAINT "FillProductSource_quantity_check" CHECK ("quantity" > 0)
);

CREATE TABLE "NtiManufacturerConsent" (
  "id" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "priorManufacturerId" TEXT NOT NULL,
  "newManufacturerId" TEXT NOT NULL,
  "prescriberConsentAt" TIMESTAMP(3) NOT NULL,
  "patientConsentAt" TIMESTAMP(3) NOT NULL,
  "documentedById" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NtiManufacturerConsent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NtiManufacturerConsent_different_manufacturer_check"
    CHECK ("priorManufacturerId" <> "newManufacturerId")
);

CREATE TABLE "BiologicCommunicationTask" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "fillId" TEXT NOT NULL,
  "status" "BiologicCommunicationStatus" NOT NULL DEFAULT 'OPEN',
  "productName" TEXT NOT NULL,
  "manufacturerName" TEXT NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "completedById" TEXT,
  "completedAt" TIMESTAMP(3),
  "note" TEXT,
  "exemptReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BiologicCommunicationTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Payer_siteId_name_key" ON "Payer"("siteId","name");
CREATE INDEX "Payer_siteId_active_name_idx" ON "Payer"("siteId","active","name");
CREATE INDEX "Payer_bin_pcn_idx" ON "Payer"("bin","pcn");

CREATE UNIQUE INDEX "PatientCoverage_patientId_position_key"
  ON "PatientCoverage"("patientId","position");
CREATE INDEX "PatientCoverage_siteId_active_patientId_idx"
  ON "PatientCoverage"("siteId","active","patientId");
CREATE INDEX "PatientCoverage_payerId_active_idx"
  ON "PatientCoverage"("payerId","active");

CREATE UNIQUE INDEX "FillProductSource_fillId_sequence_key"
  ON "FillProductSource"("fillId","sequence");
CREATE UNIQUE INDEX "FillProductSource_fillId_inventoryBalanceId_key"
  ON "FillProductSource"("fillId","inventoryBalanceId");
CREATE INDEX "FillProductSource_fillId_committedAt_returnedAt_idx"
  ON "FillProductSource"("fillId","committedAt","returnedAt");
CREATE INDEX "FillProductSource_productId_idx" ON "FillProductSource"("productId");
CREATE INDEX "FillProductSource_manufacturerId_idx" ON "FillProductSource"("manufacturerId");

CREATE UNIQUE INDEX "NtiManufacturerConsent_fillId_priorManufacturerId_newManufacturerId_key"
  ON "NtiManufacturerConsent"("fillId","priorManufacturerId","newManufacturerId");
CREATE INDEX "NtiManufacturerConsent_fillId_createdAt_idx"
  ON "NtiManufacturerConsent"("fillId","createdAt");

CREATE UNIQUE INDEX "BiologicCommunicationTask_fillId_key"
  ON "BiologicCommunicationTask"("fillId");
CREATE INDEX "BiologicCommunicationTask_siteId_status_dueAt_idx"
  ON "BiologicCommunicationTask"("siteId","status","dueAt");

CREATE INDEX "Prescription_prescribedProductId_idx"
  ON "Prescription"("prescribedProductId");
CREATE INDEX "PrescriptionFill_billingProductId_idx"
  ON "PrescriptionFill"("billingProductId");
CREATE INDEX "InventoryAllocation_fillProductSourceId_status_idx"
  ON "InventoryAllocation"("fillProductSourceId","status");

ALTER TABLE "Payer"
  ADD CONSTRAINT "Payer_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PatientCoverage"
  ADD CONSTRAINT "PatientCoverage_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PatientCoverage"
  ADD CONSTRAINT "PatientCoverage_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientCoverage"
  ADD CONSTRAINT "PatientCoverage_payerId_fkey"
  FOREIGN KEY ("payerId") REFERENCES "Payer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Prescription"
  ADD CONSTRAINT "Prescription_prescribedProductId_fkey"
  FOREIGN KEY ("prescribedProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_billingProductId_fkey"
  FOREIGN KEY ("billingProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FillProductSource"
  ADD CONSTRAINT "FillProductSource_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FillProductSource"
  ADD CONSTRAINT "FillProductSource_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FillProductSource"
  ADD CONSTRAINT "FillProductSource_manufacturerId_fkey"
  FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FillProductSource"
  ADD CONSTRAINT "FillProductSource_productLotId_fkey"
  FOREIGN KEY ("productLotId") REFERENCES "ProductLot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FillProductSource"
  ADD CONSTRAINT "FillProductSource_productExpirationId_fkey"
  FOREIGN KEY ("productExpirationId") REFERENCES "ProductExpiration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FillProductSource"
  ADD CONSTRAINT "FillProductSource_inventoryBalanceId_fkey"
  FOREIGN KEY ("inventoryBalanceId") REFERENCES "InventoryBalance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryAllocation"
  ADD CONSTRAINT "InventoryAllocation_fillProductSourceId_fkey"
  FOREIGN KEY ("fillProductSourceId") REFERENCES "FillProductSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "NtiManufacturerConsent"
  ADD CONSTRAINT "NtiManufacturerConsent_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NtiManufacturerConsent"
  ADD CONSTRAINT "NtiManufacturerConsent_priorManufacturerId_fkey"
  FOREIGN KEY ("priorManufacturerId") REFERENCES "Manufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NtiManufacturerConsent"
  ADD CONSTRAINT "NtiManufacturerConsent_newManufacturerId_fkey"
  FOREIGN KEY ("newManufacturerId") REFERENCES "Manufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NtiManufacturerConsent"
  ADD CONSTRAINT "NtiManufacturerConsent_documentedById_fkey"
  FOREIGN KEY ("documentedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BiologicCommunicationTask"
  ADD CONSTRAINT "BiologicCommunicationTask_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BiologicCommunicationTask"
  ADD CONSTRAINT "BiologicCommunicationTask_fillId_fkey"
  FOREIGN KEY ("fillId") REFERENCES "PrescriptionFill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BiologicCommunicationTask"
  ADD CONSTRAINT "BiologicCommunicationTask_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill existing single-source fills into the new source model.
INSERT INTO "FillProductSource" (
  "id","fillId","sequence","productId","manufacturerId",
  "productLotId","productExpirationId","inventoryBalanceId","quantity",
  "ndcSnapshot","manufacturerSnapshot","lotNumberSnapshot","expirationSnapshot",
  "verifiedAt","committedAt","returnedAt"
)
SELECT
  'source-backfill-' || f."id",
  f."id",
  1,
  f."productId",
  p."manufacturerId",
  f."productLotId",
  f."productExpirationId",
  f."inventoryBalanceId",
  f."quantity",
  COALESCE(f."scannedNdc", p."ndc"),
  m."name",
  COALESCE(f."scannedLotNumber", l."lotNumber"),
  COALESCE(f."scannedExpiration", e."expirationDate"),
  COALESCE(f."productVerifiedAt", f."updatedAt"),
  f."inventoryCommittedAt",
  f."inventoryReturnedAt"
FROM "PrescriptionFill" f
JOIN "Product" p ON p."id" = f."productId"
JOIN "Manufacturer" m ON m."id" = p."manufacturerId"
JOIN "ProductLot" l ON l."id" = f."productLotId"
JOIN "ProductExpiration" e ON e."id" = f."productExpirationId"
WHERE f."productId" IS NOT NULL
  AND f."productLotId" IS NOT NULL
  AND f."productExpirationId" IS NOT NULL
  AND f."inventoryBalanceId" IS NOT NULL
  AND f."quantity" IS NOT NULL;

UPDATE "InventoryAllocation" a
SET "fillProductSourceId" = s."id"
FROM "FillProductSource" s
WHERE s."fillId" = a."fillId"
  AND s."inventoryBalanceId" = a."inventoryBalanceId";

-- Preserve the current single-source product as the billing candidate.
UPDATE "PrescriptionFill"
SET "billingProductId" = "productId"
WHERE "productId" IS NOT NULL
  AND "billingProductId" IS NULL;
