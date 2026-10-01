CREATE TYPE "WillCallBagBarcodeStatus" AS ENUM ('ACTIVE', 'VOIDED');
CREATE TYPE "WillCallEventType" AS ENUM ('STAGED', 'RELOCATED', 'REBAGGED', 'PICKED_UP', 'RETURNED_TO_STOCK');

CREATE TABLE "WillCallBagBarcode" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "barcode" TEXT NOT NULL,
  "status" "WillCallBagBarcodeStatus" NOT NULL DEFAULT 'ACTIVE',
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt" TIMESTAMP(3),
  CONSTRAINT "WillCallBagBarcode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WillCallEvent" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "packageId" TEXT NOT NULL,
  "eventType" "WillCallEventType" NOT NULL,
  "actorId" TEXT NOT NULL,
  "oldBagBarcode" TEXT,
  "newBagBarcode" TEXT,
  "fromLocationId" TEXT,
  "toLocationId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WillCallEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WillCallBagBarcode_barcode_key"
  ON "WillCallBagBarcode"("barcode");
CREATE INDEX "WillCallBagBarcode_siteId_status_assignedAt_idx"
  ON "WillCallBagBarcode"("siteId", "status", "assignedAt");
CREATE INDEX "WillCallBagBarcode_packageId_status_idx"
  ON "WillCallBagBarcode"("packageId", "status");

CREATE INDEX "WillCallEvent_siteId_occurredAt_idx"
  ON "WillCallEvent"("siteId", "occurredAt");
CREATE INDEX "WillCallEvent_packageId_occurredAt_idx"
  ON "WillCallEvent"("packageId", "occurredAt");
CREATE INDEX "WillCallEvent_oldBagBarcode_idx"
  ON "WillCallEvent"("oldBagBarcode");
CREATE INDEX "WillCallEvent_newBagBarcode_idx"
  ON "WillCallEvent"("newBagBarcode");

ALTER TABLE "WillCallBagBarcode"
  ADD CONSTRAINT "WillCallBagBarcode_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WillCallBagBarcode"
  ADD CONSTRAINT "WillCallBagBarcode_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "WillCallPackage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WillCallEvent"
  ADD CONSTRAINT "WillCallEvent_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WillCallEvent"
  ADD CONSTRAINT "WillCallEvent_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "WillCallPackage"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WillCallEvent"
  ADD CONSTRAINT "WillCallEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WillCallEvent"
  ADD CONSTRAINT "WillCallEvent_fromLocationId_fkey"
  FOREIGN KEY ("fromLocationId") REFERENCES "InventoryLocation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WillCallEvent"
  ADD CONSTRAINT "WillCallEvent_toLocationId_fkey"
  FOREIGN KEY ("toLocationId") REFERENCES "InventoryLocation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "WillCallBagBarcode" (
  "id", "siteId", "packageId", "barcode", "status", "assignedAt", "voidedAt"
)
SELECT
  'wc-barcode-' || p."id",
  p."siteId",
  p."id",
  p."bagBarcode",
  CASE
    WHEN p."status" = 'STAGED' THEN 'ACTIVE'::"WillCallBagBarcodeStatus"
    ELSE 'VOIDED'::"WillCallBagBarcodeStatus"
  END,
  p."stagedAt",
  CASE WHEN p."status" = 'STAGED' THEN NULL ELSE COALESCE(p."pickedUpAt", p."returnedAt", p."updatedAt") END
FROM "WillCallPackage" p;

INSERT INTO "WillCallEvent" (
  "id", "siteId", "packageId", "eventType", "actorId",
  "newBagBarcode", "toLocationId", "occurredAt"
)
SELECT
  'wc-event-stage-' || p."id",
  p."siteId",
  p."id",
  'STAGED'::"WillCallEventType",
  p."stagedById",
  p."bagBarcode",
  p."locationId",
  p."stagedAt"
FROM "WillCallPackage" p;

INSERT INTO "WillCallEvent" (
  "id", "siteId", "packageId", "eventType", "actorId",
  "oldBagBarcode", "fromLocationId", "occurredAt"
)
SELECT
  'wc-event-close-' || p."id",
  p."siteId",
  p."id",
  CASE
    WHEN p."status" = 'PICKED_UP' THEN 'PICKED_UP'::"WillCallEventType"
    ELSE 'RETURNED_TO_STOCK'::"WillCallEventType"
  END,
  p."stagedById",
  p."bagBarcode",
  p."locationId",
  COALESCE(p."pickedUpAt", p."returnedAt", p."updatedAt")
FROM "WillCallPackage" p
WHERE p."status" <> 'STAGED';
