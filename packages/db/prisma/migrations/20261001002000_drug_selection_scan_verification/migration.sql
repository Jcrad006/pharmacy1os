ALTER TABLE "Prescription"
ADD COLUMN "medicationId" TEXT;

ALTER TABLE "PrescriptionFill"
ADD COLUMN "productId" TEXT,
ADD COLUMN "productLotId" TEXT,
ADD COLUMN "productExpirationId" TEXT,
ADD COLUMN "scannedNdc" TEXT,
ADD COLUMN "scannedLotNumber" TEXT,
ADD COLUMN "scannedExpiration" TIMESTAMP(3),
ADD COLUMN "productVerifiedAt" TIMESTAMP(3);

UPDATE "Prescription" p
SET "medicationId" = m."id"
FROM "Medication" m
WHERE lower(btrim(p."medicationName")) = lower(btrim(m."genericName"))
  AND (
    p."strength" IS NULL
    OR lower(btrim(p."strength")) = lower(btrim(m."strength"))
  )
  AND (
    p."dosageForm" IS NULL
    OR lower(btrim(p."dosageForm")) = lower(btrim(m."dosageForm"))
  );

ALTER TABLE "Prescription"
ADD CONSTRAINT "Prescription_medicationId_fkey"
FOREIGN KEY ("medicationId") REFERENCES "Medication"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionFill"
ADD CONSTRAINT "PrescriptionFill_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionFill"
ADD CONSTRAINT "PrescriptionFill_productLotId_fkey"
FOREIGN KEY ("productLotId") REFERENCES "ProductLot"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionFill"
ADD CONSTRAINT "PrescriptionFill_productExpirationId_fkey"
FOREIGN KEY ("productExpirationId") REFERENCES "ProductExpiration"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Prescription_medicationId_idx"
ON "Prescription"("medicationId");

CREATE INDEX "PrescriptionFill_productId_idx"
ON "PrescriptionFill"("productId");

CREATE INDEX "PrescriptionFill_productLotId_idx"
ON "PrescriptionFill"("productLotId");

CREATE INDEX "PrescriptionFill_productExpirationId_idx"
ON "PrescriptionFill"("productExpirationId");
