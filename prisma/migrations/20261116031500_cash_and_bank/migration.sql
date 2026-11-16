-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CURRENT',
    "bankName" TEXT,
    "branchName" TEXT,
    "accountNumber" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "glAccountId" TEXT NOT NULL,
    "custodian" TEXT,
    "fundLimit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "nextCheckNo" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "toBankAccountId" TEXT,
    "date" DATE NOT NULL,
    "payee" TEXT,
    "partyType" TEXT,
    "partyId" TEXT,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "checkNo" TEXT,
    "checkDate" DATE,
    "checkReleasedAt" DATE,
    "reference" TEXT,
    "memo" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "fxRate" DECIMAL(18,6) NOT NULL DEFAULT 1,
    "amount" DECIMAL(18,2) NOT NULL,
    "toAmount" DECIMAL(18,2),
    "toFxRate" DECIMAL(18,6),
    "withholdingTaxCodeId" TEXT,
    "withholdingAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lines" JSONB NOT NULL,
    "isReplenishment" BOOLEAN NOT NULL DEFAULT false,
    "replenishedById" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "periodFrom" DATE NOT NULL,
    "periodTo" DATE NOT NULL,
    "openingBalance" DECIMAL(18,2) NOT NULL,
    "closingBalance" DECIMAL(18,2) NOT NULL,
    "fileName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reconciledById" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementLine" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "checkNo" TEXT,
    "amount" DECIMAL(18,2) NOT NULL,
    "runningBalance" DECIMAL(18,2),
    "fingerprint" TEXT NOT NULL,
    "matchId" TEXT,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankMatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_organizationId_code_key" ON "BankAccount"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_organizationId_glAccountId_key" ON "BankAccount"("organizationId", "glAccountId");

-- CreateIndex
CREATE INDEX "CashTransaction_organizationId_bankAccountId_idx" ON "CashTransaction"("organizationId", "bankAccountId");

-- CreateIndex
CREATE INDEX "CashTransaction_organizationId_type_status_idx" ON "CashTransaction"("organizationId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CashTransaction_organizationId_number_key" ON "CashTransaction"("organizationId", "number");

-- CreateIndex
CREATE INDEX "BankStatement_organizationId_bankAccountId_periodTo_idx" ON "BankStatement"("organizationId", "bankAccountId", "periodTo");

-- CreateIndex
CREATE INDEX "BankStatementLine_organizationId_bankAccountId_matchId_idx" ON "BankStatementLine"("organizationId", "bankAccountId", "matchId");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementLine_bankAccountId_fingerprint_key" ON "BankStatementLine"("bankAccountId", "fingerprint");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_accountId_clearedAt_idx" ON "JournalLine"("organizationId", "accountId", "clearedAt");

-- CreateIndex
CREATE INDEX "JournalLine_clearingRef_idx" ON "JournalLine"("clearingRef");

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "BankMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
