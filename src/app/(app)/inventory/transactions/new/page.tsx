import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { today } from "@/lib/format";
import { inventoryFormData } from "@/lib/inventory/form-data";
import { INV_TYPES } from "@/lib/inventory/service";
import { InventoryForm, type InvMode } from "@/components/InventoryForm";

const TITLES: Record<InvMode, string> = {
  RECEIPT: "New Receiving Report (stock in)", ISSUE: "New Issue Slip (stock out)", TRANSFER: "New Stock Transfer", ADJUSTMENT: "New Stock Adjustment",
  RETURN_IN: "New Customer Return", RETURN_OUT: "New Return to Vendor",
};

export default async function NewInventoryDoc({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const ctx = await requireCtx("inventory.transact");
  const sp = await searchParams;
  const mode = ((INV_TYPES as readonly string[]).includes(sp.type ?? "") ? sp.type : "RECEIPT") as InvMode;
  const [data, org] = await Promise.all([inventoryFormData(ctx.org.id), prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } })]);
  const approval = mode === "ADJUSTMENT";
  return (
    <>
      <div className="top"><h1>{TITLES[mode]}</h1></div>
      {data.warehouses.length === 0 && <div className="notice">Add a warehouse first under <Link href="/masters/warehouses">Master Lists → Warehouses</Link>.</div>}
      {data.items.length === 0 && <div className="notice">No inventory items yet. In <Link href="/masters/products">Master Lists → Products and Prices</Link>, set Track Inventory to TRUE for the goods you keep in stock.</div>}
      <InventoryForm {...data} mode={mode} canSubmit={can(ctx.role, "inventory.transact")}
        canPost={approval ? can(ctx.role, "inventory.approve") && !org.requireApproval : can(ctx.role, "inventory.transact")}
        initial={{ date: today(), warehouseId: data.warehouses[0]?.id ?? "", toWarehouseId: "", party: "", reference: "", memo: "", offsetAccountId: "", lines: [] }} />
    </>
  );
}
