-- BIR tax engine. Written to be safe to re-run (see scripts/migrate.mjs RERUNNABLE).
-- AlterTable
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "tradeName" TEXT,
ADD COLUMN IF NOT EXISTS "zipCode" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "TaxEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "journalEntryId" TEXT,
    "journalLineId" TEXT,
    "source" "JournalSource" NOT NULL,
    "sourceId" TEXT,
    "sourceRef" TEXT,
    "kind" TEXT NOT NULL,
    "vatClass" TEXT,
    "taxCodeId" TEXT,
    "atcCode" TEXT,
    "rate" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "taxBase" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "date" DATE NOT NULL,
    "docType" TEXT,
    "docNumber" TEXT,
    "description" TEXT,
    "partyType" TEXT,
    "partyId" TEXT,
    "partyTin" TEXT,
    "partyName" TEXT,
    "partyLastName" TEXT,
    "partyFirstName" TEXT,
    "partyMiddleName" TEXT,
    "partyAddress" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TaxReturn" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "amended" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "inputs" JSONB NOT NULL DEFAULT '{}',
    "figures" JSONB,
    "taxDue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "filedAt" DATE,
    "filingRef" TEXT,
    "amountPaid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "paymentRef" TEXT,
    "journalEntryId" TEXT,
    "filedById" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TaxEntry_organizationId_kind_date_idx" ON "TaxEntry"("organizationId", "kind", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TaxEntry_journalEntryId_idx" ON "TaxEntry"("journalEntryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TaxEntry_journalLineId_idx" ON "TaxEntry"("journalLineId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TaxEntry_organizationId_source_sourceId_sourceRef_key" ON "TaxEntry"("organizationId", "source", "sourceId", "sourceRef");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TaxReturn_organizationId_form_periodTo_idx" ON "TaxReturn"("organizationId", "form", "periodTo");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TaxReturn_organizationId_form_periodFrom_amended_key" ON "TaxReturn"("organizationId", "form", "periodFrom", "amended");


-- New tax accounts for companies created before this release (new companies get them from the template).
INSERT INTO "Account" ("id","organizationId","code","name","type","ifrsGroup","isCurrent","normalBalance","parentId","isPostable","allowManualPosting","isActive","systemRole","createdAt")
SELECT 'tx' || md5(o."id" || n.code), o."id", n.code, n.name, n.type::"AccountType", n.grp, true, n.nb::"NormalBalance",
       (SELECT p."id" FROM "Account" p WHERE p."organizationId" = o."id" AND p."code" = n.parent), true, true, true, n.role, CURRENT_TIMESTAMP
FROM "Organization" o
CROSS JOIN (VALUES
  ('1322', 'Creditable VAT Withheld (BIR 2307)', 'ASSET', 'Prepayments and other current assets', 'DEBIT', '1000', 'CVAT_WITHHELD'),
  ('2046', 'Withholding Tax Payable - Final (1601-FQ / 0619-F)', 'LIABILITY', 'Trade and other payables', 'CREDIT', '2000', 'FWT_PAYABLE'),
  ('2047', 'Percentage Tax Payable (2551Q)', 'LIABILITY', 'Trade and other payables', 'CREDIT', '2000', 'PERCENTAGE_TAX_PAYABLE')
) AS n(code, name, type, grp, nb, parent, role)
WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = o."id" AND (a."code" = n.code OR a."systemRole" = n.role));

UPDATE "TaxCode" t SET "accountCode" = '2046' WHERE t."code" = 'FWT10-DIV' AND t."accountCode" IS NULL
  AND EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = t."organizationId" AND a."code" = '2046');
UPDATE "TaxCode" t SET "accountCode" = '2047' WHERE t."code" = 'PT3' AND t."accountCode" IS NULL
  AND EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = t."organizationId" AND a."code" = '2047');
