-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'ACCOUNTANT', 'BOOKKEEPER', 'VIEWER');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "NormalBalance" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'CLOSED', 'LOCKED');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID');

-- CreateEnum
CREATE TYPE "JournalSource" AS ENUM ('MANUAL', 'OPENING_BALANCE', 'SALES', 'PURCHASES', 'BANK', 'INVENTORY', 'PAYROLL', 'EXPENSE_CLAIM', 'TAX', 'CLOSING', 'REVERSAL', 'INTERCOMPANY', 'CONSOLIDATION', 'FX_REVALUATION');

-- CreateEnum
CREATE TYPE "LedgerBook" AS ENUM ('STATUTORY', 'CONSOLIDATION');

-- CreateEnum
CREATE TYPE "DimensionType" AS ENUM ('DEPARTMENT', 'BRANCH', 'BUSINESS_UNIT', 'PROJECT', 'COST_CENTER', 'PROFIT_CENTER', 'LOCATION', 'PRODUCT_LINE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "tin" TEXT,
    "rdoCode" TEXT,
    "registeredAddress" TEXT,
    "vatRegistered" BOOLEAN NOT NULL DEFAULT true,
    "baseCurrency" TEXT NOT NULL DEFAULT 'PHP',
    "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 1,
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "segregationOfDuties" BOOLEAN NOT NULL DEFAULT true,
    "parentId" TEXT,
    "entityType" TEXT NOT NULL DEFAULT 'COMPANY',
    "ownershipPct" DECIMAL(5,2) NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "approvalLimit" DECIMAL(18,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeOrganizationId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "ifrsGroup" TEXT NOT NULL,
    "isCurrent" BOOLEAN,
    "normalBalance" "NormalBalance" NOT NULL,
    "parentId" TEXT,
    "isPostable" BOOLEAN NOT NULL DEFAULT true,
    "allowManualPosting" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "systemRole" TEXT,
    "currencyCode" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalYear" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closingEntryId" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,

    CONSTRAINT "FiscalYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalPeriod" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,

    CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "transactionDate" DATE NOT NULL,
    "memo" TEXT NOT NULL,
    "reference" TEXT,
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "book" "LedgerBook" NOT NULL DEFAULT 'STATUTORY',
    "source" "JournalSource" NOT NULL DEFAULT 'MANUAL',
    "autoReverseOn" DATE,
    "sourceId" TEXT,
    "reversalOfId" TEXT,
    "intercompanyGroupId" TEXT,
    "totalDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "description" TEXT,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "fxDebit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "fxCredit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "partyType" TEXT,
    "partyId" TEXT,
    "departmentId" TEXT,
    "branchId" TEXT,
    "businessUnitId" TEXT,
    "projectId" TEXT,
    "costCenterId" TEXT,
    "profitCenterId" TEXT,
    "locationId" TEXT,
    "productLineId" TEXT,
    "intercompanyOrgId" TEXT,
    "clearedAt" TIMESTAMP(3),
    "clearingRef" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalAttachment" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "details" JSONB,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Currency" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT,
    "rateToBase" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Currency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'GOODS',
    "unit" TEXT,
    "sellingPrice" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "purchaseCost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "vatType" TEXT NOT NULL DEFAULT 'VATABLE',
    "salesAccountCode" TEXT,
    "expenseAccountCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "middleName" TEXT,
    "position" TEXT,
    "department" TEXT,
    "email" TEXT,
    "tin" TEXT,
    "sssNo" TEXT,
    "philhealthNo" TEXT,
    "pagibigNo" TEXT,
    "dateHired" DATE,
    "employmentStatus" TEXT,
    "payBasis" TEXT,
    "basicRate" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "isPartner" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tin" TEXT,
    "address" TEXT,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "vatRegistered" BOOLEAN NOT NULL DEFAULT true,
    "ewtRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "atcCode" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tin" TEXT,
    "address" TEXT,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 30,
    "creditLimit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "vatRegistered" BOOLEAN NOT NULL DEFAULT true,
    "withholdsTax" BOOLEAN NOT NULL DEFAULT false,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DimensionValue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "DimensionType" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "manager" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DimensionValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fiscalYear" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "dimensionValueId" TEXT,
    "m1" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m2" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m3" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m4" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m5" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m6" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m7" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m8" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m9" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m10" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m11" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "m12" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntercompanyLink" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "counterpartyOrgId" TEXT NOT NULL,
    "dueFromAccountId" TEXT NOT NULL,
    "dueToAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntercompanyLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_code_key" ON "Organization"("code");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_organizationId_key" ON "Membership"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Account_organizationId_type_idx" ON "Account"("organizationId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Account_organizationId_code_key" ON "Account"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Account_organizationId_systemRole_key" ON "Account"("organizationId", "systemRole");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalYear_organizationId_year_key" ON "FiscalYear"("organizationId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriod_organizationId_year_month_key" ON "FiscalPeriod"("organizationId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversalOfId_key" ON "JournalEntry"("reversalOfId");

-- CreateIndex
CREATE INDEX "JournalEntry_organizationId_date_idx" ON "JournalEntry"("organizationId", "date");

-- CreateIndex
CREATE INDEX "JournalEntry_organizationId_source_sourceId_idx" ON "JournalEntry"("organizationId", "source", "sourceId");

-- CreateIndex
CREATE INDEX "JournalEntry_intercompanyGroupId_idx" ON "JournalEntry"("intercompanyGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_organizationId_number_key" ON "JournalEntry"("organizationId", "number");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_accountId_idx" ON "JournalLine"("organizationId", "accountId");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_departmentId_idx" ON "JournalLine"("organizationId", "departmentId");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_branchId_idx" ON "JournalLine"("organizationId", "branchId");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_projectId_idx" ON "JournalLine"("organizationId", "projectId");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_costCenterId_idx" ON "JournalLine"("organizationId", "costCenterId");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_profitCenterId_idx" ON "JournalLine"("organizationId", "profitCenterId");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_partyType_partyId_idx" ON "JournalLine"("organizationId", "partyType", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSequence_organizationId_key_key" ON "DocumentSequence"("organizationId", "key");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_entity_entityId_idx" ON "AuditLog"("organizationId", "entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Currency_organizationId_code_key" ON "Currency"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Product_organizationId_code_key" ON "Product"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_organizationId_code_key" ON "Employee"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_organizationId_code_key" ON "Vendor"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_organizationId_code_key" ON "Customer"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DimensionValue_organizationId_type_code_key" ON "DimensionValue"("organizationId", "type", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_organizationId_fiscalYear_accountId_dimensionValueId_key" ON "Budget"("organizationId", "fiscalYear", "accountId", "dimensionValueId");

-- CreateIndex
CREATE UNIQUE INDEX "IntercompanyLink_organizationId_counterpartyOrgId_key" ON "IntercompanyLink"("organizationId", "counterpartyOrgId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalPeriod" ADD CONSTRAINT "FiscalPeriod_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_businessUnitId_fkey" FOREIGN KEY ("businessUnitId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_profitCenterId_fkey" FOREIGN KEY ("profitCenterId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_productLineId_fkey" FOREIGN KEY ("productLineId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalAttachment" ADD CONSTRAINT "JournalAttachment_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSequence" ADD CONSTRAINT "DocumentSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Currency" ADD CONSTRAINT "Currency_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DimensionValue" ADD CONSTRAINT "DimensionValue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DimensionValue" ADD CONSTRAINT "DimensionValue_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DimensionValue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntercompanyLink" ADD CONSTRAINT "IntercompanyLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntercompanyLink" ADD CONSTRAINT "IntercompanyLink_counterpartyOrgId_fkey" FOREIGN KEY ("counterpartyOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
