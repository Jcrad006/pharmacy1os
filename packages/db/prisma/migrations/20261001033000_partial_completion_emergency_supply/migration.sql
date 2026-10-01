-- Phase 3I: partial/completion fills and pharmacist-authorized emergency supply

CREATE TYPE "FillKind" AS ENUM ('STANDARD', 'PARTIAL', 'COMPLETION', 'EMERGENCY_SUPPLY');

ALTER TABLE "PrescriptionFill"
  ADD COLUMN "partNumber" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "kind" "FillKind" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "authorizedQuantity" DECIMAL(10,3),
  ADD COLUMN "consumesRefill" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "completionOfFillId" TEXT,
  ADD COLUMN "emergencyReason" TEXT,
  ADD COLUMN "emergencyAuthorizedById" TEXT,
  ADD COLUMN "emergencyAuthorizedAt" TIMESTAMP(3),
  ADD COLUMN "followUpDueAt" TIMESTAMP(3),
  ADD COLUMN "followUpCompletedAt" TIMESTAMP(3),
  ADD COLUMN "followUpNote" TEXT;

DROP INDEX "PrescriptionFill_prescriptionId_fillNumber_key";

CREATE UNIQUE INDEX "PrescriptionFill_prescriptionId_fillNumber_partNumber_key"
  ON "PrescriptionFill"("prescriptionId", "fillNumber", "partNumber");

CREATE INDEX "PrescriptionFill_completionOfFillId_idx"
  ON "PrescriptionFill"("completionOfFillId");

CREATE INDEX "PrescriptionFill_kind_status_scheduledFor_idx"
  ON "PrescriptionFill"("kind", "status", "scheduledFor");

CREATE INDEX "PrescriptionFill_followUpDueAt_followUpCompletedAt_idx"
  ON "PrescriptionFill"("followUpDueAt", "followUpCompletedAt");

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_completionOfFillId_fkey"
  FOREIGN KEY ("completionOfFillId") REFERENCES "PrescriptionFill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_emergencyAuthorizedById_fkey"
  FOREIGN KEY ("emergencyAuthorizedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_partNumber_positive"
  CHECK ("partNumber" > 0);

ALTER TABLE "PrescriptionFill"
  ADD CONSTRAINT "PrescriptionFill_emergency_metadata_consistency"
  CHECK (
    ("kind" <> 'EMERGENCY_SUPPLY')
    OR (
      "consumesRefill" = false
      AND "emergencyReason" IS NOT NULL
      AND "emergencyAuthorizedById" IS NOT NULL
      AND "emergencyAuthorizedAt" IS NOT NULL
    )
  );
