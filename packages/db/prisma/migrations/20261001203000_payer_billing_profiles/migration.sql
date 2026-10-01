CREATE TABLE "PayerBillingProfile" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "payerId" TEXT NOT NULL,
  "billingNdcStrategy" "BillingNdcStrategy" NOT NULL DEFAULT 'MAJORITY_SOURCE',
  "autoReversePaidClaimOnSourceCorrection" BOOLEAN NOT NULL DEFAULT true,
  "customRules" JSONB NOT NULL DEFAULT '{}',
  "notes" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayerBillingProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayerBillingProfile_payerId_key"
  ON "PayerBillingProfile"("payerId");

CREATE INDEX "PayerBillingProfile_siteId_updatedAt_idx"
  ON "PayerBillingProfile"("siteId", "updatedAt");

ALTER TABLE "PayerBillingProfile"
  ADD CONSTRAINT "PayerBillingProfile_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "PharmacySite"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PayerBillingProfile"
  ADD CONSTRAINT "PayerBillingProfile_payerId_fkey"
  FOREIGN KEY ("payerId") REFERENCES "Payer"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayerBillingProfile"
  ADD CONSTRAINT "PayerBillingProfile_version_check"
  CHECK ("version" > 0);

INSERT INTO "PayerBillingProfile" (
  "id",
  "siteId",
  "payerId",
  "billingNdcStrategy",
  "autoReversePaidClaimOnSourceCorrection",
  "customRules",
  "version",
  "createdAt",
  "updatedAt"
)
SELECT
  'billing-profile-' || "id",
  "siteId",
  "id",
  "billingNdcStrategy",
  CASE WHEN "billingNdcStrategy" = 'MAJORITY_SOURCE' THEN true ELSE false END,
  '{}'::jsonb,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Payer";

ALTER TABLE "ClaimTransaction"
  ADD COLUMN "billingProfileVersion" INTEGER,
  ADD COLUMN "billingProfileSnapshot" JSONB;
