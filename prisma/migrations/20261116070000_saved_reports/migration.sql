-- Custom report builder: saved and shared report definitions. Idempotent so a half-applied deploy can be re-run.
DO $$ BEGIN
  CREATE TYPE "ReportVisibility" AS ENUM ('PRIVATE', 'COMPANY', 'ROLES', 'USERS');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "SavedReport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "visibility" "ReportVisibility" NOT NULL DEFAULT 'PRIVATE',
    "sharedRoles" "Role"[],
    "sharedUserIds" TEXT[],
    "allowEdit" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    CONSTRAINT "SavedReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SavedReport_organizationId_visibility_idx" ON "SavedReport"("organizationId", "visibility");
CREATE INDEX IF NOT EXISTS "SavedReport_organizationId_ownerId_idx" ON "SavedReport"("organizationId", "ownerId");
