-- CreateTable
CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "location" TEXT,
    "custodianCode" TEXT,
    "serialNo" TEXT,
    "acquisitionDate" DATE,
    "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "accountCode" TEXT,
    "tagCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "condition" TEXT,
    "taggedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenLocation" TEXT,
    "lastAuditId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetAudit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "AssetAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetScan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "assetId" TEXT,
    "tagText" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "location" TEXT,
    "condition" TEXT,
    "note" TEXT,
    "imageId" TEXT,
    "scannedById" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FixedAsset_organizationId_tagCode_idx" ON "FixedAsset"("organizationId", "tagCode");

-- CreateIndex
CREATE UNIQUE INDEX "FixedAsset_organizationId_code_key" ON "FixedAsset"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AssetAudit_organizationId_number_key" ON "AssetAudit"("organizationId", "number");

-- CreateIndex
CREATE INDEX "AssetScan_auditId_assetId_idx" ON "AssetScan"("auditId", "assetId");

-- AddForeignKey
ALTER TABLE "AssetScan" ADD CONSTRAINT "AssetScan_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AssetAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

