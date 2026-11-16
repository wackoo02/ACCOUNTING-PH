import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { today } from "@/lib/format";
import { invoiceFormData } from "@/lib/ar/form-data";
import { InvoiceForm } from "@/components/InvoiceForm";

export default async function NewInvoice({ searchParams }: { searchParams: Promise<{ kind?: string; customer?: string; creditFor?: string }> }) {
  const ctx = await requireCtx("journal.create");
  const sp = await searchParams;
  const kind = sp.kind === "CREDIT_MEMO" ? "CREDIT_MEMO" : "INVOICE";
  const [data, creditable, base] = await Promise.all([
    invoiceFormData(ctx.org.id),
    kind === "CREDIT_MEMO" ? prisma.salesInvoice.findMany({ where: { organizationId: ctx.org.id, kind: "INVOICE", status: "POSTED" }, orderBy: { date: "desc" }, take: 500 }) : [],
    sp.creditFor ? prisma.salesInvoice.findFirst({ where: { id: sp.creditFor, organizationId: ctx.org.id }, include: { lines: { orderBy: { lineNo: "asc" } } } }) : null,
  ]);
  const cust = data.customers.find((c) => c.id === (base?.customerId ?? sp.customer));
  return (
    <>
      <div className="top"><h1>{kind === "CREDIT_MEMO" ? "New Credit Memo" : "New Sales Invoice"}</h1></div>
      {data.customers.length === 0 && <div className="notice">Add a customer under Master Lists → Customers first.</div>}
      <InvoiceForm data={data} canPost={can(ctx.role, "journal.post")}
        creditable={creditable.map((i) => ({ id: i.id, customerId: i.customerId, label: `SI ${i.number} · ${i.date.toISOString().slice(0, 10)} · ${i.totalAmount.toString()}` }))}
        initial={{
          kind, customerId: cust?.id ?? "", date: today(), termsDays: cust ? String(cust.termsDays) : "", dueDate: "",
          fxRate: cust && cust.currencyCode !== data.baseCurrency ? data.currencies.find((c) => c.code === cust.currencyCode)?.rate ?? "" : "1",
          pricesIncludeVat: base?.pricesIncludeVat ?? false, reference: "", memo: "", ewtTaxCodeId: "", creditForId: base?.id ?? "", reason: "",
          lines: base ? base.lines.map((l) => ({ productId: l.productId ?? "", description: l.description, quantity: l.quantity.toString(), unit: l.unit ?? "", unitPrice: l.unitPrice.toString(), discount: "", vatType: l.vatType, accountId: "", dims: (l.dims ?? {}) as Record<string, string> })) : [],
        }} />
    </>
  );
}
