import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate, today } from "@/lib/format";
import { formatPeso } from "@/lib/money";
import { cents } from "@/lib/ap/common";
import { addDays, daysBetween } from "@/lib/ap/compute";
import { openBalances } from "@/lib/ap/bills";
import { ActionForm } from "@/components/ActionForm";
import { scheduleAction } from "../../ap-actions";

export default async function Schedule({ searchParams }: { searchParams: Promise<{ until?: string; vendor?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = new Date(today());
  const until = sp.until ? new Date(sp.until) : addDays(asOf, 30);
  const [bills, vendors, banks] = await Promise.all([
    prisma.apBill.findMany({ where: { organizationId: ctx.org.id, status: "POSTED", ...(sp.vendor ? { vendorId: sp.vendor } : {}) }, orderBy: [{ dueDate: "asc" }] }),
    prisma.vendor.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { code: "asc" } }),
  ]);
  const paid = await openBalances(prisma, ctx.org.id, bills.map((b) => b.id));
  const vname = new Map(vendors.map((v) => [v.id, v.name]));
  const rows = bills.map((b) => ({ b, open: cents(b.netPayable) - (paid.get(b.id) ?? 0n) })).filter((r) => r.open > 0n && (r.b.scheduledPayDate ?? r.b.dueDate) <= until);
  // Cash requirement by week of the planned pay date (scheduled date, else due date; overdue counts as this week).
  const weeks = new Map<string, bigint>();
  for (const r of rows) {
    if (r.b.onHold || r.b.currencyCode !== "PHP") continue;
    const d = r.b.scheduledPayDate ?? r.b.dueDate;
    const wk = d < asOf ? "Overdue / this week" : `Week of ${fmtDate(addDays(d, -((d.getUTCDay() + 6) % 7)))}`;
    weeks.set(wk, (weeks.get(wk) ?? 0n) + r.open);
  }
  const create = can(ctx.role, "journal.create");
  return (
    <>
      <div className="top"><h1>Payment Schedule</h1><Link className="btn secondary" href="/ap/aging">AP aging</Link></div>
      <form className="card row noprint">
        <div><label>Due or scheduled up to</label><input type="date" name="until" defaultValue={until.toISOString().slice(0, 10)} /></div>
        <div style={{ flex: 2 }}><label>Supplier</label><select name="vendor" defaultValue={sp.vendor ?? ""}><option value="">All</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="card grid">{[...weeks].map(([k, v]) => <div key={k} className="stat"><div className="l">{k}</div><div className="n">{formatPeso(v)}</div></div>)}
        {!weeks.size && <div className="muted">Nothing due in this window.</div>}</div>
      <ActionForm action={scheduleAction}>
        <div className="table-wrap"><table>
          <thead><tr><th style={{ width: 30 }} /><th>Due</th><th>Scheduled</th><th>Supplier</th><th>Bill</th><th>Invoice no.</th><th className="num">Days</th><th className="num">Unpaid</th></tr></thead>
          <tbody>
            {rows.map(({ b, open }) => { const late = daysBetween(b.dueDate, asOf); return (
              <tr key={b.id}><td><input type="checkbox" name="bill" value={b.id} style={{ width: "auto" }} aria-label={`Select ${b.number}`} /></td>
                <td className={late > 0 ? "diff-bad" : ""}>{fmtDate(b.dueDate)}</td><td>{b.scheduledPayDate ? fmtDate(b.scheduledPayDate) : ""}{b.onHold && <span className="badge DRAFT">HOLD</span>}</td>
                <td>{vname.get(b.vendorId)}</td><td><Link href={`/ap/bills/${b.id}`}>{b.number}</Link></td><td>{b.supplierInvoiceNo}</td>
                <td className="num">{late > 0 ? `${late} overdue` : `in ${-late}`}</td><td className="num">{b.currencyCode !== "PHP" ? b.currencyCode + " " : ""}{formatPeso(open)}</td></tr>); })}
            {!rows.length && <tr><td colSpan={8} className="muted">No unpaid approved bills in this window.</td></tr>}
          </tbody>
        </table></div>
        {create && rows.length > 0 && <div className="card" style={{ marginTop: 12 }}>
          <strong>With the ticked bills</strong>
          <div className="row" style={{ marginTop: 8 }}>
            <div><label>Pay / schedule date</label><input type="date" name="payDate" defaultValue={today()} /></div>
            <div style={{ flex: 2 }}><label>Pay from</label><select name="bankAccountId">{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></div>
            <div><label>Method</label><select name="method"><option value="CHECK">Check</option><option value="BANK_TRANSFER">Bank transfer</option><option value="ONLINE">Online</option></select></div>
            <div><label style={{ display: "flex", gap: 6 }}><input type="checkbox" name="submit" defaultChecked style={{ width: "auto" }} /> Submit for approval</label></div>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button name="op" value="run">Prepare payment vouchers (one per supplier)</button>
            <button name="op" value="schedule" className="secondary">Set scheduled date</button>
            <button name="op" value="hold" className="secondary">Put on hold</button>
            <button name="op" value="release" className="secondary">Release hold</button>
          </div>
        </div>}
      </ActionForm>
    </>
  );
}
