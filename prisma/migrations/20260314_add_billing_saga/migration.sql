DO $$
BEGIN
  CREATE TYPE "SagaStatus" AS ENUM (
    'PENDING',
    'COMPLETED',
    'CANCELLED',
    'EXPIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "BillingSaga" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "subscriptionAmount" INTEGER NOT NULL DEFAULT 0,
  "creditsAmount" INTEGER NOT NULL DEFAULT 0,
  "creditType" "CreditType",
  "walletBlockId" TEXT,
  "walletAmount" DECIMAL NOT NULL DEFAULT 0,
  "status" "SagaStatus" NOT NULL,
  "operation" TEXT NOT NULL,
  "buildId" TEXT,
  "batchId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingSaga_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingSaga_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "BillingSaga_buildId_idx"
ON "BillingSaga"("buildId");

CREATE INDEX IF NOT EXISTS "BillingSaga_batchId_idx"
ON "BillingSaga"("batchId");

CREATE INDEX IF NOT EXISTS "BillingSaga_status_expiresAt_idx"
ON "BillingSaga"("status", "expiresAt");
