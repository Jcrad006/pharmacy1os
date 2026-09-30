ALTER TABLE "Patient"
ADD COLUMN "phoneSearch" TEXT;

ALTER TABLE "Prescriber"
ADD COLUMN "dateOfBirth" TIMESTAMP(3),
ADD COLUMN "phoneSearch" TEXT;

UPDATE "Patient"
SET "phoneSearch" = regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g')
WHERE "phone" IS NOT NULL;

UPDATE "Prescriber"
SET "phoneSearch" = regexp_replace(COALESCE("phone", ''), '[^0-9]', '', 'g')
WHERE "phone" IS NOT NULL;

CREATE INDEX "Patient_siteId_dateOfBirth_idx" ON "Patient"("siteId", "dateOfBirth");
CREATE INDEX "Patient_siteId_phoneSearch_idx" ON "Patient"("siteId", "phoneSearch");
CREATE INDEX "Prescriber_siteId_dateOfBirth_idx" ON "Prescriber"("siteId", "dateOfBirth");
CREATE INDEX "Prescriber_siteId_phoneSearch_idx" ON "Prescriber"("siteId", "phoneSearch");
