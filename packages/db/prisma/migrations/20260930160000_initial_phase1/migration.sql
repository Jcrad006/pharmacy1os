CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'PHARMACIST', 'TECHNICIAN', 'INTERN', 'CASHIER', 'AUDITOR');
CREATE TYPE "PrescriptionStatus" AS ENUM ('RECEIVED', 'DATA_ENTRY', 'DUR_REVIEW', 'PRODUCT_FILL', 'PHARMACIST_REVIEW', 'READY', 'SOLD', 'ON_HOLD', 'CANCELLED', 'TRANSFERRED');
CREATE TYPE "FillStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'READY', 'SOLD', 'RETURNED_TO_STOCK', 'CANCELLED');

CREATE TABLE "PharmacySite" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "npi" TEXT,
  "ncpdpId" TEXT,
  "phone" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PharmacySite_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "externalAuthId" TEXT,
  "displayName" TEXT NOT NULL,
  "role" "UserRole" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Patient" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "dateOfBirth" TIMESTAMP(3),
  "phone" TEXT,
  "email" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Prescriber" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "npi" TEXT,
  "deaNumber" TEXT,
  "phone" TEXT,
  "fax" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Prescriber_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Prescription" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "prescriberId" TEXT NOT NULL,
  "rxNumber" TEXT,
  "medicationName" TEXT NOT NULL,
  "strength" TEXT,
  "dosageForm" TEXT,
  "sig" TEXT NOT NULL,
  "quantityWritten" DECIMAL(10,3),
  "refillsAllowed" INTEGER NOT NULL DEFAULT 0,
  "refillsUsed" INTEGER NOT NULL DEFAULT 0,
  "writtenDate" TIMESTAMP(3),
  "expirationDate" TIMESTAMP(3),
  "status" "PrescriptionStatus" NOT NULL DEFAULT 'RECEIVED',
  "doNotFillBefore" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrescriptionFill" (
  "id" TEXT NOT NULL,
  "prescriptionId" TEXT NOT NULL,
  "fillNumber" INTEGER NOT NULL,
  "scheduledFor" TIMESTAMP(3),
  "quantity" DECIMAL(10,3),
  "status" "FillStatus" NOT NULL DEFAULT 'SCHEDULED',
  "filledAt" TIMESTAMP(3),
  "soldAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrescriptionFill_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "actorId" TEXT,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "requestId" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_externalAuthId_key" ON "User"("externalAuthId");
CREATE INDEX "User_siteId_role_idx" ON "User"("siteId", "role");
CREATE INDEX "Patient_siteId_lastName_firstName_idx" ON "Patient"("siteId", "lastName", "firstName");
CREATE UNIQUE INDEX "Prescriber_siteId_npi_key" ON "Prescriber"("siteId", "npi");
CREATE INDEX "Prescriber_siteId_lastName_firstName_idx" ON "Prescriber"("siteId", "lastName", "firstName");
CREATE UNIQUE INDEX "Prescription_siteId_rxNumber_key" ON "Prescription"("siteId", "rxNumber");
CREATE INDEX "Prescription_siteId_status_idx" ON "Prescription"("siteId", "status");
CREATE INDEX "Prescription_patientId_idx" ON "Prescription"("patientId");
CREATE UNIQUE INDEX "PrescriptionFill_prescriptionId_fillNumber_key" ON "PrescriptionFill"("prescriptionId", "fillNumber");
CREATE INDEX "PrescriptionFill_scheduledFor_status_idx" ON "PrescriptionFill"("scheduledFor", "status");
CREATE INDEX "AuditEvent_siteId_occurredAt_idx" ON "AuditEvent"("siteId", "occurredAt");
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

ALTER TABLE "User" ADD CONSTRAINT "User_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prescriber" ADD CONSTRAINT "Prescriber_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_prescriberId_fkey" FOREIGN KEY ("prescriberId") REFERENCES "Prescriber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrescriptionFill" ADD CONSTRAINT "PrescriptionFill_prescriptionId_fkey" FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
