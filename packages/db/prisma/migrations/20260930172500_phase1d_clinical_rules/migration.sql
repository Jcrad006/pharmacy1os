CREATE TYPE "DurSeverity" AS ENUM ('INFO', 'WARNING', 'HIGH');
CREATE TYPE "DurIssueStatus" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "Prescription"
ADD COLUMN "minimumDaysBetweenFills" INTEGER;

CREATE TABLE "DurIssue" (
  "id" TEXT NOT NULL,
  "prescriptionId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "severity" "DurSeverity" NOT NULL DEFAULT 'WARNING',
  "status" "DurIssueStatus" NOT NULL DEFAULT 'OPEN',
  "source" TEXT NOT NULL DEFAULT 'SYNTHETIC_RULE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedById" TEXT,
  CONSTRAINT "DurIssue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InterventionNote" (
  "id" TEXT NOT NULL,
  "prescriptionId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InterventionNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DurIssue_prescriptionId_status_idx" ON "DurIssue"("prescriptionId", "status");
CREATE INDEX "DurIssue_code_status_idx" ON "DurIssue"("code", "status");
CREATE INDEX "InterventionNote_prescriptionId_createdAt_idx" ON "InterventionNote"("prescriptionId", "createdAt");

ALTER TABLE "DurIssue"
ADD CONSTRAINT "DurIssue_prescriptionId_fkey"
FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DurIssue"
ADD CONSTRAINT "DurIssue_resolvedById_fkey"
FOREIGN KEY ("resolvedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InterventionNote"
ADD CONSTRAINT "InterventionNote_prescriptionId_fkey"
FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InterventionNote"
ADD CONSTRAINT "InterventionNote_authorId_fkey"
FOREIGN KEY ("authorId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
