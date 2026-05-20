CREATE TABLE "PaymentTransaction" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "operation" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "status" "TransactionStatus" NOT NULL,
  "walletBlockId" TEXT,
  "sagaId" TEXT,
  "buildId" TEXT,
  "batchId" TEXT,
  "metadata" JSONB,
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentTransaction_walletBlockId_key"
  ON "PaymentTransaction"("walletBlockId");

CREATE UNIQUE INDEX "PaymentTransaction_sagaId_key"
  ON "PaymentTransaction"("sagaId");

CREATE INDEX "PaymentTransaction_accountId_createdAt_idx"
  ON "PaymentTransaction"("accountId", "createdAt");

CREATE INDEX "PaymentTransaction_status_createdAt_idx"
  ON "PaymentTransaction"("status", "createdAt");

CREATE INDEX "PaymentTransaction_buildId_idx"
  ON "PaymentTransaction"("buildId");

CREATE INDEX "PaymentTransaction_batchId_idx"
  ON "PaymentTransaction"("batchId");

ALTER TABLE "PaymentTransaction"
  ADD CONSTRAINT "PaymentTransaction_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
