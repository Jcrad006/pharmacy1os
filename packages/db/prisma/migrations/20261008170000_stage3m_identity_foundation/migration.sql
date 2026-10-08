-- Stage 3M.1: additive identity/session tables; existing staff remain in their
-- current site. No real accounts are bootstrapped from synthetic dev identities.
ALTER TABLE "User" ADD COLUMN "oidcSubject" TEXT;
CREATE UNIQUE INDEX "User_oidcSubject_key" ON "User"("oidcSubject");

CREATE TABLE "SiteRoleAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SiteRoleAssignment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SiteRoleAssignment_userId_siteId_key" ON "SiteRoleAssignment"("userId", "siteId");
CREATE INDEX "SiteRoleAssignment_siteId_active_role_idx" ON "SiteRoleAssignment"("siteId", "active", "role");
ALTER TABLE "SiteRoleAssignment" ADD CONSTRAINT "SiteRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SiteRoleAssignment" ADD CONSTRAINT "SiteRoleAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Backfill pre-existing staff, preserving their established primary site roles.
INSERT INTO "SiteRoleAssignment" ("id", "userId", "siteId", "role", "active", "updatedAt")
SELECT gen_random_uuid()::text, "id", "siteId", "role", "active", CURRENT_TIMESTAMP FROM "User";

CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleExpiresAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "mfaVerifiedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuthSession_sessionHash_key" ON "AuthSession"("sessionHash");
CREATE INDEX "AuthSession_userId_revokedAt_idx" ON "AuthSession"("userId", "revokedAt");
CREATE INDEX "AuthSession_siteId_expiresAt_idx" ON "AuthSession"("siteId", "expiresAt");
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "OidcLoginAttempt" (
    "stateHash" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "pkceVerifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "OidcLoginAttempt_pkey" PRIMARY KEY ("stateHash")
);
