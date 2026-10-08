-- Stage 3M.3: durable two-person approval lifecycle.
CREATE TYPE "PrivilegedAccessKind" AS ENUM ('ROLE_GRANT', 'TEMP_PERMISSION');
CREATE TYPE "PrivilegedAccessStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED');
CREATE TABLE "PrivilegedAccessRequest" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "kind" "PrivilegedAccessKind" NOT NULL,
  "status" "PrivilegedAccessStatus" NOT NULL DEFAULT 'PENDING',
  "requestedRole" "UserRole",
  "requestedPermission" TEXT,
  "expectedAssignmentUpdatedAt" TIMESTAMP(3),
  "reason" TEXT NOT NULL,
  "reviewNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewDeadlineAt" TIMESTAMP(3) NOT NULL,
  "reviewedAt" TIMESTAMP(3),
  "effectiveUntil" TIMESTAMP(3),
  CONSTRAINT "PrivilegedAccessRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "privileged_request_scope_shape" CHECK (
    ("kind" = 'ROLE_GRANT' AND "requestedRole" IS NOT NULL
      AND "requestedPermission" IS NULL AND "expectedAssignmentUpdatedAt" IS NOT NULL)
    OR
    ("kind" = 'TEMP_PERMISSION' AND "requestedPermission" IS NOT NULL
      AND "requestedRole" IS NULL AND "expectedAssignmentUpdatedAt" IS NULL)
  ),
  CONSTRAINT "privileged_request_reviewer_separation" CHECK (
    "reviewedById" IS NULL OR ("reviewedById" <> "requestedById" AND "reviewedById" <> "targetUserId")
  ),
  CONSTRAINT "privileged_request_deadline" CHECK ("reviewDeadlineAt" > "createdAt"),
  CONSTRAINT "privileged_request_state_invariant" CHECK (
    ("status" = 'PENDING' AND "reviewedAt" IS NULL AND "reviewedById" IS NULL)
    OR
    ("status" <> 'PENDING')
  )
);
CREATE INDEX "PrivilegedAccessRequest_siteId_status_createdAt_idx" ON "PrivilegedAccessRequest"("siteId", "status", "createdAt");
CREATE INDEX "PrivilegedAccessRequest_targetUserId_status_effectiveUntil_idx" ON "PrivilegedAccessRequest"("targetUserId", "status", "effectiveUntil");
ALTER TABLE "PrivilegedAccessRequest" ADD CONSTRAINT "PrivilegedAccessRequest_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivilegedAccessRequest" ADD CONSTRAINT "PrivilegedAccessRequest_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivilegedAccessRequest" ADD CONSTRAINT "PrivilegedAccessRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivilegedAccessRequest" ADD CONSTRAINT "PrivilegedAccessRequest_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
