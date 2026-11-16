import { Fragment } from "react";
import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { fmtDate, parseDateParam, today } from "@/lib/format";
import { AGING_BUCKETS } from "@/lib/ar/compute";
import { customerAging } from "@/lib/ar/reports";
import { PrintButton } from "@/components/PrintButton";

type SP = Promise<Record<string, string | undefined>>;

export default async function Aging({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = parseDateParam(sp.asOf, today());
  const detail = sp.view === "detail";
  const basis = sp.basis === "invoice" ? "invoice" : "due";
  const a = await customerAging(ctx.org.id, new Date(asOf), { basis });
  const labels = basis === "invoice" ? ["0-30", "31-60", "61-90", "91-120", "121-150", "Over 150"] : AGING_BUCKETS.map((b) => (b === "Current" ? "Not yet due" : b));
  const t = a.tieOut!;
  const diff = (x: { subledger: bigint; gl: { balance: bigint } | null }) => (x.gl ? x.subledger - x.gl.balance : 0n);
  return (
    <>
      <div className="top"><h1>Customer Aging {detail ? "(Detail)" : "(Summary)"}</h1><PrintButton /></div>
      <form className="card row noprint">
        <div><label>As of</label><input type="date" name="asOf" defaultValue={asOf} /></div>
        <div><label>View</label><select name="view" defaultValue={detail ? "detail" : "summary"}><option value="summary">Summary by customer</option><option value="detail">Detail by invoice</option></select></div>
        <div><label>Age by</label><select name="basis" defaultValue={basis}><option value="due">Days past due</option><option value="invoice">Days since invoice date</option></select></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <p className="muted">As of {asOf}. Amounts in {"PHP"} at each invoice&apos;s own exchange rate. {basis === "due" ? "Buckets are days past the due date." : "Buckets are days since the invoice date."}</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Customer</th>{detail && <><th>Invoice</th><th>Date</th><th>Due</th><th className="num">Days</th></>}{labels.map((l) => <th key={l} className="num">{l}</th>)}<th className="num">Unapplied credits</th><th className="num">Net balance</th></tr></thead>
        <tbody>
          {a.customers.map((c) => detail ? (
            <Fragment key={c.customerId}>
              {c.rows.map((r) => <tr key={r.invoiceId}>
                <td>{c.name}</td><td><Link href={`/receivables/${r.invoiceId}`}>SI {r.number}</Link>{r.currencyCode !== "PHP" ? <span className="muted"> · {r.currencyCode} {formatPeso(r.open)}</span> : null}</td><td>{fmtDate(r.date)}</td><td>{fmtDate(r.dueDate)}</td><td className="num">{r.days > 0 ? r.days : ""}</td>
                {labels.map((_, k) => <td key={k} className="num">{r.bucket === k ? formatPeso(r.openBase) : ""}</td>)}<td /><td />
              </tr>)}
              {c.creditRows.map((r) => <tr key={r.id}>
                <td>{c.name}</td><td><Link href={r.type === "RECEIPT" ? `/receivables/collections/${r.id}` : `/receivables/${r.id}`}>{r.type === "RECEIPT" ? "Advance" : "CM"} {r.number}</Link></td><td>{fmtDate(r.date)}</td><td /><td />
                {labels.map((_, k) => <td key={k} />)}<td className="num">({formatPeso(r.openBase)})</td><td />
              </tr>)}
              <tr className="total"><td colSpan={5}><Link href={`/receivables/statement?customer=${c.customerId}&to=${asOf}`}>{c.name}</Link> total</td>{c.buckets.map((b, k) => <td key={k} className="num">{formatPeso(b, { blankZero: true })}</td>)}<td className="num">{c.credits ? `(${formatPeso(c.credits)})` : ""}</td><td className="num">{formatPeso(c.net)}</td></tr>
            </Fragment>
          ) : (
            <tr key={c.customerId}>
              <td><Link href={`/receivables/statement?customer=${c.customerId}&to=${asOf}`}>{c.name}</Link> <span className="muted">{c.code}</span>{c.creditLimit > 0n && c.net > c.creditLimit && <span className="badge VOID" style={{ marginLeft: 6 }}>over limit</span>}</td>
              {c.buckets.map((b, k) => <td key={k} className="num">{formatPeso(b, { blankZero: true })}</td>)}
              <td className="num">{c.credits ? `(${formatPeso(c.credits)})` : ""}</td><td className="num"><strong>{formatPeso(c.net)}</strong></td>
            </tr>
          ))}
          {a.customers.length === 0 && <tr><td colSpan={12} className="muted">No open invoices.</td></tr>}
          <tr className="total"><td colSpan={detail ? 5 : 1}>Total</td>{a.totals.buckets.map((b, k) => <td key={k} className="num">{formatPeso(b)}</td>)}<td className="num">({formatPeso(a.totals.credits)})</td><td className="num">{formatPeso(a.totals.net)}</td></tr>
          {a.totals.invoices > 0n && <tr><td colSpan={detail ? 5 : 1} className="muted">% of open invoices</td>{a.totals.buckets.map((b, k) => <td key={k} className="num muted">{(Number((b * 10000n) / a.totals.invoices) / 100).toFixed(1)}%</td>)}<td /><td /></tr>}
        </tbody>
      </table></div>

      <h2>Agrees with the general ledger?</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Account</th><th className="num">Receivables module</th><th className="num">General ledger</th><th className="num">Difference</th></tr></thead>
        <tbody>
          <tr><td>{t.ar.gl?.account ?? "Accounts receivable (no AR_CONTROL account)"} <span className="muted">open invoices less unapplied credit memos</span></td><td className="num">{formatPeso(t.ar.subledger)}</td><td className="num">{t.ar.gl ? formatPeso(t.ar.gl.balance) : "—"}</td><td className="num" style={diff(t.ar) ? { color: "var(--danger)" } : undefined}>{formatPeso(diff(t.ar))}</td></tr>
          <tr><td>{t.advances.gl?.account ?? "Advances from customers (no CUSTOMER_ADVANCES account)"} <span className="muted">unapplied payments</span></td><td className="num">{formatPeso(t.advances.subledger)}</td><td className="num">{t.advances.gl ? formatPeso(t.advances.gl.balance) : "—"}</td><td className="num" style={diff(t.advances) ? { color: "var(--danger)" } : undefined}>{formatPeso(diff(t.advances))}</td></tr>
        </tbody>
      </table></div>
      {(diff(t.ar) !== 0n || diff(t.advances) !== 0n) && <p className="muted">A difference means something was posted to these accounts outside Receivables (a manual journal, a cash receipt voucher, an opening balance or a scanned invoice from the mobile app). Open the account ledger to find it. To stop it, set the account to &quot;Allow Manual Journals = FALSE&quot; in the chart of accounts.</p>}
    </>
  );
}
