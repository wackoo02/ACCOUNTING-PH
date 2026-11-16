-- Receivables and billing. Written to be safe to re-run (see scripts/migrate.mjs RERUNNABLE).

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "businessStyle" TEXT,
ADD COLUMN IF NOT EXISTS "invoiceEmails" TEXT;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "tradeName" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "DocumentSeries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "startNo" INTEGER NOT NULL DEFAULT 1,
    "endNo" INTEGER,
    "nextNo" INTEGER NOT NULL DEFAULT 1,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "branchCode" TEXT NOT NULL DEFAULT '00000',
    "authorityType" TEXT NOT NULL DEFAULT 'ATP',
    "authorityNo" TEXT,
    "authorityDate" DATE,
    "validUntil" DATE,
    "printerName" TEXT,
    "printerTin" TEXT,
    "printerAddress" TEXT,
    "printerAccreditationNo" TEXT,
    "printerAccreditationDate" DATE,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SalesInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'INVOICE',
    "number" TEXT,
    "seriesId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerTin" TEXT,
    "customerAddress" TEXT,
    "customerBusinessStyle" TEXT,
    "date" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "termsDays" INTEGER NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT false,
    "reference" TEXT,
    "memo" TEXT,
    "vatableSales" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "zeroRatedSales" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "exemptSales" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "ewtTaxCodeId" TEXT,
    "ewtAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "appliedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "creditForId" TEXT,
    "reason" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "sourceRef" TEXT,
    "contractId" TEXT,
    "journalEntryId" TEXT,
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
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "SalesInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "unit" TEXT,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "discount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatType" TEXT NOT NULL DEFAULT 'VATABLE',
    "accountId" TEXT NOT NULL,
    "netAmount" DECIMAL(18,2) NOT NULL,
    "vatAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "dims" JSONB,

    CONSTRAINT "SalesInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ArReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT,
    "seriesId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CHECK',
    "checkNo" TEXT,
    "checkDate" DATE,
    "checkBank" TEXT,
    "reference" TEXT,
    "memo" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "cashAmount" DECIMAL(18,2) NOT NULL,
    "withholdingTaxCodeId" TEXT,
    "withholdingAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "plan" JSONB NOT NULL,
    "appliedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
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
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "ArApplication" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "receiptId" TEXT,
    "creditMemoId" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" DATE NOT NULL,
    "journalEntryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BillingContract" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "frequency" TEXT,
    "nextBillDate" DATE,
    "termsDays" INTEGER,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "contractValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT false,
    "ewtTaxCodeId" TEXT,
    "lines" JSONB NOT NULL,
    "autoSubmit" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "invoiceCount" INTEGER NOT NULL DEFAULT 0,
    "lastBilledAt" TIMESTAMP(3),
    "memo" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "BillingMilestone" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "percent" DECIMAL(7,4),
    "amount" DECIMAL(18,2) NOT NULL,
    "dueDate" DATE,
    "vatType" TEXT NOT NULL DEFAULT 'VATABLE',
    "accountId" TEXT,
    "invoiceId" TEXT,
    "billedAt" TIMESTAMP(3),

    CONSTRAINT "BillingMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DocumentEmail" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "sentById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DocumentSeries_organizationId_docType_idx" ON "DocumentSeries"("organizationId", "docType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SalesInvoice_organizationId_customerId_status_idx" ON "SalesInvoice"("organizationId", "customerId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "SalesInvoice_organizationId_kind_status_date_idx" ON "SalesInvoice"("organizationId", "kind", "status", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SalesInvoice_organizationId_kind_number_key" ON "SalesInvoice"("organizationId", "kind", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ArReceipt_organizationId_customerId_status_idx" ON "ArReceipt"("organizationId", "customerId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ArApplication_organizationId_invoiceId_idx" ON "ArApplication"("organizationId", "invoiceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ArApplication_receiptId_idx" ON "ArApplication"("receiptId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ArApplication_creditMemoId_idx" ON "ArApplication"("creditMemoId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BillingContract_organizationId_number_key" ON "BillingContract"("organizationId", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DocumentEmail_organizationId_docType_docId_idx" ON "DocumentEmail"("organizationId", "docType", "docId");

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesInvoiceLine_invoiceId_fkey') THEN ALTER TABLE "SalesInvoiceLine" ADD CONSTRAINT "SalesInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SalesInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ArApplication_receiptId_fkey') THEN ALTER TABLE "ArApplication" ADD CONSTRAINT "ArApplication_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "ArReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE; END IF; END $$;

-- AddForeignKey
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillingMilestone_contractId_fkey') THEN ALTER TABLE "BillingMilestone" ADD CONSTRAINT "BillingMilestone_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "BillingContract"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;


-- System roles the receivables module looks up: customer advances and sales returns.
UPDATE "Account" a SET "systemRole" = 'CUSTOMER_ADVANCES'
WHERE a."code" = '2090' AND a."systemRole" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Account" b WHERE b."organizationId" = a."organizationId" AND b."systemRole" = 'CUSTOMER_ADVANCES');
UPDATE "Account" a SET "systemRole" = 'SALES_RETURNS'
WHERE a."code" = '4030' AND a."systemRole" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Account" b WHERE b."organizationId" = a."organizationId" AND b."systemRole" = 'SALES_RETURNS');
