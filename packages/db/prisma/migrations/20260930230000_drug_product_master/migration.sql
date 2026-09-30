CREATE TABLE "Medication" (
  "id" TEXT NOT NULL,
  "genericName" TEXT NOT NULL,
  "brandName" TEXT,
  "strength" TEXT NOT NULL,
  "dosageForm" TEXT NOT NULL,
  "route" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Medication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Manufacturer" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "labelerCode" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Manufacturer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Product" (
  "id" TEXT NOT NULL,
  "medicationId" TEXT NOT NULL,
  "manufacturerId" TEXT NOT NULL,
  "ndc" TEXT NOT NULL,
  "ndcSearch" TEXT NOT NULL,
  "labelName" TEXT,
  "packageDescription" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductLot" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "lotNumber" TEXT NOT NULL,
  "lotNumberSearch" TEXT NOT NULL,
  "expirationDate" TIMESTAMP(3) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "receivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductLot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Manufacturer_name_key" ON "Manufacturer"("name");
CREATE UNIQUE INDEX "Product_ndcSearch_key" ON "Product"("ndcSearch");
CREATE UNIQUE INDEX "ProductLot_siteId_productId_lotNumberSearch_expirationDate_key"
ON "ProductLot"("siteId", "productId", "lotNumberSearch", "expirationDate");

CREATE INDEX "Medication_genericName_strength_dosageForm_idx"
ON "Medication"("genericName", "strength", "dosageForm");
CREATE INDEX "Medication_brandName_idx" ON "Medication"("brandName");
CREATE INDEX "Manufacturer_name_idx" ON "Manufacturer"("name");
CREATE INDEX "Product_medicationId_active_idx" ON "Product"("medicationId", "active");
CREATE INDEX "Product_manufacturerId_active_idx" ON "Product"("manufacturerId", "active");
CREATE INDEX "Product_ndc_idx" ON "Product"("ndc");
CREATE INDEX "ProductLot_siteId_expirationDate_idx" ON "ProductLot"("siteId", "expirationDate");
CREATE INDEX "ProductLot_productId_expirationDate_idx" ON "ProductLot"("productId", "expirationDate");
CREATE INDEX "ProductLot_lotNumberSearch_idx" ON "ProductLot"("lotNumberSearch");

ALTER TABLE "Product"
ADD CONSTRAINT "Product_medicationId_fkey"
FOREIGN KEY ("medicationId") REFERENCES "Medication"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Product"
ADD CONSTRAINT "Product_manufacturerId_fkey"
FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProductLot"
ADD CONSTRAINT "ProductLot_siteId_fkey"
FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProductLot"
ADD CONSTRAINT "ProductLot_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
