-- Leases (PFRS 16). Safe to re-run if a deploy stops partway.
-- CreateTable
CREATE TABLE IF NOT EXISTS "Lease" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "lessorName" TEXT NOT NULL,
    "lessorVendorCode" TEXT,
    "leaseType" TEXT NOT NULL,
    "assetDescription" TEXT NOT NULL,
    "location" TEXT,
    "commencementDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "paymentAmount" DECIMAL(18,2) NOT NULL,
    "paymentFrequency" TEXT NOT NULL,
    "paymentTiming" TEXT NOT NULL,
    "escalationPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "escalationEveryMonths" INTEGER NOT NULL DEFAULT 12,
    "incrementalBorrowingRate" DECIMAL(9,6) NOT NULL,
    "discountRate" DECIMAL(9,6) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "exemption" TEXT NOT NULL DEFAULT 'NONE',
    "transfersOwnership" BOOLEAN NOT NULL DEFAULT false,
    "usefulLifeMonths" INTEGER,
    "initialDirectCosts" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "prepaidLeasePayments" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "leaseIncentives" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "restorationCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatable" BOOLEAN NOT NULL DEFAULT false,
    "ewtTaxCodeId" TEXT,
    "rouAccountId" TEXT NOT NULL,
    "accumDepAccountId" TEXT NOT NULL,
    "liabilityAccountId" TEXT NOT NULL,
    "currentLiabilityAccountId" TEXT,
    "interestAccountId" TEXT NOT NULL,
    "depreciationAccountId" TEXT NOT NULL,
    "rentExpenseAccountId" TEXT,
    "paymentAccountId" TEXT NOT NULL,
    "gainLossAccountId" TEXT NOT NULL,
    "initialCostsAccountId" TEXT,
    "restorationAccountId" TEXT,
    "takeUpDate" DATE,
    "takeUpOffsetAccountId" TEXT,
    "dims" JSONB,
    "payments" JSONB NOT NULL,
    "initialLiability" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "initialRou" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LeaseScheduleLine" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "opening" DECIMAL(18,2) NOT NULL,
    "interest" DECIMAL(18,2) NOT NULL,
    "payment" DECIMAL(18,2) NOT NULL,
    "closing" DECIMAL(18,2) NOT NULL,
    "currentPortion" DECIMAL(18,2) NOT NULL,
    "depreciation" DECIMAL(18,2) NOT NULL,
    "rouOpening" DECIMAL(18,2) NOT NULL,
    "rouClosing" DECIMAL(18,2) NOT NULL,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),

    CONSTRAINT "LeaseScheduleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LeaseEvent" (
    "id" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "journalEntryId" TEXT,
    "scheduleLineId" TEXT,
    "rouAddition" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "rouRemeasurement" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "rouDerecognized" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "depreciation" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "accumDepDerecognized" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "liabilityAddition" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "liabilityRemeasurement" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "interest" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "payment" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "liabilityDerecognized" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "gainLoss" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "rentExpense" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "details" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Lease_organizationId_status_idx" ON "Lease"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Lease_organizationId_number_key" ON "Lease"("organizationId", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LeaseScheduleLine_organizationId_periodEnd_idx" ON "LeaseScheduleLine"("organizationId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LeaseScheduleLine_leaseId_periodStart_key" ON "LeaseScheduleLine"("leaseId", "periodStart");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LeaseEvent_organizationId_date_idx" ON "LeaseEvent"("organizationId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LeaseEvent_leaseId_createdAt_idx" ON "LeaseEvent"("leaseId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LeaseScheduleLine" ADD CONSTRAINT "LeaseScheduleLine_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LeaseEvent" ADD CONSTRAINT "LeaseEvent_leaseId_fkey" FOREIGN KEY ("leaseId") REFERENCES "Lease"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
