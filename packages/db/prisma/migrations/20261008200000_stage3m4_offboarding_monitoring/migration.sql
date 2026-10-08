-- Stage 3M.4 credential attestations are non-authoritative and cannot
-- constitute real pharmacist license verification.
CREATE TYPE "CredentialReviewStatus" AS ENUM ('PENDING', 'TEST_ATTESTED', 'REJECTED');
CREATE TABLE "StaffCredentialReview" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "submittedById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "role" "UserRole" NOT NULL,
  "status" "CredentialReviewStatus" NOT NULL DEFAULT 'PENDING',
  "authority" TEXT NOT NULL,
  "evidenceReference" TEXT NOT NULL,
  "rationale" TEXT NOT NULL,
  "reviewNote" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "StaffCredentialReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StaffCredentialReview_role_check" CHECK ("role" IN ('PHARMACIST', 'PHARMACIST_IN_CHARGE')),
  CONSTRAINT "StaffCredentialReview_independent_check" CHECK ("reviewedById" IS NULL OR
    ("reviewedById" <> "submittedById" AND "reviewedById" <> "targetUserId")),
  CONSTRAINT "StaffCredentialReview_status_check" CHECK (
    ("status" = 'PENDING' AND "reviewedById" IS NULL AND "reviewedAt" IS NULL) OR
    ("status" <> 'PENDING' AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)
  ),
  CONSTRAINT "StaffCredentialReview_expiry_check" CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX "StaffCredentialReview_siteId_status_createdAt_idx" ON "StaffCredentialReview" ("siteId", "status", "createdAt");
CREATE INDEX "StaffCredentialReview_targetUserId_role_status_expiresAt_idx" ON "StaffCredentialReview" ("targetUserId", "role", "status", "expiresAt");
ALTER TABLE "StaffCredentialReview" ADD CONSTRAINT "StaffCredentialReview_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffCredentialReview" ADD CONSTRAINT "StaffCredentialReview_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffCredentialReview" ADD CONSTRAINT "StaffCredentialReview_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffCredentialReview" ADD CONSTRAINT "StaffCredentialReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SecurityEvent" (
  "id" TEXT NOT NULL,
  "siteId" TEXT,
  "kind" TEXT NOT NULL,
  "requestPath" TEXT NOT NULL,
  "httpStatus" INTEGER NOT NULL,
  "networkHash" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SecurityEvent_occurredAt_kind_idx" ON "SecurityEvent" ("occurredAt", "kind");
CREATE INDEX "SecurityEvent_siteId_occurredAt_idx" ON "SecurityEvent" ("siteId", "occurredAt");
CREATE INDEX "SecurityEvent_networkHash_occurredAt_idx" ON "SecurityEvent" ("networkHash", "occurredAt");
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
