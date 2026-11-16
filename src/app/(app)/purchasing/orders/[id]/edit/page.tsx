import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { apFormData } from "@/lib/ap/form-data";
import { blankHeader, d10, docLine } from "@/lib/ap/view";
import { DocForm } from "@/components/ap/DocForm";

export default async function EditPo({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.create");
  const { id } = await params;
  const po = await prisma.purchaseOrder.findFirst({ where: { id, organizationId: ctx.org.id, status: "DRAFT" }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!po) notFound();
  const data = await apFormData(ctx.org.id);
  return (<><div className="top"><h1>Edit {po.number}</h1></div>
    <DocForm mode="PO" data={data} initial={blankHeader({ id: po.id, vendorId: po.vendorId ?? "", date: d10(po.poDate), neededBy: d10(po.deliveryDate), purpose: po.description, deliverTo: po.deliverTo ?? "", terms: po.paymentTermsDays?.toString() ?? "", vatInclusive: po.vatInclusive, currencyCode: po.currencyCode, fxRate: po.fxRate.toString(), notes: po.notes ?? "", requestId: po.requestId ?? "", rfqId: po.rfqId ?? "" })}
      initialLines={po.lines.map((l) => docLine(l))} /></>);
}
