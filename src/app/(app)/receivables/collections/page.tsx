import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";

type SP = Promise<Record<string, string | undefined>>;
const c = (v: { toString(): string }) => toCentavos(v.toString());

export default async function CollectionList({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const where: Prisma.ArReceiptWhereInput = { organizationId: ctx.org.id };
  if (sp.status) where.status = sp.status;
  if (sp.customer) where.customerId = sp.customer;
  if (sp.q) where.OR = [{ number: { contains: sp.q, mode: "insensitive" } }, { customerName: { contains: sp.q, mode: "insensitive" } }, { checkNo: { contains: sp.q } }, { reference: { contains: sp.q, mode: "insensitive" } }];
  if (sp.from || sp.to) where.date = { ...(sp.from ? { gte: new Date(sp.from) } : {}), ...(sp.to ? { lte: new Date(sp.to) } : {}) };
  const [rows, customers, banks] = await Promise.all([
    prisma.arReceipt.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 300 }),
    prisma.customer.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id } }),
  ]);
  const bank = new Map(banks.map((b) => [b.id, b.code]));
  return (
    <>
      <div className="top"><h1>Collections</h1>
        {can(ctx.role, "journal.create") && <Link className="btn noprint" href="/receivables/collections/new">Record collection</Link>}</div>
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="No., customer, check no." /></div>
        <div><label>Customer</label><select name="customer" defaultValue={sp.customer ?? ""}><option value="">All</option>{customers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option><option>DRAFT</option><option value="PENDING_APPROVAL">FOR APPROVAL</option><option>POSTED</option><option>VOID</option></select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={sp.from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={sp.to} /></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Customer</th><th>Deposited to</th><th>Check no.</th><th>Status</th><th className="num">Cash</th><th className="num">Tax withheld</th><th className="num">Unapplied</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const un = c(r.cashAmount) + c(r.withholdingAmount) - c(r.appliedAmount);
            return <tr key={r.id}>
              <td>{fmtDate(r.date)}</td><td><Link href={`/receivables/collections/${r.id}`}>{r.number ?? "(draft)"}</Link></td><td>{r.customerName}</td><td>{bank.get(r.bankAccountId)}</td><td>{r.checkNo}</td>
              <td><span className={`badge ${r.status}`}>{r.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : r.status}</span></td>
              <td className="num">{r.currencyCode !== "PHP" ? `${r.currencyCode} ` : ""}{formatPeso(c(r.cashAmount))}</td><td className="num">{formatPeso(c(r.withholdingAmount), { blankZero: true })}</td>
              <td className="num">{r.status === "POSTED" ? formatPeso(un, { blankZero: true }) : ""}</td>
            </tr>;
          })}
          {rows.length === 0 && <tr><td colSpan={9} className="muted">No collections found.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
