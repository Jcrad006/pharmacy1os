CREATE TYPE "ProductBarcodeType" AS ENUM ('GTIN_14', 'UPC_A', 'EAN_13', 'OTHER');

CREATE TABLE "ProductBarcode" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "type" "ProductBarcodeType" NOT NULL,
  "identifier" TEXT NOT NULL,
  "identifierSearch" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductBarcode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductBarcode_type_identifierSearch_key"
ON "ProductBarcode"("type", "identifierSearch");

CREATE INDEX "ProductBarcode_productId_isPrimary_idx"
ON "ProductBarcode"("productId", "isPrimary");

CREATE INDEX "ProductBarcode_identifierSearch_idx"
ON "ProductBarcode"("identifierSearch");

ALTER TABLE "ProductBarcode"
ADD CONSTRAINT "ProductBarcode_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
