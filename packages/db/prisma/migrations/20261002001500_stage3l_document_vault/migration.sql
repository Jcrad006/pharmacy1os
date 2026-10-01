CREATE TYPE "PrescriptionSourceType" AS ENUM ('MANUAL', 'PAPER', 'FAX', 'ELECTRONIC', 'VERBAL', 'TRANSFER');
CREATE TYPE "DocumentSourceType" AS ENUM ('SCAN', 'UPLOAD', 'ELECTRONIC_RENDER');
CREATE TYPE "DocumentKind" AS ENUM ('PRESCRIPTION_SOURCE', 'INSURANCE_CARD', 'PRESCRIBER_COMMUNICATION', 'PRIOR_AUTHORIZATION', 'OTHER');
CREATE TYPE "PrescriptionAnnotationStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');
CREATE TYPE "PrescriptionChangeRecordStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');
CREATE TYPE "PrescriptionChangeType" AS ENUM ('SIG', 'QUANTITY', 'REFILLS', 'DRUG', 'STRENGTH', 'DOSAGE_FORM', 'DAW', 'PRESCRIBER', 'WRITTEN_DATE', 'OTHER');
CREATE TYPE "PrescriptionChangeCommunicationMethod" AS ENUM ('PHONE', 'FAX', 'ELECTRONIC', 'IN_PERSON', 'OTHER');

ALTER TABLE "Prescription"
  ADD COLUMN "sourceType" "PrescriptionSourceType" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "electronicMessageId" TEXT,
  ADD COLUMN "electronicRawMessage" TEXT;

CREATE TABLE "Document" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "patientId" TEXT,
  "prescriptionId" TEXT,
  "kind" "DocumentKind" NOT NULL DEFAULT 'PRESCRIPTION_SOURCE',
  "sourceType" "DocumentSourceType" NOT NULL,
  "mimeType" TEXT NOT NULL,
  "originalFilename" TEXT,
  "storageKey" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "encrypted" BOOLEAN NOT NULL DEFAULT false,
  "immutable" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrescriptionAnnotation" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "prescriptionId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "x" DECIMAL(7,6) NOT NULL,
  "y" DECIMAL(7,6) NOT NULL,
  "width" DECIMAL(7,6) NOT NULL,
  "height" DECIMAL(7,6) NOT NULL,
  "backgroundOpacity" DECIMAL(4,3) NOT NULL DEFAULT 1,
  "status" "PrescriptionAnnotationStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersedesAnnotationId" TEXT,
  CONSTRAINT "PrescriptionAnnotation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrescriptionChangeRecord" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "prescriptionId" TEXT NOT NULL,
  "annotationId" TEXT NOT NULL,
  "changeType" "PrescriptionChangeType" NOT NULL,
  "whatChanged" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "communicationMethod" "PrescriptionChangeCommunicationMethod",
  "contactedParty" TEXT,
  "authorizingPrescriber" TEXT,
  "note" TEXT,
  "status" "PrescriptionChangeRecordStatus" NOT NULL DEFAULT 'ACTIVE',
  "changedById" TEXT NOT NULL,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersedesChangeRecordId" TEXT,
  CONSTRAINT "PrescriptionChangeRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");
CREATE INDEX "Document_siteId_createdAt_idx" ON "Document"("siteId", "createdAt");
CREATE INDEX "Document_patientId_createdAt_idx" ON "Document"("patientId", "createdAt");
CREATE INDEX "Document_prescriptionId_createdAt_idx" ON "Document"("prescriptionId", "createdAt");
CREATE INDEX "Document_sha256_idx" ON "Document"("sha256");

CREATE UNIQUE INDEX "PrescriptionAnnotation_supersedesAnnotationId_key" ON "PrescriptionAnnotation"("supersedesAnnotationId");
CREATE INDEX "PrescriptionAnnotation_siteId_createdAt_idx" ON "PrescriptionAnnotation"("siteId", "createdAt");
CREATE INDEX "PrescriptionAnnotation_prescriptionId_status_createdAt_idx" ON "PrescriptionAnnotation"("prescriptionId", "status", "createdAt");
CREATE INDEX "PrescriptionAnnotation_documentId_status_createdAt_idx" ON "PrescriptionAnnotation"("documentId", "status", "createdAt");

CREATE UNIQUE INDEX "PrescriptionChangeRecord_annotationId_key" ON "PrescriptionChangeRecord"("annotationId");
CREATE UNIQUE INDEX "PrescriptionChangeRecord_supersedesChangeRecordId_key" ON "PrescriptionChangeRecord"("supersedesChangeRecordId");
CREATE INDEX "PrescriptionChangeRecord_siteId_changedAt_idx" ON "PrescriptionChangeRecord"("siteId", "changedAt");
CREATE INDEX "PrescriptionChangeRecord_prescriptionId_status_changedAt_idx" ON "PrescriptionChangeRecord"("prescriptionId", "status", "changedAt");

ALTER TABLE "Document"
  ADD CONSTRAINT "Document_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "Patient"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_prescriptionId_fkey"
  FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionAnnotation"
  ADD CONSTRAINT "PrescriptionAnnotation_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionAnnotation"
  ADD CONSTRAINT "PrescriptionAnnotation_prescriptionId_fkey"
  FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionAnnotation"
  ADD CONSTRAINT "PrescriptionAnnotation_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionAnnotation"
  ADD CONSTRAINT "PrescriptionAnnotation_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionAnnotation"
  ADD CONSTRAINT "PrescriptionAnnotation_supersedesAnnotationId_fkey"
  FOREIGN KEY ("supersedesAnnotationId") REFERENCES "PrescriptionAnnotation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PrescriptionChangeRecord"
  ADD CONSTRAINT "PrescriptionChangeRecord_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionChangeRecord"
  ADD CONSTRAINT "PrescriptionChangeRecord_prescriptionId_fkey"
  FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionChangeRecord"
  ADD CONSTRAINT "PrescriptionChangeRecord_annotationId_fkey"
  FOREIGN KEY ("annotationId") REFERENCES "PrescriptionAnnotation"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionChangeRecord"
  ADD CONSTRAINT "PrescriptionChangeRecord_changedById_fkey"
  FOREIGN KEY ("changedById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionChangeRecord"
  ADD CONSTRAINT "PrescriptionChangeRecord_supersedesChangeRecordId_fkey"
  FOREIGN KEY ("supersedesChangeRecordId") REFERENCES "PrescriptionChangeRecord"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
