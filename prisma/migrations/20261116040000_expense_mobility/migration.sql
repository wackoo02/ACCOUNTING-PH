-- CreateEnum
CREATE TYPE "ExpenseModule" AS ENUM ('PETTY_CASH', 'TRAVEL', 'TRANSPORT', 'DELIVERY');

-- CreateEnum
CREATE TYPE "ExpensePayment" AS ENUM ('PETTY_CASH_FUND', 'EMPLOYEE', 'GCASH', 'MAYA', 'CREDIT_CARD', 'DEBIT_CARD', 'CORPORATE_WALLET', 'COMPANY_ACCOUNT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PettyCashStatus" ADD VALUE 'RETURNED';
ALTER TYPE "PettyCashStatus" ADD VALUE 'CLEARED';
ALTER TYPE "PettyCashStatus" ADD VALUE 'HOLD';
ALTER TYPE "PettyCashStatus" ADD VALUE 'REIMBURSED';

-- DropForeignKey
ALTER TABLE "PettyCashVoucher" DROP CONSTRAINT "PettyCashVoucher_fundId_fkey";

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "businessUnit" TEXT,
ADD COLUMN     "costCenter" TEXT,
ADD COLUMN     "projectCode" TEXT,
ADD COLUMN     "supervisorCode" TEXT;

-- AlterTable
ALTER TABLE "PettyCashVoucher" ADD COLUMN     "bookingNumber" TEXT,
ADD COLUMN     "checks" JSONB,
ADD COLUMN     "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
ADD COLUMN     "details" JSONB,
ADD COLUMN     "employeeId" TEXT,
ADD COLUMN     "financeAt" TIMESTAMP(3),
ADD COLUMN     "financeById" TEXT,
ADD COLUMN     "financeNote" TEXT,
ADD COLUMN     "foreignTotal" DECIMAL(18,2),
ADD COLUMN     "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
ADD COLUMN     "journalEntryId" TEXT,
ADD COLUMN     "module" "ExpenseModule" NOT NULL DEFAULT 'PETTY_CASH',
ADD COLUMN     "noReceipt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "noReceiptReason" TEXT,
ADD COLUMN     "paymentAccountId" TEXT,
ADD COLUMN     "paymentMethod" "ExpensePayment" NOT NULL DEFAULT 'PETTY_CASH_FUND',
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "purpose" TEXT,
ADD COLUMN     "reimbursementId" TEXT,
ADD COLUMN     "statementLineId" TEXT,
ADD COLUMN     "transactionType" TEXT,
ADD COLUMN     "tripAt" TIMESTAMP(3),
ALTER COLUMN "fundId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "ExpenseMapping" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "transactionType" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseMapping_organizationId_transactionType_key" ON "ExpenseMapping"("organizationId", "transactionType");

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashVoucher_journalEntryId_key" ON "PettyCashVoucher"("journalEntryId");

-- CreateIndex
CREATE INDEX "PettyCashVoucher_organizationId_bookingNumber_idx" ON "PettyCashVoucher"("organizationId", "bookingNumber");

-- CreateIndex
CREATE INDEX "PettyCashVoucher_organizationId_employeeId_idx" ON "PettyCashVoucher"("organizationId", "employeeId");

-- AddForeignKey
ALTER TABLE "PettyCashVoucher" ADD CONSTRAINT "PettyCashVoucher_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "PettyCashFund"("id") ON DELETE SET NULL ON UPDATE CASCADE;

