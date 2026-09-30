CREATE TYPE "PrescriberIdentifierType" AS ENUM ('NPI', 'DEA', 'STATE_ID');
CREATE TYPE "PrescriberContactType" AS ENUM ('PHONE', 'FAX');

ALTER TABLE "Prescriber"
ADD COLUMN "practiceLevel" TEXT NOT NULL DEFAULT 'UNKNOWN';

CREATE TABLE "PrescriberIdentifier" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "prescriberId" TEXT NOT NULL,
  "type" "PrescriberIdentifierType" NOT NULL,
  "number" TEXT NOT NULL,
  "numberSearch" TEXT NOT NULL,
  "jurisdiction" TEXT NOT NULL DEFAULT '',
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrescriberIdentifier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrescriberContact" (
  "id" TEXT NOT NULL,
  "prescriberId" TEXT NOT NULL,
  "type" "PrescriberContactType" NOT NULL,
  "label" TEXT,
  "value" TEXT NOT NULL,
  "valueSearch" TEXT NOT NULL,
  "extension" TEXT,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrescriberContact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrescriberAddress" (
  "id" TEXT NOT NULL,
  "prescriberId" TEXT NOT NULL,
  "label" TEXT,
  "addressLine1" TEXT NOT NULL,
  "addressLine2" TEXT,
  "city" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "postalCode" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrescriberAddress_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PrescriberIdentifier"
ADD CONSTRAINT "PrescriberIdentifier_prescriberId_fkey"
FOREIGN KEY ("prescriberId") REFERENCES "Prescriber"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrescriberContact"
ADD CONSTRAINT "PrescriberContact_prescriberId_fkey"
FOREIGN KEY ("prescriberId") REFERENCES "Prescriber"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrescriberAddress"
ADD CONSTRAINT "PrescriberAddress_prescriberId_fkey"
FOREIGN KEY ("prescriberId") REFERENCES "Prescriber"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "PrescriberIdentifier"
("id", "siteId", "prescriberId", "type", "number", "numberSearch", "jurisdiction", "isPrimary")
SELECT
  'legacy-npi-' || "id",
  "siteId",
  "id",
  'NPI'::"PrescriberIdentifierType",
  "npi",
  regexp_replace(upper("npi"), '[^A-Z0-9]', '', 'g'),
  '',
  true
FROM "Prescriber"
WHERE "npi" IS NOT NULL AND btrim("npi") <> '';

INSERT INTO "PrescriberIdentifier"
("id", "siteId", "prescriberId", "type", "number", "numberSearch", "jurisdiction", "isPrimary")
SELECT
  'legacy-dea-' || "id",
  "siteId",
  "id",
  'DEA'::"PrescriberIdentifierType",
  "deaNumber",
  regexp_replace(upper("deaNumber"), '[^A-Z0-9]', '', 'g'),
  '',
  true
FROM "Prescriber"
WHERE "deaNumber" IS NOT NULL AND btrim("deaNumber") <> '';

INSERT INTO "PrescriberContact"
("id", "prescriberId", "type", "label", "value", "valueSearch", "isPrimary")
SELECT
  'legacy-phone-' || "id",
  "id",
  'PHONE'::"PrescriberContactType",
  'Main',
  "phone",
  regexp_replace("phone", '[^0-9]', '', 'g'),
  true
FROM "Prescriber"
WHERE "phone" IS NOT NULL AND btrim("phone") <> '';

INSERT INTO "PrescriberContact"
("id", "prescriberId", "type", "label", "value", "valueSearch", "isPrimary")
SELECT
  'legacy-fax-' || "id",
  "id",
  'FAX'::"PrescriberContactType",
  'Main',
  "fax",
  regexp_replace("fax", '[^0-9]', '', 'g'),
  true
FROM "Prescriber"
WHERE "fax" IS NOT NULL AND btrim("fax") <> '';

DROP INDEX IF EXISTS "Prescriber_siteId_npi_key";
DROP INDEX IF EXISTS "Prescriber_siteId_phoneSearch_idx";

ALTER TABLE "Prescriber"
DROP COLUMN "npi",
DROP COLUMN "deaNumber",
DROP COLUMN "phone",
DROP COLUMN "phoneSearch",
DROP COLUMN "fax";

CREATE UNIQUE INDEX "PrescriberIdentifier_prescriberId_type_numberSearch_jurisdiction_key"
ON "PrescriberIdentifier"("prescriberId", "type", "numberSearch", "jurisdiction");

CREATE INDEX "PrescriberIdentifier_siteId_type_numberSearch_idx"
ON "PrescriberIdentifier"("siteId", "type", "numberSearch");

CREATE INDEX "PrescriberIdentifier_prescriberId_type_isPrimary_idx"
ON "PrescriberIdentifier"("prescriberId", "type", "isPrimary");

CREATE INDEX "PrescriberContact_prescriberId_type_isPrimary_idx"
ON "PrescriberContact"("prescriberId", "type", "isPrimary");

CREATE INDEX "PrescriberContact_type_valueSearch_idx"
ON "PrescriberContact"("type", "valueSearch");

CREATE INDEX "PrescriberAddress_prescriberId_isPrimary_idx"
ON "PrescriberAddress"("prescriberId", "isPrimary");

CREATE INDEX "PrescriberAddress_state_postalCode_idx"
ON "PrescriberAddress"("state", "postalCode");

CREATE INDEX "Prescriber_siteId_practiceLevel_idx"
ON "Prescriber"("siteId", "practiceLevel");
