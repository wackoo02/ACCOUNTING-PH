-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'APPROVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PettyCashStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'BATCHED', 'REPLENISHED');

-- AlterEnum
ALTER TYPE "JournalSource" ADD VALUE 'PETTY_CASH';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "fixedAssetThreshold" DECIMAL(18,2) NOT NULL DEFAULT 5000;

-- CreateTable
CREATE TABLE "PettyCashFund" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "custodianUserId" TEXT,
    "accountId" TEXT NOT NULL,
    "replenishAccountId" TEXT,
    "imprestAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PettyCashFund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "poDate" DATE NOT NULL,
    "vendorId" TEXT,
    "vendorName" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PettyCashVoucher" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "PettyCashStatus" NOT NULL DEFAULT 'DRAFT',
    "receiptDate" DATE NOT NULL,
    "docType" TEXT NOT NULL DEFAULT 'OR',
    "docNumber" TEXT,
    "vendorId" TEXT,
    "vendorName" TEXT NOT NULL,
    "vendorTin" TEXT,
    "vendorAddress" TEXT,
    "vendorVatRegistered" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL,
    "grossAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatExemptAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "zeroRatedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "ewtTaxCodeId" TEXT,
    "ewtAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tipAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tipHandwritten" BOOLEAN NOT NULL DEFAULT false,
    "totalPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purchaseOrderId" TEXT,
    "departmentId" TEXT,
    "costCenterId" TEXT,
    "branchId" TEXT,
    "projectId" TEXT,
    "imageId" TEXT,
    "extraction" JSONB,
    "createdById" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "batchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PettyCashVoucher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PettyCashVoucherLine" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "accountId" TEXT NOT NULL,
    "suggestedAccountId" TEXT,
    "isFixedAsset" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PettyCashVoucherLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PettyCashBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fundId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "totalPaid" DECIMAL(18,2) NOT NULL,
    "journalEntryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PettyCashBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptImage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashFund_organizationId_code_key" ON "PettyCashFund"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_number_key" ON "PurchaseOrder"("organizationId", "number");

-- CreateIndex
CREATE INDEX "PettyCashVoucher_organizationId_status_idx" ON "PettyCashVoucher"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashVoucher_organizationId_number_key" ON "PettyCashVoucher"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashBatch_journalEntryId_key" ON "PettyCashBatch"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "PettyCashBatch_organizationId_number_key" ON "PettyCashBatch"("organizationId", "number");

-- AddForeignKey
ALTER TABLE "PettyCashFund" ADD CONSTRAINT "PettyCashFund_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashVoucher" ADD CONSTRAINT "PettyCashVoucher_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashVoucher" ADD CONSTRAINT "PettyCashVoucher_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "PettyCashFund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashVoucher" ADD CONSTRAINT "PettyCashVoucher_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashVoucher" ADD CONSTRAINT "PettyCashVoucher_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PettyCashBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashVoucherLine" ADD CONSTRAINT "PettyCashVoucherLine_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "PettyCashVoucher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashBatch" ADD CONSTRAINT "PettyCashBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PettyCashBatch" ADD CONSTRAINT "PettyCashBatch_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "PettyCashFund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptImage" ADD CONSTRAINT "ReceiptImage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Tag the template's Petty Cash Fund account in existing companies so the app can find it.
UPDATE "Account" a SET "systemRole" = 'PETTY_CASH_FUND'
WHERE a."code" = '1015' AND a."systemRole" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Account" b WHERE b."organizationId" = a."organizationId" AND b."systemRole" = 'PETTY_CASH_FUND');
