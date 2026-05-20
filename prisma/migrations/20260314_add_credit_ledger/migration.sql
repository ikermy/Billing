ALTER TABLE "Account"
ALTER COLUMN "walletId" DROP NOT NULL;

ALTER TABLE "Account"
ALTER COLUMN "lagoCustomerId" DROP NOT NULL;

DO $$
BEGIN
  CREATE TYPE "CreditType" AS ENUM ('BARCODE', 'AI');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "CreditOperation" AS ENUM (
    'PURCHASE',
    'SUBSCRIPTION',
    'CHARGE',
    'REFUND',
    'BONUS',
    'BLOCK',
    'UNBLOCK'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "TransactionStatus" AS ENUM (
    'PENDING',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CreditBalance" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "creditType" "CreditType" NOT NULL,
  "balance" INTEGER NOT NULL DEFAULT 0,
  "reserved" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreditBalance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreditBalance_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "CreditTransaction" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "creditType" "CreditType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "operation" "CreditOperation" NOT NULL,
  "buildId" TEXT,
  "batchId" TEXT,
  "status" "TransactionStatus" NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreditTransaction_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "CreditBalance_accountId_creditType_key"
ON "CreditBalance"("accountId", "creditType");

CREATE INDEX IF NOT EXISTS "CreditTransaction_accountId_createdAt_idx"
ON "CreditTransaction"("accountId", "createdAt");

CREATE INDEX IF NOT EXISTS "CreditTransaction_buildId_idx"
ON "CreditTransaction"("buildId");

CREATE INDEX IF NOT EXISTS "CreditTransaction_batchId_idx"
ON "CreditTransaction"("batchId");
