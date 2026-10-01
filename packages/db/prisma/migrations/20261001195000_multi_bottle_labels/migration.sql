ALTER TABLE "PrescriptionLabel"
  ADD COLUMN "containerQuantity" DECIMAL(10,3),
  ADD COLUMN "bottleNumber" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "bottleCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "physicalProductIdSnapshot" TEXT,
  ADD COLUMN "physicalNdcSnapshot" TEXT,
  ADD COLUMN "manufacturerSnapshot" TEXT,
  ADD COLUMN "productDescriptionSnapshot" TEXT;

UPDATE "PrescriptionLabel"
SET "containerQuantity" = "physicalQuantity"
WHERE "containerQuantity" IS NULL;

ALTER TABLE "PrescriptionLabel"
  ALTER COLUMN "containerQuantity" SET NOT NULL;

ALTER TABLE "PrescriptionLabel"
  DROP CONSTRAINT IF EXISTS "PrescriptionLabel_fillId_version_key";

CREATE UNIQUE INDEX "PrescriptionLabel_fillId_version_bottleNumber_key"
  ON "PrescriptionLabel"("fillId", "version", "bottleNumber");

ALTER TABLE "PrescriptionLabel"
  ADD CONSTRAINT "PrescriptionLabel_bottleNumber_check"
  CHECK ("bottleNumber" > 0);

ALTER TABLE "PrescriptionLabel"
  ADD CONSTRAINT "PrescriptionLabel_bottleCount_check"
  CHECK ("bottleCount" > 0 AND "bottleNumber" <= "bottleCount");

ALTER TABLE "PrescriptionLabel"
  ADD CONSTRAINT "PrescriptionLabel_containerQuantity_check"
  CHECK ("containerQuantity" > 0);
