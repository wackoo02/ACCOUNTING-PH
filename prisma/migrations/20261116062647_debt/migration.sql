-- Debt module. Safe to re-run (see scripts/migrate.mjs RERUNNABLE).
-- CreateTable
CREATE TABLE IF NOT EXISTS "Loan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "lender" TEXT NOT NULL,
    "lenderVendorCode" TEXT,
    "loanType" TEXT NOT NULL,
    "originalPrincipal" DECIMAL(18,2) NOT NULL,
    "interestRate" DECIMAL(9,6) NOT NULL,
    "rateType" TEXT NOT NULL DEFAULT 'FIXED',
    "dayCount" TEXT NOT NULL DEFAULT 'ACT_365',
    "startDate" DATE NOT NULL,
    "maturityDate" DATE NOT NULL,
    "firstPaymentDate" DATE,
    "paymentFrequency" TEXT NOT NULL,
    "repaymentType" TEXT NOT NULL,
    "graceMonths" INTEGER NOT NULL DEFAULT 0,
    "stAccountId" TEXT NOT NULL,
    "ltAccountId" TEXT NOT NULL,
    "interestExpenseAccountId" TEXT NOT NULL,
    "interestPayableAccountId" TEXT NOT NULL,
    "issueCostAccountId" TEXT,
    "bankAccountId" TEXT,
    "effectiveRate" DECIMAL(12,8),
    "lastAccrualDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LoanScheduleLine" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "periodStart" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "openingPrincipal" DECIMAL(18,2) NOT NULL,
    "interest" DECIMAL(18,2) NOT NULL,
    "principal" DECIMAL(18,2) NOT NULL,
    "payment" DECIMAL(18,2) NOT NULL,
    "closingPrincipal" DECIMAL(18,2) NOT NULL,
    "openingCarrying" DECIMAL(18,2) NOT NULL,
    "eirInterest" DECIMAL(18,2) NOT NULL,
    "amortization" DECIMAL(18,2) NOT NULL,
    "closingCarrying" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "LoanScheduleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LoanTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "memo" TEXT NOT NULL,
    "principalChange" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currentChange" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "costChange" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "accruedChange" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "interestExpense" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cashChange" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "details" JSONB,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "journalEntryId" TEXT,
    "cashTransactionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LoanCovenant" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "threshold" DECIMAL(18,4) NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'QUARTERLY',
    "manualValue" DECIMAL(18,4),
    "waiverUntil" DATE,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanCovenant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Loan_organizationId_status_idx" ON "Loan"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Loan_organizationId_number_key" ON "Loan"("organizationId", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LoanScheduleLine_loanId_dueDate_idx" ON "LoanScheduleLine"("loanId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LoanTransaction_cashTransactionId_key" ON "LoanTransaction"("cashTransactionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LoanTransaction_organizationId_loanId_date_idx" ON "LoanTransaction"("organizationId", "loanId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LoanTransaction_organizationId_status_idx" ON "LoanTransaction"("organizationId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LoanCovenant_organizationId_loanId_idx" ON "LoanCovenant"("organizationId", "loanId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanScheduleLine_loanId_fkey') THEN
    ALTER TABLE "LoanScheduleLine" ADD CONSTRAINT "LoanScheduleLine_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanTransaction_loanId_fkey') THEN
    ALTER TABLE "LoanTransaction" ADD CONSTRAINT "LoanTransaction_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanCovenant_loanId_fkey') THEN
    ALTER TABLE "LoanCovenant" ADD CONSTRAINT "LoanCovenant_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
