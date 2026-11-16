-- Accounts payable, purchasing, approval matrix and AP invoice inbox.
-- Written to be safe to re-run (see scripts/migrate.mjs RERUNNABLE).
-- AlterEnum
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "apInboxAddress" TEXT,
ADD COLUMN IF NOT EXISTS "apInboxToken" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "closeReason" TEXT,
ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
ADD COLUMN IF NOT EXISTS "deliverTo" TEXT,
ADD COLUMN IF NOT EXISTS "deliveryDate" DATE,
ADD COLUMN IF NOT EXISTS "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS "notes" TEXT,
ADD COLUMN IF NOT EXISTS "paymentTermsDays" INTEGER,
ADD COLUMN IF NOT EXISTS "rejectReason" TEXT,
ADD COLUMN IF NOT EXISTS "requestId" TEXT,
ADD COLUMN IF NOT EXISTS "rfqId" TEXT,
ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "submittedById" TEXT,
ADD COLUMN IF NOT EXISTS "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "updatedById" TEXT,
ADD COLUMN IF NOT EXISTS "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "vatInclusive" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApprovalRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "name" TEXT,
    "minAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "approverRole" "Role",
    "approverUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApprovalStep" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "userId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "neededBy" DATE,
    "purpose" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "departmentId" TEXT,
    "costCenterId" TEXT,
    "projectId" TEXT,
    "branchId" TEXT,
    "estimatedTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PurchaseRequestLine" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT,
    "estUnitCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'EXPENSE',
    "accountId" TEXT,

    CONSTRAINT "PurchaseRequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Rfq" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "requestId" TEXT,
    "date" DATE NOT NULL,
    "dueDate" DATE,
    "notes" TEXT,
    "lines" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "awardedQuoteId" TEXT,
    "awardReason" TEXT,
    "purchaseOrderId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rfq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "RfqQuote" (
    "id" TEXT NOT NULL,
    "rfqId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "quoteRef" TEXT,
    "quoteDate" DATE,
    "validUntil" DATE,
    "leadTimeDays" INTEGER,
    "paymentTermsDays" INTEGER,
    "vatInclusive" BOOLEAN NOT NULL DEFAULT true,
    "prices" JSONB NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RfqQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit" TEXT,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "vatType" TEXT NOT NULL DEFAULT 'VATABLE',
    "netAmount" DECIMAL(18,2) NOT NULL,
    "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "category" TEXT NOT NULL DEFAULT 'EXPENSE',
    "accountId" TEXT NOT NULL,
    "dims" JSONB,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "deliveryRef" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "journalEntryId" TEXT,
    "receivedById" TEXT NOT NULL,
    "voidedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "poLineId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "remarks" TEXT,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApBill" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "supplierInvoiceNo" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "date" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "purchaseOrderId" TEXT,
    "memo" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "vatInclusive" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "ewtAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netPayable" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "matchNotes" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledPayDate" DATE,
    "onHold" BOOLEAN NOT NULL DEFAULT false,
    "journalEntryId" TEXT,
    "inboxDocumentId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "voidedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApBill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApBillLine" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'EXPENSE',
    "accountId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "vatType" TEXT NOT NULL DEFAULT 'VATABLE',
    "netAmount" DECIMAL(18,2) NOT NULL,
    "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "ewtTaxCodeId" TEXT,
    "ewtAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "poLineId" TEXT,
    "dims" JSONB,
    "prepaidStart" DATE,
    "prepaidEnd" DATE,

    CONSTRAINT "ApBillLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApPayment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CHECK',
    "checkNo" TEXT,
    "checkDate" DATE,
    "reference" TEXT,
    "memo" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "cashTransactionId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "voidedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApPaymentLine" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "ApPaymentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ApInboxDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fromEmail" TEXT,
    "subject" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileName" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "extraction" JSONB,
    "vendorId" TEXT,
    "purchaseOrderId" TEXT,
    "duplicateOfId" TEXT,
    "error" TEXT,
    "billId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApInboxDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalRule_organizationId_docType_idx" ON "ApprovalRule"("organizationId", "docType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApprovalStep_organizationId_docType_docId_idx" ON "ApprovalStep"("organizationId", "docType", "docId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PurchaseRequest_organizationId_status_idx" ON "PurchaseRequest"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseRequest_organizationId_number_key" ON "PurchaseRequest"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Rfq_organizationId_number_key" ON "Rfq"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RfqQuote_rfqId_vendorId_key" ON "RfqQuote"("rfqId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "GoodsReceipt_organizationId_number_key" ON "GoodsReceipt"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ApBill_inboxDocumentId_key" ON "ApBill"("inboxDocumentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApBill_organizationId_vendorId_status_idx" ON "ApBill"("organizationId", "vendorId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApBill_organizationId_status_dueDate_idx" ON "ApBill"("organizationId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ApBill_organizationId_number_key" ON "ApBill"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ApPayment_cashTransactionId_key" ON "ApPayment"("cashTransactionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApPayment_organizationId_vendorId_status_idx" ON "ApPayment"("organizationId", "vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ApPayment_organizationId_number_key" ON "ApPayment"("organizationId", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApInboxDocument_organizationId_status_idx" ON "ApInboxDocument"("organizationId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ApInboxDocument_organizationId_sha256_idx" ON "ApInboxDocument"("organizationId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_apInboxToken_key" ON "Organization"("apInboxToken");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseOrder_requestId_fkey') THEN
    ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PurchaseRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseRequestLine_requestId_fkey') THEN
    ALTER TABLE "PurchaseRequestLine" ADD CONSTRAINT "PurchaseRequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PurchaseRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Rfq_requestId_fkey') THEN
    ALTER TABLE "Rfq" ADD CONSTRAINT "Rfq_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "PurchaseRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RfqQuote_rfqId_fkey') THEN
    ALTER TABLE "RfqQuote" ADD CONSTRAINT "RfqQuote_rfqId_fkey" FOREIGN KEY ("rfqId") REFERENCES "Rfq"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseOrderLine_purchaseOrderId_fkey') THEN
    ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GoodsReceipt_purchaseOrderId_fkey') THEN
    ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GoodsReceiptLine_receiptId_fkey') THEN
    ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GoodsReceiptLine_poLineId_fkey') THEN
    ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApBillLine_billId_fkey') THEN
    ALTER TABLE "ApBillLine" ADD CONSTRAINT "ApBillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "ApBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApBillLine_poLineId_fkey') THEN
    ALTER TABLE "ApBillLine" ADD CONSTRAINT "ApBillLine_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApPaymentLine_paymentId_fkey') THEN
    ALTER TABLE "ApPaymentLine" ADD CONSTRAINT "ApPaymentLine_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ApPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApPaymentLine_billId_fkey') THEN
    ALTER TABLE "ApPaymentLine" ADD CONSTRAINT "ApPaymentLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "ApBill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

