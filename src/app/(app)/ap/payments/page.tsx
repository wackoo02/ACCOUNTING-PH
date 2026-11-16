import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { peso, statusText } from "@/lib/ap/view";

export default async function PayList({ searchParams }: { searchParams: Promise<{ status?: string; vendor?: string; q?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const where: Prisma.ApPaymentWhereInput = { organizationId: ctx.org.id };
  if (sp.status) where.status = sp.status;
  if (sp.vendor) where.vendorId = sp.vendor;
  if (sp.q) where.OR = [{ number: { contains: sp.q, mode: "insensitive" } }, { checkNo: { contains: sp.q } }, { memo: { contains: sp.q, mode: "insensitive" } }];
  const [rows, vendors, banks] = await Promise.all([
    prisma.apPayment.findMany({ where, orderBy: [{ date: "desc" }, { number: "desc" }], take: 300 }),
    prisma.vendor.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id } }),
  ]);
  const vname = new Map(vendors.map((v) => [v.id, v.name]));
  const bname = new Map(banks.map((b) => [b.id, b.code]));
  return (
    <>
      <div className="top"><h1>Payment Vouchers</h1>{can(ctx.role, "journal.create") && <div className="row" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}><Link className="btn" href="/ap/payments/new">New payment</Link><Link className="btn secondary" href="/ap/schedule">Payment schedule</Link></div>}</div>
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="PV no., check no., particulars" /></div>
        <div><label>Supplier</label><select name="vendor" defaultValue={sp.vendor ?? ""}><option value="">All</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option>{["DRAFT", "PENDING_APPROVAL", "POSTED", "VOID"].map((s) => <option key={s} value={s}>{s === "POSTED" ? "RELEASED" : statusText(s)}</option>)}</select></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Supplier</th><th>From</th><th>Method</th><th>Check no.</th><th>Status</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.id}><td>{fmtDate(r.date)}</td><td><Link href={`/ap/payments/${r.id}`}>{r.number}</Link></td><td>{vname.get(r.vendorId)}</td><td>{bname.get(r.bankAccountId)}</td><td>{r.method.replace("_", " ").toLowerCase()}</td><td>{r.checkNo}</td>
            <td><span className={`badge ${r.status}`}>{r.status === "POSTED" ? "RELEASED" : statusText(r.status)}</span></td><td className="num">{r.currencyCode !== "PHP" ? r.currencyCode + " " : ""}{peso(r.amount)}</td></tr>)}
          {!rows.length && <tr><td colSpan={8} className="muted">No payment vouchers yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
