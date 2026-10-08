-- Stage 3M.5 additive protected account dual-approval ledger.
CREATE TYPE "ProtectedOffboardingStatus" AS ENUM ('PENDING','APPROVED','DENIED','CANCELLED');
CREATE TABLE "ProtectedOffboardingRequest" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "status" "ProtectedOffboardingStatus" NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewDeadlineAt" TIMESTAMP(3) NOT NULL,
  "reviewedAt" TIMESTAMP(3),
  CONSTRAINT "ProtectedOffboardingRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "protected_offboarding_separation_check" CHECK (
    "reviewedById" IS NULL OR
      ("reviewedById" <> "requestedById" AND "reviewedById" <> "targetUserId")
  ),
  CONSTRAINT "protected_offboarding_deadline_check" CHECK ("reviewDeadlineAt" > "createdAt"),
  CONSTRAINT "protected_offboarding_review_state_check" CHECK (
    ("status" = 'PENDING' AND "reviewedAt" IS NULL AND "reviewedById" IS NULL)
    OR
    ("status" = 'CANCELLED' AND "reviewedById" IS NULL AND "reviewedAt" IS NULL)
    OR
    ("status" IN ('APPROVED','DENIED') AND "reviewedById" IS NOT NULL AND "reviewedAt" IS NOT NULL)
  )
);
CREATE INDEX "ProtectedOffboardingRequest_siteId_status_createdAt_idx" ON "ProtectedOffboardingRequest" ("siteId", "status", "createdAt");
CREATE INDEX "ProtectedOffboardingRequest_targetUserId_status_createdAt_idx" ON "ProtectedOffboardingRequest" ("targetUserId", "status", "createdAt");
ALTER TABLE "ProtectedOffboardingRequest" ADD CONSTRAINT "ProtectedOffboardingRequest_siteId_fkey"
 FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProtectedOffboardingRequest" ADD CONSTRAINT "ProtectedOffboardingRequest_targetUserId_fkey"
 FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProtectedOffboardingRequest" ADD CONSTRAINT "ProtectedOffboardingRequest_requestedById_fkey"
 FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProtectedOffboardingRequest" ADD CONSTRAINT "ProtectedOffboardingRequest_reviewedById_fkey"
 FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
