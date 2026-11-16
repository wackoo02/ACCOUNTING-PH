import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { fmtDate, parseDateParam, today } from "@/lib/format";
import { LOAN_TYPES, debtSchedule } from "@/lib/debt/service";

export default async function DebtScheduleReport({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const asOf = parseDateParam((await searchParams).asOf, today());
  const { rows, tieOut } = await debtSchedule(ctx.org.id, new Date(`${asOf}T00:00:00.000Z`));
  const t = rows.reduce((s, r) => ({ o: s.o + r.loan.originalPrincipal.toNumber() * 100, d: s.d + r.drawn, rp: s.rp + r.repaid, p: s.p + r.bal.principal, u: s.u + r.bal.unamortized, c: s.c + r.bal.carrying, a: s.a + r.bal.accrued, cur: s.cur + r.bal.current, nc: s.nc + r.bal.nonCurrent }),
    { o: 0, d: 0n, rp: 0n, p: 0n, u: 0n, c: 0n, a: 0n, cur: 0n, nc: 0n });
  return (
    <>
      <div className="top"><h1>Debt Schedule</h1>
        <form className="row noprint" style={{ flex: 0, flexWrap: "nowrap" }}><div><label>As of</label><input type="date" name="asOf" defaultValue={asOf} /></div><div style={{ flex: 0 }}><button>Show</button></div></form></div>
      <p className="muted">As of {asOf}. Carrying amount = principal less unamortized transaction costs (amortized cost, PFRS 9). Run the <Link href="/debt/period-end">period-end run</Link> first so interest and the current portion are up to date.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Loan</th><th>Lender</th><th>Type</th><th className="num">Rate / EIR</th><th>Start</th><th>Maturity</th><th className="num">Original</th><th className="num">Drawn</th><th className="num">Repaid</th>
          <th className="num">Principal</th><th className="num">Unamortized costs</th><th className="num">Carrying amount</th><th className="num">Current</th><th className="num">Non-current</th><th className="num">Accrued interest</th></tr></thead>
        <tbody>
          {rows.map(({ loan, bal, drawn, repaid }) => (
            <tr key={loan.id}><td><Link href={`/debt/${loan.id}`}>{loan.number}</Link></td><td>{loan.lender}</td><td>{LOAN_TYPES[loan.loanType] ?? loan.loanType}</td>
              <td className="num">{Number(loan.interestRate)}%{loan.effectiveRate && <div className="muted">{Number(loan.effectiveRate).toFixed(2)}%</div>}</td>
              <td>{fmtDate(loan.startDate)}</td><td>{fmtDate(loan.maturityDate)}</td><td className="num">{formatPeso(BigInt(Math.round(loan.originalPrincipal.toNumber() * 100)))}</td>
              <td className="num">{formatPeso(drawn)}</td><td className="num">{formatPeso(repaid)}</td><td className="num">{formatPeso(bal.principal)}</td><td className="num">{formatPeso(bal.unamortized)}</td>
              <td className="num">{formatPeso(bal.carrying)}</td><td className="num">{formatPeso(bal.current)}</td><td className="num">{formatPeso(bal.nonCurrent)}</td><td className="num">{formatPeso(bal.accrued)}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={15} className="muted">No loans.</td></tr>}
          {rows.length > 0 && <tr className="total"><td colSpan={6}>Total</td><td className="num">{formatPeso(BigInt(Math.round(t.o)))}</td><td className="num">{formatPeso(t.d)}</td><td className="num">{formatPeso(t.rp)}</td><td className="num">{formatPeso(t.p)}</td>
            <td className="num">{formatPeso(t.u)}</td><td className="num">{formatPeso(t.c)}</td><td className="num">{formatPeso(t.cur)}</td><td className="num">{formatPeso(t.nc)}</td><td className="num">{formatPeso(t.a)}</td></tr>}
        </tbody>
      </table></div>
      <h2>Agreement with the general ledger</h2>
      <p className="muted">Sub-ledger balance of each loan account (credit positive) against the GL. A difference means something other than the Debt module posted to the account, such as a manual journal.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Account</th><th className="num">Per loans</th><th className="num">Per GL</th><th className="num">Difference</th></tr></thead>
        <tbody>{tieOut.map((x) => <tr key={x.account.id}><td><Link href={`/ledger?account=${x.account.id}`}>{x.account.code} · {x.account.name}</Link></td><td className="num">{formatPeso(x.subledger)}</td><td className="num">{formatPeso(x.gl)}</td>
          <td className={`num ${x.difference === 0n ? "diff-ok" : "diff-bad"}`}>{x.difference === 0n ? "agrees" : formatPeso(x.difference)}</td></tr>)}</tbody>
      </table></div>
    </>
  );
}
