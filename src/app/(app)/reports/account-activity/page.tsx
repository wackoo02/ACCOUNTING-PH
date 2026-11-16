import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { accountActivity } from "@/lib/ledger/reports";
import { formatPeso } from "@/lib/money";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { DimFilter, dimsFrom, dimsQs } from "@/components/DimFilter";

type SP = Promise<Record<string, string | undefined>>;

export default async function AccountActivity({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const r = await accountActivity(ctx.org.id, new Date(from), new Date(to), { dims: dimsFrom(sp) });
  const opening = r.rows.reduce((s, x) => s + x.opening, 0n);
  return (
    <>
      <div className="top"><h1>Account Activity Report</h1><span className="muted">{ctx.org.name} · {from} to {to}</span></div>
      <form className="card row noprint">
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <DimFilter organizationId={ctx.org.id} sp={sp} />
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Account</th><th className="num">Opening balance</th><th className="num">Debits</th><th className="num">Credits</th><th className="num">Net change</th><th className="num">Closing balance</th></tr></thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={x.account.id}>
              <td>{x.account.code}</td>
              <td><Link href={`/ledger?account=${x.account.id}&from=${from}&to=${to}${dimsQs(sp)}`}>{x.account.name}</Link></td>
              <td className="num">{formatPeso(x.opening)}</td>
              <td className="num">{formatPeso(x.periodDebit, { blankZero: true })}</td>
              <td className="num">{formatPeso(x.periodCredit, { blankZero: true })}</td>
              <td className="num">{formatPeso(x.periodDebit - x.periodCredit)}</td>
              <td className="num">{formatPeso(x.closing)}</td>
            </tr>
          ))}
          <tr className="total"><td colSpan={2}>Totals</td><td className="num">{formatPeso(opening)}</td><td className="num">{formatPeso(r.totalPeriodDebit)}</td><td className="num">{formatPeso(r.totalPeriodCredit)}</td><td className="num">{formatPeso(r.totalPeriodDebit - r.totalPeriodCredit)}</td><td className="num">{formatPeso(r.totalDebit - r.totalCredit)}</td></tr>
        </tbody>
      </table></div>
      <p className="muted">Balances are shown debit-positive; credit balances in parentheses.</p>
    </>
  );
}
