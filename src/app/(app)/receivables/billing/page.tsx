import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { CONTRACT_KINDS, FREQUENCIES } from "@/lib/ar/billing";
import { ActionForm } from "@/components/ActionForm";
import { runBillingAction } from "../../ar-actions";

export default async function BillingList() {
  const ctx = await requireCtx("reports.view");
  const [rows, customers] = await Promise.all([
    prisma.billingContract.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ status: "asc" }, { number: "desc" }] }),
    prisma.customer.findMany({ where: { organizationId: ctx.org.id }, select: { id: true, name: true } }),
  ]);
  const cust = new Map(customers.map((c) => [c.id, c.name]));
  const due = rows.filter((r) => r.status === "ACTIVE" && r.nextBillDate && r.nextBillDate <= new Date()).length;
  return (
    <>
      <div className="top"><h1>Contract and Subscription Billing</h1>{can(ctx.role, "journal.create") && <Link className="btn noprint" href="/receivables/billing/new">New contract</Link>}</div>
      <p className="muted">Subscriptions and retainer contracts create one sales invoice per period; project contracts bill by milestone. New invoices go to Sales Invoices for approval like any other invoice.</p>
      {can(ctx.role, "journal.create") && <ActionForm action={runBillingAction} className="card row noprint">
        <div style={{ flex: 0 }}><label>Bill everything due up to</label><input type="date" name="asOf" defaultValue={today()} /></div>
        <div style={{ flex: 0 }}><button>Create due invoices{due ? ` (${due} contract${due > 1 ? "s" : ""} due)` : ""}</button></div>
      </ActionForm>}
      <div className="table-wrap"><table>
        <thead><tr><th>No.</th><th>Name</th><th>Type</th><th>Customer</th><th>Every</th><th>Next billing</th><th>Ends</th><th className="num">Invoices</th><th className="num">Contract value</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.id}>
            <td><Link href={`/receivables/billing/${r.id}`}>{r.number}</Link></td><td>{r.name}</td><td>{CONTRACT_KINDS[r.kind as keyof typeof CONTRACT_KINDS]}</td><td>{cust.get(r.customerId)}</td>
            <td>{r.frequency ? FREQUENCIES[r.frequency as keyof typeof FREQUENCIES] : "Milestones"}</td><td>{r.nextBillDate && r.status === "ACTIVE" ? fmtDate(r.nextBillDate) : ""}</td><td>{r.endDate ? fmtDate(r.endDate) : ""}</td>
            <td className="num">{r.invoiceCount}</td><td className="num">{formatPeso(toCentavos(r.contractValue.toString()), { blankZero: true })}</td><td>{r.status}</td>
          </tr>)}
          {rows.length === 0 && <tr><td colSpan={10} className="muted">No contracts yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
