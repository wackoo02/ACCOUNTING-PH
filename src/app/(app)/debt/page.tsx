import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { LOAN_TYPES, debtAging } from "@/lib/debt/service";

export default async function Loans() {
  const ctx = await requireCtx("reports.view");
  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  const aging = await debtAging(ctx.org.id, today);
  const all = await prisma.loan.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ status: "asc" }, { number: "asc" }] });
  const byId = new Map(aging.map((a) => [a.loan.id, a]));
  const tot = aging.reduce((s, a) => ({ p: s.p + a.balance.principal, cur: s.cur + a.balance.current, nc: s.nc + a.balance.nonCurrent, acc: s.acc + a.balance.accrued, od: s.od + a.overdue.reduce((x, y) => x + y, 0n) }), { p: 0n, cur: 0n, nc: 0n, acc: 0n, od: 0n });
  const manage = can(ctx.role, "journal.post");
  return (
    <>
      <div className="top"><h1>Loans and Borrowings</h1>
        <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}>
          {manage && <Link className="btn" href="/debt/new">New loan</Link>}
          {manage && <Link className="btn secondary" href="/debt/period-end">Period-end run</Link>}
        </div>
      </div>
      <div className="grid">
        <div className="card stat"><div className="l">Principal outstanding</div><div className="n">{formatPeso(tot.p)}</div></div>
        <div className="card stat"><div className="l">Current portion</div><div className="n">{formatPeso(tot.cur)}</div></div>
        <div className="card stat"><div className="l">Non-current portion</div><div className="n">{formatPeso(tot.nc)}</div></div>
        <div className="card stat"><div className="l">Accrued interest</div><div className="n">{formatPeso(tot.acc)}</div></div>
        <div className="card stat"><div className="l">Past due installments</div><div className={`n ${tot.od ? "diff-bad" : ""}`}>{formatPeso(tot.od)}</div></div>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Loan no.</th><th>Lender</th><th>Type</th><th className="num">Rate</th><th>Maturity</th><th className="num">Principal</th><th className="num">Current</th><th className="num">Non-current</th><th>Next due</th><th className="num">Amount due</th><th>Status</th></tr></thead>
        <tbody>
          {all.map((l) => {
            const a = byId.get(l.id);
            const od = a ? a.overdue.reduce((x, y) => x + y, 0n) : 0n;
            return (
              <tr key={l.id}>
                <td><Link href={`/debt/${l.id}`}>{l.number}</Link></td><td>{l.lender}</td><td>{LOAN_TYPES[l.loanType] ?? l.loanType}</td>
                <td className="num">{Number(l.interestRate)}%</td><td>{fmtDate(l.maturityDate)}</td>
                <td className="num">{formatPeso(a?.balance.principal ?? 0n)}</td><td className="num">{formatPeso(a?.balance.current ?? 0n)}</td><td className="num">{formatPeso(a?.balance.nonCurrent ?? 0n)}</td>
                <td>{a?.nextDue ? fmtDate(a.nextDue.dueDate) : "—"}</td><td className="num">{a?.nextDue ? formatPeso(a.nextDue.unpaid) : ""}</td>
                <td>{od > 0n ? <span className="badge BREACH">PAST DUE</span> : <span className={`badge ${l.status === "ACTIVE" ? "POSTED" : "VOID"}`}>{l.status === "ACTIVE" ? (l.lastAccrualDate ? "ACTIVE" : "NOT DRAWN") : "SETTLED"}</span>}</td>
              </tr>
            );
          })}
          {all.length === 0 && <tr><td colSpan={11} className="muted">No loans yet. Add one with New loan, then record its drawdown.</td></tr>}
        </tbody>
      </table></div>
      <p className="noprint">Reports: <Link href="/debt/reports/schedule">Debt schedule</Link> · <Link href="/debt/reports/aging">Debt aging and maturity</Link> · <Link href="/debt/reports/covenants">Covenant monitoring</Link></p>
    </>
  );
}
