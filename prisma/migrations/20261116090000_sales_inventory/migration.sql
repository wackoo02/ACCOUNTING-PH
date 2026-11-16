-- Sales invoices issue stocked items from a warehouse (COGS through the inventory module).
ALTER TABLE "SalesInvoice" ADD COLUMN IF NOT EXISTS "warehouseId" TEXT;
ALTER TABLE "SalesInvoiceLine" ADD COLUMN IF NOT EXISTS "lotNo" TEXT;
