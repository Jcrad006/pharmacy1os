ALTER TABLE "DurIssue"
ADD COLUMN "eligibleAt" TIMESTAMP(3),
ADD COLUMN "resolutionNote" TEXT,
ADD COLUMN "resolvedAutomatically" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "DurIssue_prescriptionId_source_status_idx"
ON "DurIssue"("prescriptionId", "source", "status");

CREATE INDEX "DurIssue_eligibleAt_status_idx"
ON "DurIssue"("eligibleAt", "status");
