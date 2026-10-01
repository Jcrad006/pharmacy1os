-- Pre-3J architecture consolidation:
-- separate logical/payer quantities from physical dispensing and preserve
-- completion lineage for claim/label workflows.

CREATE TYPE "FillBillingRole" AS ENUM (
  'PRIMARY_CLAIM',
  'COMPLETION_OF_PRIMARY',
  'EMERGENCY_SUPPLY'
);

CREATE TYPE "FillInterruptionReason" AS ENUM (
  'INSUFFICIENT_PHYSICAL_STOCK',
  'DAMAGED_PRODUCT',
  'EXPIRED_PRODUCT',
  'STOCK_DISCREPANCY',
  'OTHER'
);

ALTER TABLE "PrescriptionFill"
  ADD COLUMN "intendedQuantity" DECIMAL(10,3),
  ADD COLUMN "payerIntendedQuantity" DECIMAL(10,3),
  ADD COLUMN "physicalDispensedQuantity" DECIMAL(10,3) NOT NULL DEFAULT 0,
  ADD COLUMN "remainingOwedQuantity" DECIMAL(10,3) NOT NULL DEFAULT 0,
  ADD COLUMN "billingRole" "FillBillingRole" NOT NULL DEFAULT 'PRIMARY_CLAIM',
  ADD COLUMN "billingAnchorFillId" TEXT,
  ADD COLUMN "interruptionReason" "FillInterruptionReason",
  ADD COLUMN "interruptionNote" TEXT,
  ADD COLUMN "interruptedAt" TIMESTAMP(3),
  ADD COLUMN "interruptedById" TEXT;

UPDATE "PrescriptionFill"
SET
  "intendedQuantity" = COALESCE("authorizedQuantity", "quantity"),
  "payerIntendedQuantity" = COALESCE("authorizedQuantity", "quantity"),
  "billingRole" = CASE
    WHEN "kind" = 'COMPLETION' THEN 'COMPLETION_OF_PRIMARY'::"FillBillingRole"
    WHEN "kind" = 'EMERGENCY_SUPPLY' THEN 'EMERGENCY_SUPPLY'::"FillBillingRole"
    ELSE 'PRIMARY_CLAIM'::"FillBillingRole"
  END,
  "billingAnchorFillId" = CASE
    WHEN "kind" = 'COMPLETION' THEN "completionOfFillId"
    ELSE NULL
  END,
  "physicalDispensedQuantity" = CASE
    WHEN "status" = 'SOLD' THEN COALESCE("quantity", 0)
    ELSE 0
  END;

UPDATE "PrescriptionFill" root
SET "remainingOwedQuantity" = GREATEST(
  COALESCE(root."intendedQuantity", 0) -
  COALESCE((
    SELECT SUM(COALESCE(part."quantity", 0))
    FROM "PrescriptionFill" part
    WHERE part."prescriptionId" = root."prescriptionId"
      AND part."fillNumber" = root."fillNumber"
      AND part."status" = 'SOLD'
  ), 0),
  0
)
WHERE root."kind" = 'PARTIAL'
  AND root."billingAnchorFillId" IS NULL;

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_billingAnchorFillId_fkey"
  FOREIGN KEY ("billingAnchorFillId")
  REFERENCES "PrescriptionFill"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_interruptedById_fkey"
  FOREIGN KEY ("interruptedById")
  REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_physicalDispensed_nonnegative"
  CHECK ("physicalDispensedQuantity" >= 0);

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_remainingOwed_nonnegative"
  CHECK ("remainingOwedQuantity" >= 0);

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_intended_positive"
  CHECK ("intendedQuantity" IS NULL OR "intendedQuantity" > 0);

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_payerIntended_positive"
  CHECK ("payerIntendedQuantity" IS NULL OR "payerIntendedQuantity" > 0);

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_part_not_greater_than_intended"
  CHECK (
    "quantity" IS NULL
    OR "intendedQuantity" IS NULL
    OR "quantity" <= "intendedQuantity"
  );

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_physical_not_greater_than_part"
  CHECK (
    "quantity" IS NULL
    OR "physicalDispensedQuantity" <= "quantity"
  );

CREATE INDEX "PrescriptionFill_billingAnchorFillId_idx"
  ON "PrescriptionFill"("billingAnchorFillId");

CREATE INDEX "PrescriptionFill_billingRole_status_idx"
  ON "PrescriptionFill"("billingRole", "status");

CREATE INDEX "PrescriptionFill_interruptedAt_idx"
  ON "PrescriptionFill"("interruptedAt");
