import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { apFormData } from "@/lib/ap/form-data";
import { blankHeader, d10, docLine, openPurchaseOrders } from "@/lib/ap/view";
import { DocForm } from "@/components/ap/DocForm";

export default async function EditBill({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.create");
  const { id } = await params;
  const b = await prisma.apBill.findFirst({ where: { id, organizationId: ctx.org.id, status: "DRAFT" }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!b) notFound();
  const [data, pos] = await Promise.all([apFormData(ctx.org.id), openPurchaseOrders(ctx.org.id, b.id, b.purchaseOrderId)]);
  return (<><div className="top"><h1>Edit {b.number}</h1></div>
    <DocForm mode="BILL" data={data} openPos={pos} initialLines={b.lines.map((l) => docLine(l))}
      initial={blankHeader({ id: b.id, vendorId: b.vendorId, invoiceNo: b.supplierInvoiceNo, invoiceDate: d10(b.invoiceDate), date: d10(b.date), dueDate: d10(b.dueDate), purchaseOrderId: b.purchaseOrderId ?? "", purpose: b.memo, vatInclusive: b.vatInclusive, currencyCode: b.currencyCode, fxRate: b.fxRate.toString() })} /></>);
}
