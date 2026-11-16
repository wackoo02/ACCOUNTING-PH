import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { peso, statusText } from "@/lib/ap/view";
import { openBalances } from "@/lib/ap/bills";
import { cents } from "@/lib/ap/common";
import { formatPeso } from "@/lib/money";

export default async function BillList({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; vendor?: string; from?: string; to?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const where: Prisma.ApBillWhereInput = { organizationId: ctx.org.id };
  if (sp.status) where.status = sp.status;
  if (sp.vendor) where.vendorId = sp.vendor;
  if (sp.q) where.OR = [{ number: { contains: sp.q, mode: "insensitive" } }, { supplierInvoiceNo: { contains: sp.q, mode: "insensitive" } }, { memo: { contains: sp.q, mode: "insensitive" } }];
  if (sp.from || sp.to) where.date = { ...(sp.from ? { gte: new Date(sp.from) } : {}), ...(sp.to ? { lte: new Date(sp.to) } : {}) };
  const [rows, vendors] = await Promise.all([
    prisma.apBill.findMany({ where, orderBy: [{ date: "desc" }, { number: "desc" }], take: 300 }),
    prisma.vendor.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: "asc" } }),
  ]);
  const paid = await openBalances(prisma, ctx.org.id, rows.map((r) => r.id));
  const vname = new Map(vendors.map((v) => [v.id, v.name]));
  return (
    <>
      <div className="top"><h1>Supplier Bills (AP Vouchers)</h1>{can(ctx.role, "journal.create") && <div className="row" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}><Link className="btn" href="/ap/bills/new">New bill</Link><Link className="btn secondary" href="/ap/inbox">AP inbox</Link></div>}</div>
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="APV no., invoice no., particulars" /></div>
        <div><label>Supplier</label><select name="vendor" defaultValue={sp.vendor ?? ""}><option value="">All</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option>{["DRAFT", "PENDING_APPROVAL", "POSTED", "VOID"].map((s) => <option key={s} value={s}>{statusText(s)}</option>)}</select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={sp.from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={sp.to} /></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Posting date</th><th>No.</th><th>Supplier</th><th>Invoice no.</th><th>Due</th><th>Status</th><th className="num">Total</th><th className="num">EWT</th><th className="num">Unpaid</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.id}><td>{fmtDate(r.date)}</td><td><Link href={`/ap/bills/${r.id}`}>{r.number}</Link></td><td>{vname.get(r.vendorId)}</td><td>{r.supplierInvoiceNo}</td><td>{fmtDate(r.dueDate)}</td>
            <td><span className={`badge ${r.status}`}>{statusText(r.status)}</span>{r.onHold && <span className="badge DRAFT"> HOLD</span>}</td>
            <td className="num">{r.currencyCode !== "PHP" ? r.currencyCode + " " : ""}{peso(r.total)}</td><td className="num">{peso(r.ewtAmount)}</td>
            <td className="num">{r.status === "POSTED" ? formatPeso(cents(r.netPayable) - (paid.get(r.id) ?? 0n)) : ""}</td></tr>)}
          {!rows.length && <tr><td colSpan={9} className="muted">No bills found.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
