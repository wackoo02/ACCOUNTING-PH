import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { trialBalance } from "@/lib/ledger/reports";
import { formatPeso } from "@/lib/money";
import { firstOfYear, parseDateParam, today } from "@/lib/format";

type SP = Promise<Record<string, string | undefined>>;

export default async function TrialBalance({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear());
  const to = parseDateParam(sp.to, today());
  const tb = await trialBalance(ctx.org.id, new Date(to), new Date(from));
  const tPD = tb.rows.reduce((s, r) => s + r.periodDebit, 0n);
  const tPC = tb.rows.reduce((s, r) => s + r.periodCredit, 0n);
  return (
    <>
      <div className="top"><h1>Trial Balance</h1><span className="muted">{ctx.org.name} · as of {to}</span></div>
      <form className="card row noprint">
        <div><label>Movement from</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>As of</label><input type="date" name="to" defaultValue={to} /></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead>
          <tr><th rowSpan={2}>Code</th><th rowSpan={2}>Account</th><th rowSpan={2}>IFRS line item</th><th colSpan={2} className="num">Movement {from} to {to}</th><th colSpan={2} className="num">Ending balance</th></tr>
          <tr><th className="num">Debit</th><th className="num">Credit</th><th className="num">Debit</th><th className="num">Credit</th></tr>
        </thead>
        <tbody>
          {tb.rows.map((r) => (
            <tr key={r.account.id}>
              <td>{r.account.code}</td>
              <td><Link href={`/ledger?account=${r.account.id}&from=${from}&to=${to}`}>{r.account.name}</Link></td>
              <td className="muted">{r.account.ifrsGroup}</td>
              <td className="num">{formatPeso(r.periodDebit, { blankZero: true })}</td>
              <td className="num">{formatPeso(r.periodCredit, { blankZero: true })}</td>
              <td className="num">{formatPeso(r.debit, { blankZero: true })}</td>
              <td className="num">{formatPeso(r.credit, { blankZero: true })}</td>
            </tr>
          ))}
          {tb.rows.length === 0 && <tr><td colSpan={7} className="muted">No posted entries yet.</td></tr>}
          <tr className="total"><td colSpan={3}>Totals</td>
            <td className="num">{formatPeso(tPD)}</td><td className="num">{formatPeso(tPC)}</td>
            <td className="num">{formatPeso(tb.totalDebit)}</td><td className="num">{formatPeso(tb.totalCredit)}</td></tr>
        </tbody>
      </table></div>
      <p className={tb.balanced ? "diff-ok" : "diff-bad"}>{tb.balanced ? "Debits equal credits ✓" : "Out of balance — please contact support"}</p>
    </>
  );
}
