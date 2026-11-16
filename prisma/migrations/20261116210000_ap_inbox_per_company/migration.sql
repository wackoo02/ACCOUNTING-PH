-- AP invoice inbox address per company, managed by the company's admin. Safe to re-run.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "apInboxAlias" TEXT;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "apInboxEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "apInboxSenders" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_apInboxAlias_key" ON "Organization"("apInboxAlias");
