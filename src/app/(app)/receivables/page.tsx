import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

type SP = Promise<Record<string, string | undefined>>;
const c = (v: { toString(): string }) => toCentavos(v.toString());

export default async function InvoiceList({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const kind = sp.kind === "CREDIT_MEMO" ? "CREDIT_MEMO" : "INVOICE";
  const where: Prisma.SalesInvoiceWhereInput = { organizationId: ctx.org.id, kind };
  if (sp.status === "OPEN") { where.status = "POSTED"; }
  else if (sp.status) where.status = sp.status;
  if (sp.customer) where.customerId = sp.customer;
  if (sp.q) where.OR = [{ number: { contains: sp.q, mode: "insensitive" } }, { customerName: { contains: sp.q, mode: "insensitive" } }, { reference: { contains: sp.q, mode: "insensitive" } }, { memo: { contains: sp.q, mode: "insensitive" } }];
  if (sp.from || sp.to) where.date = { ...(sp.from ? { gte: new Date(sp.from) } : {}), ...(sp.to ? { lte: new Date(sp.to) } : {}) };
  const [rows0, customers] = await Promise.all([
    prisma.salesInvoice.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 300 }),
    prisma.customer.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: "asc" }, select: { id: true, code: true, name: true } }),
  ]);
  const rows = sp.status === "OPEN" ? rows0.filter((r) => c(r.totalAmount) > c(r.appliedAmount)) : rows0;
  const create = can(ctx.role, "journal.create");
  const today = new Date();
  const cm = kind === "CREDIT_MEMO";
  return (
    <>
      <div className="top"><h1>{cm ? "Credit Memos" : "Sales Invoices"}</h1>
        {create && <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}>
          <Link className="btn" href="/receivables/new">New invoice</Link>
          <Link className="btn secondary" href="/receivables/new?kind=CREDIT_MEMO">New credit memo</Link>
          <Link className="btn secondary" href="/receivables/collections/new">Record collection</Link>
        </div>}
      </div>
      {customers.length === 0 && <div className="notice">Add your customers first under <Link href="/masters/customers">Master Lists → Customers</Link> (set Invoice Emails so invoices can be emailed).</div>}
      <form className="card row noprint">
        <input type="hidden" name="kind" value={kind} />
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="No., customer, PO, notes" /></div>
        <div><label>Customer</label><MasterPicker name="customer" ariaLabel="Customer" defaultValue={sp.customer ?? ""} emptyLabel="All" placeholder="All" options={idOpts(customers)} /></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option><option>DRAFT</option><option value="PENDING_APPROVAL">FOR APPROVAL</option><option value="POSTED">ISSUED</option>{!cm && <option value="OPEN">ISSUED, UNPAID</option>}<option>VOID</option></select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={sp.from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={sp.to} /></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Customer</th><th>Reference</th>{!cm && <th>Due</th>}<th>Status</th><th className="num">Total</th><th className="num">{cm ? "Unapplied" : "Balance"}</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const bal = c(r.totalAmount) - c(r.appliedAmount);
            const overdue = !cm && r.status === "POSTED" && bal > 0n && r.dueDate < today;
            return (
              <tr key={r.id}>
                <td>{fmtDate(r.date)}</td><td><Link href={`/receivables/${r.id}`}>{r.number ?? "(draft)"}</Link>{r.source === "CONTRACT" && <span className="muted"> · billing</span>}</td>
                <td>{r.customerName}</td><td>{r.reference}</td>
                {!cm && <td style={overdue ? { color: "var(--danger)" } : undefined}>{fmtDate(r.dueDate)}{overdue ? " · overdue" : ""}</td>}
                <td><span className={`badge ${r.status}`}>{r.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : r.status === "POSTED" ? (bal === 0n && !cm ? "PAID" : "ISSUED") : r.status}</span></td>
                <td className="num">{r.currencyCode !== "PHP" ? `${r.currencyCode} ` : ""}{formatPeso(c(r.totalAmount))}</td>
                <td className="num">{r.status === "POSTED" ? formatPeso(bal) : ""}</td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={8} className="muted">Nothing found.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
