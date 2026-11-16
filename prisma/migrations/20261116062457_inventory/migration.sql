-- Inventory and warehouse (PAS 2). Written to be safe to re-run (see scripts/migrate.mjs).
-- AlterTable
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "barcode" TEXT,
ADD COLUMN IF NOT EXISTS "category" TEXT,
ADD COLUMN IF NOT EXISTS "cogsAccountCode" TEXT,
ADD COLUMN IF NOT EXISTS "costingMethod" TEXT NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
ADD COLUMN IF NOT EXISTS "defaultLocationCode" TEXT,
ADD COLUMN IF NOT EXISTS "defaultVendorCode" TEXT,
ADD COLUMN IF NOT EXISTS "defaultWarehouseCode" TEXT,
ADD COLUMN IF NOT EXISTS "inventoryAccountCode" TEXT,
ADD COLUMN IF NOT EXISTS "isStocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "reorderPoint" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "reorderQty" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "standardCost" DECIMAL(18,6) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "Warehouse" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "branchCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WarehouseLocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "WarehouseLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InventoryTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "toWarehouseId" TEXT,
    "partyType" TEXT,
    "partyId" TEXT,
    "reference" TEXT,
    "memo" TEXT NOT NULL,
    "offsetAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "sourceModule" TEXT,
    "sourceId" TEXT,
    "countId" TEXT,
    "totalValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "voidedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "voidJournalId" TEXT,

    CONSTRAINT "InventoryTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InventoryTransactionLine" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemId" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,6),
    "locationId" TEXT,
    "toLocationId" TEXT,
    "lotNo" TEXT,
    "accountId" TEXT,
    "dims" JSONB,
    "description" TEXT,
    "value" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "InventoryTransactionLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InventoryLayer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT,
    "lotNo" TEXT,
    "receivedDate" DATE NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "qtyIn" DECIMAL(18,4) NOT NULL,
    "qtyRemaining" DECIMAL(18,4) NOT NULL,
    "valueIn" DECIMAL(18,2) NOT NULL,
    "valueRemaining" DECIMAL(18,2) NOT NULL,
    "sourceLineId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InventoryMove" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "locationId" TEXT,
    "layerId" TEXT,
    "date" DATE NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "type" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMove_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InventoryBalance" (
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "value" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("itemId","warehouseId")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InventoryCount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "memo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "adjustmentId" TEXT,

    CONSTRAINT "InventoryCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "InventoryCountLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "locationId" TEXT,
    "lotNo" TEXT,
    "systemQty" DECIMAL(18,4) NOT NULL,
    "countedQty" DECIMAL(18,4),
    "note" TEXT,

    CONSTRAINT "InventoryCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Warehouse_organizationId_code_key" ON "Warehouse"("organizationId", "code");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WarehouseLocation_organizationId_idx" ON "WarehouseLocation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "WarehouseLocation_warehouseId_code_key" ON "WarehouseLocation"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryTransaction_countId_key" ON "InventoryTransaction"("countId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryTransaction_journalEntryId_key" ON "InventoryTransaction"("journalEntryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryTransaction_organizationId_type_date_idx" ON "InventoryTransaction"("organizationId", "type", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryTransaction_organizationId_sourceModule_sourceId_idx" ON "InventoryTransaction"("organizationId", "sourceModule", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryTransaction_organizationId_number_key" ON "InventoryTransaction"("organizationId", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryTransactionLine_itemId_idx" ON "InventoryTransactionLine"("itemId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryLayer_organizationId_itemId_warehouseId_idx" ON "InventoryLayer"("organizationId", "itemId", "warehouseId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryLayer_sourceLineId_idx" ON "InventoryLayer"("sourceLineId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryMove_organizationId_itemId_warehouseId_date_idx" ON "InventoryMove"("organizationId", "itemId", "warehouseId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryMove_organizationId_date_idx" ON "InventoryMove"("organizationId", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryMove_transactionId_idx" ON "InventoryMove"("transactionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryBalance_organizationId_idx" ON "InventoryBalance"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "InventoryCount_organizationId_number_key" ON "InventoryCount"("organizationId", "number");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InventoryCountLine_countId_idx" ON "InventoryCountLine"("countId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Product_organizationId_barcode_idx" ON "Product"("organizationId", "barcode");

-- AddForeignKey
DO $$ BEGIN ALTER TABLE "WarehouseLocation" ADD CONSTRAINT "WarehouseLocation_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN ALTER TABLE "InventoryTransactionLine" ADD CONSTRAINT "InventoryTransactionLine_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "InventoryTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN ALTER TABLE "InventoryTransactionLine" ADD CONSTRAINT "InventoryTransactionLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN ALTER TABLE "InventoryLayer" ADD CONSTRAINT "InventoryLayer_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN ALTER TABLE "InventoryMove" ADD CONSTRAINT "InventoryMove_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "InventoryCount"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN ALTER TABLE "InventoryCountLine" ADD CONSTRAINT "InventoryCountLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
