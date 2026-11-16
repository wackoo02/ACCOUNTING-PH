import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { CONTRACT_KINDS } from "@/lib/ar/billing";
import { invoiceFormData } from "@/lib/ar/form-data";
import { ContractForm } from "@/components/ContractForm";
import { ActionForm } from "@/components/ActionForm";
import type { InvLine } from "@/components/InvoiceForm";
import { billMilestoneAction, runBillingAction } from "../../../ar-actions";

const c = (v: { toString(): string }) => toCentavos(v.toString());

export default async function ContractView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const k = await prisma.billingContract.findFirst({ where: { id, organizationId: ctx.org.id }, include: { milestones: { orderBy: { lineNo: "asc" } } } });
  if (!k) notFound();
  const [invoices, customer, data] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { organizationId: ctx.org.id, contractId: k.id }, orderBy: { date: "desc" } }),
    prisma.customer.findUnique({ where: { id: k.customerId } }),
    invoiceFormData(ctx.org.id),
  ]);
  const edit = can(ctx.role, "journal.create");
  const billed = invoices.filter((i) => i.status !== "VOID").reduce((s, i) => s + c(i.totalAmount), 0n);
  const d = (x: Date | null) => (x ? fmtDate(x) : "");
  return (
    <>
      <div className="top"><h1>{k.number} · {k.name}</h1><span className="badge POSTED">{k.status}</span></div>
      <div className="card grid">
        <div><label>Type</label>{CONTRACT_KINDS[k.kind as keyof typeof CONTRACT_KINDS]}</div>
        <div><label>Customer</label>{customer?.name}</div>
        <div><label>Term</label>{d(k.startDate)} to {k.endDate ? d(k.endDate) : "open"}</div>
        {k.nextBillDate && <div><label>Next billing</label>{d(k.nextBillDate)}</div>}
        <div><label>Billed so far</label>{formatPeso(billed)} <span className="muted">({invoices.length} invoices)</span></div>
      </div>
      {k.kind !== "PROJECT" && k.status === "ACTIVE" && edit && <ActionForm action={runBillingAction} className="card row noprint">
        <input type="hidden" name="contractId" value={k.id} />
        <div style={{ flex: 0 }}><label>Bill this contract up to</label><input type="date" name="asOf" defaultValue={today()} /></div>
        <div style={{ flex: 0 }}><button>Create due invoices</button></div>
      </ActionForm>}
      {k.kind === "PROJECT" && <>
        <h2>Milestones</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Milestone</th><th className="num">%</th><th className="num">Amount</th><th>Target</th><th>Invoice</th><th /></tr></thead>
          <tbody>{k.milestones.map((m) => { const inv = invoices.find((i) => i.id === m.invoiceId); return <tr key={m.id}>
            <td>{m.description}</td><td className="num">{m.percent ? Number(m.percent) : ""}</td><td className="num">{formatPeso(c(m.amount))}</td><td>{d(m.dueDate)}</td>
            <td>{inv ? <Link href={`/receivables/${inv.id}`}>{inv.number ?? "draft"}</Link> : ""}</td>
            <td>{!m.invoiceId && edit && k.status === "ACTIVE" && <ActionForm action={billMilestoneAction}><input type="hidden" name="milestoneId" value={m.id} /><div className="row" style={{ gap: 6 }}><input type="date" name="date" defaultValue={today()} style={{ width: 150 }} /><button>Bill now</button></div></ActionForm>}</td>
          </tr>; })}</tbody>
        </table></div>
      </>}
      <h2>Invoices</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Notes</th><th>Status</th><th className="num">Total</th><th className="num">Balance</th></tr></thead>
        <tbody>{invoices.map((i) => <tr key={i.id}><td>{d(i.date)}</td><td><Link href={`/receivables/${i.id}`}>{i.number ?? "(draft)"}</Link></td><td>{i.memo}</td><td><span className={`badge ${i.status}`}>{i.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : i.status}</span></td><td className="num">{formatPeso(c(i.totalAmount))}</td><td className="num">{i.status === "POSTED" ? formatPeso(c(i.totalAmount) - c(i.appliedAmount)) : ""}</td></tr>)}
          {invoices.length === 0 && <tr><td colSpan={6} className="muted">Not billed yet.</td></tr>}</tbody>
      </table></div>
      {edit && <details style={{ marginTop: 16 }}><summary>Edit contract</summary>
        <ContractForm data={data} initial={{
          id: k.id, kind: k.kind, name: k.name, customerId: k.customerId, startDate: d(k.startDate), endDate: d(k.endDate), frequency: k.frequency ?? "MONTHLY", nextBillDate: d(k.nextBillDate),
          termsDays: k.termsDays != null ? String(k.termsDays) : "", contractValue: k.contractValue.toString() === "0" ? "" : k.contractValue.toString(), pricesIncludeVat: k.pricesIncludeVat,
          ewtTaxCodeId: k.ewtTaxCodeId ?? "", autoSubmit: k.autoSubmit, status: k.status, memo: k.memo ?? "",
          lines: ((k.lines ?? []) as unknown as InvLine[]).map((l) => ({ productId: l.productId ?? "", description: l.description ?? "", quantity: String(l.quantity ?? "1"), unit: l.unit ?? "", unitPrice: String(l.unitPrice ?? ""), discount: l.discount ?? "", vatType: l.vatType ?? "VATABLE", accountId: l.accountId ?? "", dims: (l.dims ?? {}) as Record<string, string> })),
          milestones: k.milestones.map((m) => ({ id: m.id, description: m.description, percent: m.percent ? m.percent.toString() : "", amount: m.percent ? "" : m.amount.toString(), dueDate: d(m.dueDate), vatType: m.vatType, billed: !!m.invoiceId })),
        }} />
      </details>}
    </>
  );
}
