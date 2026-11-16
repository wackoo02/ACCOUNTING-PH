-- AlterEnum
ALTER TYPE "DimensionType" ADD VALUE 'DIVISION';

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "divisionId" TEXT;

-- CreateTable
CREATE TABLE "TaxCode" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxType" TEXT NOT NULL,
    "rate" DECIMAL(7,4) NOT NULL,
    "atcCode" TEXT,
    "accountCode" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TaxCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringJournal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "nextRunDate" DATE NOT NULL,
    "endDate" DATE,
    "memo" TEXT NOT NULL,
    "reference" TEXT,
    "lines" JSONB NOT NULL,
    "autoSubmit" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AllocationRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceAccountId" TEXT NOT NULL,
    "targetAccountId" TEXT,
    "dimensionType" "DimensionType" NOT NULL,
    "splits" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AllocationRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxCode_organizationId_code_key" ON "TaxCode"("organizationId", "code");

-- CreateIndex
CREATE INDEX "RecurringJournal_organizationId_nextRunDate_idx" ON "RecurringJournal"("organizationId", "nextRunDate");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
