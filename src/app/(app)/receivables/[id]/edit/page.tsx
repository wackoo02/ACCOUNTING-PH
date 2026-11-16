import { notFound, redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { invoiceFormData } from "@/lib/ar/form-data";
import { InvoiceForm } from "@/components/InvoiceForm";

export default async function EditInvoice({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.create");
  const { id } = await params;
  const inv = await prisma.salesInvoice.findFirst({ where: { id, organizationId: ctx.org.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!inv) notFound();
  if (inv.status !== "DRAFT") redirect(`/receivables/${id}`);
  const [data, creditable] = await Promise.all([
    invoiceFormData(ctx.org.id),
    inv.kind === "CREDIT_MEMO" ? prisma.salesInvoice.findMany({ where: { organizationId: ctx.org.id, kind: "INVOICE", status: "POSTED", customerId: inv.customerId }, orderBy: { date: "desc" } }) : [],
  ]);
  return (
    <>
      <div className="top"><h1>Edit draft {inv.kind === "CREDIT_MEMO" ? "credit memo" : "invoice"}</h1></div>
      {inv.rejectReason && <div className="errors">Returned by the approver: {inv.rejectReason}</div>}
      <InvoiceForm data={data} canPost={can(ctx.role, "journal.post")}
        creditable={creditable.map((i) => ({ id: i.id, customerId: i.customerId, label: `SI ${i.number} · ${fmtDate(i.date)} · ${i.totalAmount.toString()}` }))}
        initial={{
          id: inv.id, kind: inv.kind as "INVOICE" | "CREDIT_MEMO", customerId: inv.customerId, date: fmtDate(inv.date), termsDays: String(inv.termsDays), dueDate: fmtDate(inv.dueDate),
          fxRate: inv.fxRate.toString(), pricesIncludeVat: inv.pricesIncludeVat, reference: inv.reference ?? "", memo: inv.memo ?? "", ewtTaxCodeId: inv.ewtTaxCodeId ?? "",
          creditForId: inv.creditForId ?? "", reason: inv.reason ?? "", warehouseId: inv.warehouseId ?? "",
          lines: inv.lines.map((l) => ({ productId: l.productId ?? "", description: l.description, quantity: l.quantity.toString(), unit: l.unit ?? "", unitPrice: l.unitPrice.toString(), discount: l.discount.toString() === "0" ? "" : l.discount.toString(), vatType: l.vatType, accountId: l.accountId, dims: (l.dims ?? {}) as Record<string, string>, lotNo: l.lotNo ?? "" })),
        }} />
    </>
  );
}
