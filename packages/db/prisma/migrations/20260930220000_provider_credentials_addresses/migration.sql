ALTER TABLE "Prescriber"
ADD COLUMN "stateProviderId" TEXT,
ADD COLUMN "stateProviderIdState" TEXT;

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
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrescriberAddress_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PrescriberAddress"
ADD CONSTRAINT "PrescriberAddress_prescriberId_fkey"
FOREIGN KEY ("prescriberId") REFERENCES "Prescriber"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Prescriber_siteId_deaNumber_idx"
ON "Prescriber"("siteId", "deaNumber");

CREATE INDEX "Prescriber_siteId_stateProviderId_idx"
ON "Prescriber"("siteId", "stateProviderId");

CREATE INDEX "PrescriberAddress_prescriberId_isPrimary_idx"
ON "PrescriberAddress"("prescriberId", "isPrimary");

CREATE INDEX "PrescriberAddress_state_postalCode_idx"
ON "PrescriberAddress"("state", "postalCode");
