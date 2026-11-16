import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { fmtDate, parseDateParam, today } from "@/lib/format";
import { MATURITY_BUCKETS, OVERDUE_BUCKETS, debtAging } from "@/lib/debt/service";

const add = (a: bigint[], b: bigint[]) => a.map((x, i) => x + b[i]);

export default async function DebtAgingReport({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const asOf = parseDateParam((await searchParams).asOf, today());
  const rows = await debtAging(ctx.org.id, new Date(`${asOf}T00:00:00.000Z`));
  const zero = MATURITY_BUCKETS.map(() => 0n), zeroO = OVERDUE_BUCKETS.map(() => 0n);
  const tp = rows.reduce((s, r) => add(s, r.principal), zero), ti = rows.reduce((s, r) => add(s, r.interest), zero), to = rows.reduce((s, r) => add(s, r.overdue), zeroO);
  return (
    <>
      <div className="top"><h1>Debt Aging and Maturity Analysis</h1>
        <form className="row noprint" style={{ flex: 0, flexWrap: "nowrap" }}><div><label>As of</label><input type="date" name="asOf" defaultValue={asOf} /></div><div style={{ flex: 0 }}><button>Show</button></div></form></div>
      <h2>Contractual maturities (undiscounted, PFRS 7.39)</h2>
      <p className="muted">Outstanding principal by when it falls due, with the scheduled interest still to be paid. Overdue = installments due before {asOf} and not yet paid.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Loan</th><th>Lender</th><th />{MATURITY_BUCKETS.map((b) => <th key={b} className="num">{b}</th>)}<th className="num">Total</th></tr></thead>
        <tbody>
          {rows.flatMap((r) => [
            <tr key={r.loan.id + "p"}><td><Link href={`/debt/${r.loan.id}`}>{r.loan.number}</Link></td><td>{r.loan.lender}</td><td>Principal</td>{r.principal.map((x, i) => <td key={i} className="num">{formatPeso(x, { blankZero: true })}</td>)}<td className="num">{formatPeso(r.principal.reduce((a, b) => a + b, 0n))}</td></tr>,
            <tr key={r.loan.id + "i"} className="muted"><td /><td /><td>Interest</td>{r.interest.map((x, i) => <td key={i} className="num">{formatPeso(x, { blankZero: true })}</td>)}<td className="num">{formatPeso(r.interest.reduce((a, b) => a + b, 0n))}</td></tr>,
          ])}
          {rows.length === 0 && <tr><td colSpan={10} className="muted">No outstanding loans.</td></tr>}
          {rows.length > 0 && <>
            <tr className="total"><td colSpan={3}>Total principal</td>{tp.map((x, i) => <td key={i} className="num">{formatPeso(x)}</td>)}<td className="num">{formatPeso(tp.reduce((a, b) => a + b, 0n))}</td></tr>
            <tr className="total"><td colSpan={3}>Total interest</td>{ti.map((x, i) => <td key={i} className="num">{formatPeso(x)}</td>)}<td className="num">{formatPeso(ti.reduce((a, b) => a + b, 0n))}</td></tr>
          </>}
        </tbody>
      </table></div>
      <h2>Past-due installments</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Loan</th><th>Lender</th>{OVERDUE_BUCKETS.map((b) => <th key={b} className="num">{b}</th>)}<th className="num">Total past due</th><th>Next due</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.loan.id}><td><Link href={`/debt/${r.loan.id}/amortization?asOf=${asOf}`}>{r.loan.number}</Link></td><td>{r.loan.lender}</td>
              {r.overdue.map((x, i) => <td key={i} className={`num ${x ? "diff-bad" : ""}`}>{formatPeso(x, { blankZero: true })}</td>)}
              <td className="num">{formatPeso(r.overdue.reduce((a, b) => a + b, 0n), { blankZero: true })}</td><td>{r.nextDue ? fmtDate(r.nextDue.dueDate) : "—"}</td><td className="num">{r.nextDue ? formatPeso(r.nextDue.unpaid) : ""}</td></tr>
          ))}
          {rows.length > 0 && <tr className="total"><td colSpan={2}>Total</td>{to.map((x, i) => <td key={i} className="num">{formatPeso(x)}</td>)}<td className="num">{formatPeso(to.reduce((a, b) => a + b, 0n))}</td><td /><td /></tr>}
        </tbody>
      </table></div>
    </>
  );
}
