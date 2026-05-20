DO $$
BEGIN
  CREATE TYPE "SubscriptionStatus" AS ENUM (
    'ACTIVE',
    'CANCELLED',
    'PAST_DUE',
    'EXPIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "SubscriptionPlan" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "lagoPlanCode" TEXT NOT NULL,
  "monthlyCredits" INTEGER NOT NULL,
  "priceMonthly" DECIMAL NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "features" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Subscription" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "status" "SubscriptionStatus" NOT NULL,
  "currentPeriodStart" TIMESTAMP(3) NOT NULL,
  "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
  "creditsAllocated" INTEGER NOT NULL,
  "creditsUsed" INTEGER NOT NULL DEFAULT 0,
  "lagoSubscriptionId" TEXT,
  "lagoExternalId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Subscription_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Subscription_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionPlan_lagoPlanCode_key"
ON "SubscriptionPlan"("lagoPlanCode");

CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_lagoSubscriptionId_key"
ON "Subscription"("lagoSubscriptionId");

CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_lagoExternalId_key"
ON "Subscription"("lagoExternalId");

CREATE INDEX IF NOT EXISTS "SubscriptionPlan_isActive_idx"
ON "SubscriptionPlan"("isActive");

CREATE INDEX IF NOT EXISTS "Subscription_accountId_status_currentPeriodEnd_idx"
ON "Subscription"("accountId", "status", "currentPeriodEnd");
