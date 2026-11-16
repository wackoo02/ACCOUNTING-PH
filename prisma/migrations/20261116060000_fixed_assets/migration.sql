-- Fixed assets module. Written to be safe to re-run (see scripts/migrate.mjs RERUNNABLE).
-- AlterTable
ALTER TABLE "FixedAsset" ADD COLUMN IF NOT EXISTS "accumDepAccountCode" TEXT,
ADD COLUMN IF NOT EXISTS "accumulatedDepreciation" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "categoryCode" TEXT,
ADD COLUMN IF NOT EXISTS "costCenterCode" TEXT,
ADD COLUMN IF NOT EXISTS "depExpenseAccountCode" TEXT,
ADD COLUMN IF NOT EXISTS "departmentCode" TEXT,
ADD COLUMN IF NOT EXISTS "depreciatedThrough" DATE,
ADD COLUMN IF NOT EXISTS "depreciationMethod" TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
ADD COLUMN IF NOT EXISTS "disposedAt" DATE,
ADD COLUMN IF NOT EXISTS "inServiceDate" DATE,
ADD COLUMN IF NOT EXISTS "poNumber" TEXT,
ADD COLUMN IF NOT EXISTS "salvageValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "usefulLifeMonths" INTEGER,
ADD COLUMN IF NOT EXISTS "vendorCode" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "AssetCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT,
    "assetAccountCode" TEXT NOT NULL,
    "accumDepAccountCode" TEXT,
    "depExpenseAccountCode" TEXT,
    "usefulLifeMonths" INTEGER NOT NULL DEFAULT 60,
    "depreciationMethod" TEXT NOT NULL DEFAULT 'STRAIGHT_LINE',
    "salvagePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "FixedAssetTxn" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "costChange" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "accumChange" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "depreciation" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "proceeds" DECIMAL(18,2),
    "gainLoss" DECIMAL(18,2),
    "lifeChangeMonths" INTEGER,
    "details" JSONB,
    "memo" TEXT,
    "reference" TEXT,
    "journalEntryId" TEXT,
    "runId" TEXT,
    "prevDepreciatedThrough" DATE,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedAssetTxn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "DepreciationRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "periodEnd" DATE NOT NULL,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "assetCount" INTEGER NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedById" TEXT,
    "reversedAt" TIMESTAMP(3),

    CONSTRAINT "DepreciationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AssetCategory_organizationId_code_key" ON "AssetCategory"("organizationId", "code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FixedAssetTxn_organizationId_assetId_idx" ON "FixedAssetTxn"("organizationId", "assetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FixedAssetTxn_organizationId_date_idx" ON "FixedAssetTxn"("organizationId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FixedAssetTxn_runId_idx" ON "FixedAssetTxn"("runId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "FixedAssetTxn_organizationId_number_key" ON "FixedAssetTxn"("organizationId", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DepreciationRun_organizationId_year_month_idx" ON "DepreciationRun"("organizationId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DepreciationRun_organizationId_number_key" ON "DepreciationRun"("organizationId", "number");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "FixedAssetTxn" ADD CONSTRAINT "FixedAssetTxn_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "FixedAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- Existing register rows (from the asset audit release): depreciation starts at acquisition,
-- category name doubles as the category for reports, and each asset gets an opening entry
-- for its cost so the rollforward ties to the register.
UPDATE "FixedAsset" SET "inServiceDate" = "acquisitionDate" WHERE "inServiceDate" IS NULL AND "acquisitionDate" IS NOT NULL;
INSERT INTO "FixedAssetTxn" ("id", "organizationId", "assetId", "number", "type", "date", "costChange", "memo", "createdById")
SELECT 'fao_' || a."id", a."organizationId", a."id", 'FAO-' || a."code", 'OPENING', COALESCE(a."acquisitionDate", a."createdAt"::date), a."cost", 'Opening balance (register before the Fixed Assets module)', 'system'
FROM "FixedAsset" a
WHERE a."cost" <> 0 AND NOT EXISTS (SELECT 1 FROM "FixedAssetTxn" t WHERE t."assetId" = a."id")
ON CONFLICT DO NOTHING;

-- Gain / loss on disposal accounts for existing companies (new companies get them from the chart template).
UPDATE "Account" a SET "systemRole" = 'FA_DISPOSAL_GAIN'
WHERE a."code" = '7030' AND a."systemRole" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "Account" x WHERE x."organizationId" = a."organizationId" AND x."systemRole" = 'FA_DISPOSAL_GAIN');
INSERT INTO "Account" ("id", "organizationId", "code", "name", "type", "ifrsGroup", "normalBalance", "parentId", "isPostable", "systemRole")
SELECT 'acc_fal_' || p."organizationId", p."organizationId", '7545', 'Loss on Disposal of Property and Equipment', 'EXPENSE', 'Other expenses', 'DEBIT', p."id", true, 'FA_DISPOSAL_LOSS'
FROM "Account" p
WHERE p."code" = '7000'
  AND NOT EXISTS (SELECT 1 FROM "Account" x WHERE x."organizationId" = p."organizationId" AND (x."code" = '7545' OR x."systemRole" = 'FA_DISPOSAL_LOSS'))
ON CONFLICT DO NOTHING;

-- Starter asset categories for existing companies whose chart has the standard PPE accounts.
INSERT INTO "AssetCategory" ("id", "organizationId", "code", "name", "prefix", "assetAccountCode", "accumDepAccountCode", "depExpenseAccountCode", "usefulLifeMonths", "depreciationMethod")
SELECT 'cat_' || lower(c.code) || '_' || o."id", o."id", c.code, c.name, c.prefix, c.asset, c.accum, c.exp, c.life, c.method
FROM "Organization" o
CROSS JOIN (VALUES
  ('LAND', 'Land', 'LND', '1510', NULL, NULL, 1, 'NONE'),
  ('BLDG', 'Building', 'BLD', '1520', '1525', '6090', 240, 'STRAIGHT_LINE'),
  ('IT', 'IT equipment', 'IT', '1530', '1535', '6090', 36, 'STRAIGHT_LINE'),
  ('OFFEQ', 'Office equipment', 'OE', '1530', '1535', '6090', 60, 'STRAIGHT_LINE'),
  ('VEH', 'Vehicles', 'VEH', '1540', '1545', '6090', 60, 'STRAIGHT_LINE'),
  ('FURN', 'Furniture and fixtures', 'FF', '1550', '1555', '6090', 60, 'STRAIGHT_LINE')
) AS c(code, name, prefix, asset, accum, exp, life, method)
WHERE EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = o."id" AND a."code" = c.asset)
  AND (c.accum IS NULL OR EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = o."id" AND a."code" = c.accum))
  AND (c.exp IS NULL OR EXISTS (SELECT 1 FROM "Account" a WHERE a."organizationId" = o."id" AND a."code" = c.exp))
ON CONFLICT DO NOTHING;
