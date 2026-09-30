CREATE TABLE "ProductExpiration" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "expirationDate" TIMESTAMP(3) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductExpiration_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ProductExpiration"
("id", "siteId", "productId", "expirationDate", "active", "createdAt", "updatedAt")
SELECT
  md5("siteId" || ':' || "productId" || ':' || "expirationDate"::text),
  "siteId",
  "productId",
  "expirationDate",
  bool_or("active"),
  min("createdAt"),
  max("updatedAt")
FROM "ProductLot"
GROUP BY "siteId", "productId", "expirationDate";

ALTER TABLE "ProductExpiration"
ADD CONSTRAINT "ProductExpiration_siteId_fkey"
FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProductExpiration"
ADD CONSTRAINT "ProductExpiration_productId_fkey"
FOREIGN KEY ("productId") REFERENCES "Product"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ProductExpiration_siteId_productId_expirationDate_key"
ON "ProductExpiration"("siteId", "productId", "expirationDate");

CREATE INDEX "ProductExpiration_siteId_expirationDate_idx"
ON "ProductExpiration"("siteId", "expirationDate");

CREATE INDEX "ProductExpiration_productId_expirationDate_idx"
ON "ProductExpiration"("productId", "expirationDate");

DROP INDEX IF EXISTS "ProductLot_siteId_productId_lotNumberSearch_expirationDate_key";
DROP INDEX IF EXISTS "ProductLot_siteId_expirationDate_idx";
DROP INDEX IF EXISTS "ProductLot_productId_expirationDate_idx";

DELETE FROM "ProductLot" a
USING "ProductLot" b
WHERE a."siteId" = b."siteId"
  AND a."productId" = b."productId"
  AND a."lotNumberSearch" = b."lotNumberSearch"
  AND a."id" > b."id";

ALTER TABLE "ProductLot"
DROP COLUMN "expirationDate";

CREATE UNIQUE INDEX "ProductLot_siteId_productId_lotNumberSearch_key"
ON "ProductLot"("siteId", "productId", "lotNumberSearch");

CREATE INDEX "ProductLot_productId_lotNumberSearch_idx"
ON "ProductLot"("productId", "lotNumberSearch");

CREATE INDEX "ProductLot_siteId_active_idx"
ON "ProductLot"("siteId", "active");
