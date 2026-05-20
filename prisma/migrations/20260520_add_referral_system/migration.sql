-- Migration: Add Referral System
-- Date: 2026-05-20
-- Description: Adds ReferralCode and Referral tables, adds Account relations,
--              adds referral config defaults, adds ReferralStatus enum

-- 1. Add ReferralStatus enum
DO $$ BEGIN
  CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Add referral relations to Account (they reference new tables, added after)
-- (columns added implicitly via FK after tables are created)

-- 3. Create ReferralCode table
CREATE TABLE IF NOT EXISTS "ReferralCode" (
  "id"         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "accountId"  UUID         NOT NULL UNIQUE,
  "code"       TEXT         NOT NULL UNIQUE,
  "usageCount" INT          NOT NULL DEFAULT 0,
  "isActive"   BOOLEAN      NOT NULL DEFAULT TRUE,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferralCode_accountId_fkey" FOREIGN KEY ("accountId")
    REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ReferralCode_code_idx" ON "ReferralCode"("code");

-- 4. Create Referral table
CREATE TABLE IF NOT EXISTS "Referral" (
  "id"          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  "referrerId"  UUID             NOT NULL,
  "referredId"  UUID             NOT NULL UNIQUE,
  "codeId"      UUID,
  "status"      "ReferralStatus" NOT NULL DEFAULT 'PENDING',
  "bonusPaid"   BOOLEAN          NOT NULL DEFAULT FALSE,
  "bonusAmount" INT              NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId")
    REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId")
    REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Referral_codeId_fkey" FOREIGN KEY ("codeId")
    REFERENCES "ReferralCode"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Referral_referrerId_idx" ON "Referral"("referrerId");
CREATE INDEX IF NOT EXISTS "Referral_status_idx"     ON "Referral"("status");

-- 5. Add referral config defaults
INSERT INTO "BillingConfig" (id, key, value, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'referral.referrer_bonus', '5', NOW(), NOW()),
  (gen_random_uuid(), 'referral.referred_bonus', '3', NOW(), NOW())
ON CONFLICT (key) DO NOTHING;

