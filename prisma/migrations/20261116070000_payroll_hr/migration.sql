-- Payroll and HR. Written to be safe to re-run if a deploy stops partway (see scripts/migrate.mjs).
-- AlterEnum
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'EMPLOYEE';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN IF NOT EXISTS "address" TEXT,
ADD COLUMN IF NOT EXISTS "bankAccountNo" TEXT,
ADD COLUMN IF NOT EXISTS "birthDate" DATE,
ADD COLUMN IF NOT EXISTS "costCenter" TEXT,
ADD COLUMN IF NOT EXISTS "managerId" TEXT,
ADD COLUMN IF NOT EXISTS "minimumWageEarner" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "separationDate" DATE,
ADD COLUMN IF NOT EXISTS "shiftId" TEXT,
ADD COLUMN IF NOT EXISTS "userId" TEXT,
ADD COLUMN IF NOT EXISTS "workDaysPerYear" INTEGER NOT NULL DEFAULT 261;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Shift" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 60,
    "graceMinutes" INTEGER NOT NULL DEFAULT 0,
    "restDays" TEXT NOT NULL DEFAULT '0,6',
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Holiday" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "TimeLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "timeIn" TIMESTAMP(3),
    "timeOut" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'PORTAL',
    "note" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LeaveType" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "annualCredits" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "requiresBalance" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "LeaveType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "LeaveCredit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "leaveTypeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,

    CONSTRAINT "LeaveCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "HrRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dateFrom" DATE NOT NULL,
    "dateTo" DATE NOT NULL,
    "leaveTypeId" TEXT,
    "halfDay" BOOLEAN NOT NULL DEFAULT false,
    "days" DECIMAL(6,2),
    "minutes" INTEGER,
    "timeIn" TIMESTAMP(3),
    "timeOut" TIMESTAMP(3),
    "shiftId" TEXT,
    "restDay" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "approverId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HrRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "EmployeePayItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "runId" TEXT,
    "kind" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "deMinimisCode" TEXT,
    "balance" DECIMAL(18,2),
    "startDate" DATE,
    "endDate" DATE,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeePayItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "PayrollRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'REGULAR',
    "frequency" TEXT NOT NULL DEFAULT 'SEMI_MONTHLY',
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "payDate" DATE NOT NULL,
    "deductContributions" BOOLEAN NOT NULL DEFAULT true,
    "yearEndAdjustment" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "memo" TEXT,
    "computedAt" TIMESTAMP(3),
    "preparedById" TEXT NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "finalizedById" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "journalEntryId" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "paidAt" TIMESTAMP(3),
    "paymentEntryId" TEXT,
    "paymentBankAccountId" TEXT,
    "returnReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Payslip" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "department" TEXT,
    "costCenter" TEXT,
    "position" TEXT,
    "payBasis" TEXT NOT NULL,
    "basicRate" DECIMAL(18,2) NOT NULL,
    "dailyRate" DECIMAL(18,2) NOT NULL,
    "hourlyRate" DECIMAL(18,4) NOT NULL,
    "minimumWageEarner" BOOLEAN NOT NULL DEFAULT false,
    "attendance" JSONB NOT NULL,
    "earnings" JSONB NOT NULL,
    "deductions" JSONB NOT NULL,
    "employer" JSONB NOT NULL,
    "gross" DECIMAL(18,2) NOT NULL,
    "basicPay" DECIMAL(18,2) NOT NULL,
    "sssCompensation" DECIMAL(18,2) NOT NULL,
    "taxableEarnings" DECIMAL(18,2) NOT NULL,
    "nonTaxable" DECIMAL(18,2) NOT NULL,
    "exemptBenefits" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "thirteenthPay" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "sssEE" DECIMAL(18,2) NOT NULL,
    "sssER" DECIMAL(18,2) NOT NULL,
    "sssEC" DECIMAL(18,2) NOT NULL,
    "mpfEE" DECIMAL(18,2) NOT NULL,
    "mpfER" DECIMAL(18,2) NOT NULL,
    "phicEE" DECIMAL(18,2) NOT NULL,
    "phicER" DECIMAL(18,2) NOT NULL,
    "hdmfEE" DECIMAL(18,2) NOT NULL,
    "hdmfER" DECIMAL(18,2) NOT NULL,
    "taxableIncome" DECIMAL(18,2) NOT NULL,
    "withholdingTax" DECIMAL(18,2) NOT NULL,
    "otherDeductions" DECIMAL(18,2) NOT NULL,
    "netPay" DECIMAL(18,2) NOT NULL,
    "employerCost" DECIMAL(18,2) NOT NULL,
    "warnings" JSONB,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Form2316" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "data" JSONB NOT NULL,
    "finalizedById" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Form2316_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Shift_organizationId_code_key" ON "Shift"("organizationId", "code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Holiday_organizationId_date_idx" ON "Holiday"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Holiday_organizationId_date_name_key" ON "Holiday"("organizationId", "date", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TimeLog_organizationId_date_idx" ON "TimeLog"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TimeLog_employeeId_date_key" ON "TimeLog"("employeeId", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LeaveType_organizationId_code_key" ON "LeaveType"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "LeaveCredit_employeeId_leaveTypeId_year_key" ON "LeaveCredit"("employeeId", "leaveTypeId", "year");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HrRequest_organizationId_status_idx" ON "HrRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HrRequest_employeeId_dateFrom_idx" ON "HrRequest"("employeeId", "dateFrom");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "HrRequest_approverId_status_idx" ON "HrRequest"("approverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "HrRequest_organizationId_number_key" ON "HrRequest"("organizationId", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmployeePayItem_organizationId_employeeId_idx" ON "EmployeePayItem"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmployeePayItem_runId_idx" ON "EmployeePayItem"("runId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PayrollRun_organizationId_periodEnd_idx" ON "PayrollRun"("organizationId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollRun_organizationId_number_key" ON "PayrollRun"("organizationId", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Payslip_organizationId_employeeId_idx" ON "Payslip"("organizationId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Payslip_runId_employeeId_key" ON "Payslip"("runId", "employeeId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Form2316_organizationId_year_idx" ON "Form2316"("organizationId", "year");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Form2316_employeeId_year_key" ON "Form2316"("employeeId", "year");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Employee_organizationId_managerId_idx" ON "Employee"("organizationId", "managerId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Employee_organizationId_userId_key" ON "Employee"("organizationId", "userId");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Employee" ADD CONSTRAINT "Employee_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Employee" ADD CONSTRAINT "Employee_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "TimeLog" ADD CONSTRAINT "TimeLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LeaveCredit" ADD CONSTRAINT "LeaveCredit_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "LeaveCredit" ADD CONSTRAINT "LeaveCredit_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "HrRequest" ADD CONSTRAINT "HrRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "EmployeePayItem" ADD CONSTRAINT "EmployeePayItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

