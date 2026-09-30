CREATE TYPE "ProductUnit" AS ENUM ('EACH', 'GRAM', 'MILLILITER');

ALTER TABLE "Product"
RENAME COLUMN "labelName" TO "descriptor";

ALTER TABLE "Product"
ADD COLUMN "packageType" TEXT,
ADD COLUMN "unitsPerPackage" DECIMAL(12,3),
ADD COLUMN "dispensingUnit" "ProductUnit",
ADD COLUMN "unitPrice" DECIMAL(12,6),
ADD COLUMN "packagePrice" DECIMAL(12,4);

UPDATE "Product" p
SET "descriptor" = CONCAT(
  m."genericName",
  ' ',
  m."strength",
  ' ',
  m."dosageForm",
  ' — NDC ',
  p."ndc"
)
FROM "Medication" m
WHERE p."medicationId" = m."id"
  AND (p."descriptor" IS NULL OR btrim(p."descriptor") = '');

ALTER TABLE "Product"
ALTER COLUMN "descriptor" SET NOT NULL;

CREATE INDEX "Product_descriptor_idx"
ON "Product"("descriptor");
