import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { inventoryFormData } from "@/lib/inventory/form-data";
import { INV_LABELS, type InvType } from "@/lib/inventory/service";
import { InventoryForm, type InvMode } from "@/components/InventoryForm";

export default async function EditInventoryDoc({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("inventory.transact");
  const { id } = await params;
  const t = await prisma.inventoryTransaction.findFirst({ where: { id, organizationId: ctx.org.id, status: "DRAFT", sourceModule: null }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!t) notFound();
  const [data, org] = await Promise.all([inventoryFormData(ctx.org.id), prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } })]);
  const approval = t.type === "ADJUSTMENT";
  return (
    <>
      <div className="top"><h1>Edit {INV_LABELS[t.type as InvType].toLowerCase()} {t.number}</h1></div>
      <InventoryForm {...data} mode={t.type as InvMode} canSubmit={can(ctx.role, "inventory.transact")}
        canPost={approval ? can(ctx.role, "inventory.approve") && !org.requireApproval : can(ctx.role, "inventory.transact")}
        initial={{
          id: t.id, date: fmtDate(t.date), warehouseId: t.warehouseId, toWarehouseId: t.toWarehouseId ?? "", party: t.partyType && t.partyId ? `${t.partyType}:${t.partyId}` : "",
          reference: t.reference ?? "", memo: t.memo, offsetAccountId: t.offsetAccountId ?? "",
          lines: t.lines.map((l) => ({
            itemId: l.itemId, qty: l.qty.toString(), unitCost: l.unitCost?.toString() ?? "", locationId: l.locationId ?? "", toLocationId: l.toLocationId ?? "", lotNo: l.lotNo ?? "",
            accountId: l.accountId ?? "", description: l.description ?? "", dims: Object.fromEntries(Object.entries((l.dims ?? {}) as Record<string, string>)),
          })),
        }} />
    </>
  );
}
