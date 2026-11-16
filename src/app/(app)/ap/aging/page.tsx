import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDate, today } from "@/lib/format";
import { formatPeso } from "@/lib/money";
import { apAging } from "@/lib/ap/aging";
import { BUCKETS, BUCKET_LABELS } from "@/lib/ap/compute";
import { PrintButton } from "@/components/PrintButton";

export default async function Aging({ searchParams }: { searchParams: Promise<{ asOf?: string; view?: string; vendor?: string; basis?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = new Date(sp.asOf || today());
  const detail = sp.view === "detail";
  const [org, vendors, r] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.vendor.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: "asc" } }),
    apAging(ctx.org.id, asOf, { vendorId: sp.vendor || null, basis: sp.basis === "invoice" ? "invoice" : "due" }),
  ]);
  const qs = (o: Record<string, string>) => "?" + new URLSearchParams({ asOf: asOf.toISOString().slice(0, 10), view: sp.view ?? "", basis: sp.basis ?? "", ...o }).toString();
  return (
    <>
      <div className="top"><h1>Accounts Payable Aging · {detail ? "Detail" : "Summary"}</h1><PrintButton /></div>
      <div className="print-only"><strong>{org.name}</strong> · as of {fmtDate(asOf)}</div>
      <form className="card row noprint">
        <div><label>As of</label><input type="date" name="asOf" defaultValue={asOf.toISOString().slice(0, 10)} /></div>
        <div><label>View</label><select name="view" defaultValue={sp.view ?? ""}><option value="">Summary by supplier</option><option value="detail">Detail by invoice</option></select></div>
        <div><label>Age by</label><select name="basis" defaultValue={sp.basis ?? ""}><option value="">Days past due</option><option value="invoice">Days from invoice date</option></select></div>
        <div style={{ flex: 2 }}><label>Supplier</label><select name="vendor" defaultValue={sp.vendor ?? ""}><option value="">All</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      {r.gl !== null && <div className={r.gl === r.subledger ? "notice" : "errors"}>
        AP sub-ledger {formatPeso(r.subledger)} · Accounts Payable in the GL {formatPeso(r.gl)} · {r.gl === r.subledger ? "in balance." : `difference ${formatPeso(r.gl - r.subledger)}: look for manual journals to the AP account or opening balances not entered as bills.`}
      </div>}
      {!detail ? (
        <div className="table-wrap"><table>
          <thead><tr><th>Supplier</th><th className="num">Bills</th>{BUCKETS.map((b) => <th key={b} className="num">{BUCKET_LABELS[b]}</th>)}<th className="num">Total</th></tr></thead>
          <tbody>
            {r.summary.map((s) => <tr key={s.vendorId}><td><Link href={qs({ view: "detail", vendor: s.vendorId })}>{s.vendorName}</Link></td><td className="num">{s.count}</td>{BUCKETS.map((b) => <td key={b} className="num">{formatPeso(s.buckets[b], { blankZero: true })}</td>)}<td className="num"><strong>{formatPeso(s.total)}</strong></td></tr>)}
            <tr className="total"><td colSpan={2}>Total ({org.baseCurrency})</td>{BUCKETS.map((b) => <td key={b} className="num">{formatPeso(r.totals[b])}</td>)}<td className="num">{formatPeso(r.subledger)}</td></tr>
          </tbody>
        </table></div>
      ) : (
        <div className="table-wrap"><table>
          <thead><tr><th>Supplier</th><th>Bill</th><th>Invoice no.</th><th>Invoice date</th><th>Due</th><th className="num">Days</th><th>Bucket</th><th className="num">Net payable</th><th className="num">Paid</th><th className="num">Open</th></tr></thead>
          <tbody>
            {r.rows.map((x) => <tr key={x.billId}><td>{x.vendorName}</td><td><Link href={`/ap/bills/${x.billId}`}>{x.number}</Link></td><td>{x.supplierInvoiceNo}</td><td>{fmtDate(x.invoiceDate)}</td><td>{fmtDate(x.dueDate)}{x.onHold && <span className="badge DRAFT"> HOLD</span>}</td>
              <td className="num">{x.daysPastDue}</td><td>{BUCKET_LABELS[x.bucket]}</td><td className="num">{x.currencyCode !== org.baseCurrency ? x.currencyCode + " " : ""}{formatPeso(x.netPayable)}</td><td className="num">{formatPeso(x.paid, { blankZero: true })}</td><td className="num">{formatPeso(x.open)}</td></tr>)}
            <tr className="total"><td colSpan={9}>Total open ({org.baseCurrency})</td><td className="num">{formatPeso(r.subledger)}</td></tr>
          </tbody>
        </table></div>
      )}
    </>
  );
}
