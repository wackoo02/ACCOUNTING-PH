import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { fmtDate, parseDateParam, today } from "@/lib/format";
import { METRICS, covenantMetrics, evaluateCovenants } from "@/lib/debt/service";

const BADGE: Record<string, string> = { PASS: "POSTED", WATCH: "DRAFT", BREACH: "BREACH", WAIVED: "DRAFT", NO_DATA: "VOID" };

export default async function CovenantReport({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const asOf = parseDateParam((await searchParams).asOf, today());
  const d = new Date(`${asOf}T00:00:00.000Z`);
  const [results, m] = await Promise.all([evaluateCovenants(ctx.org.id, d), covenantMetrics(ctx.org.id, d)]);
  const x = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}x`);
  return (
    <>
      <div className="top"><h1>Covenant Monitoring</h1>
        <form className="row noprint" style={{ flex: 0, flexWrap: "nowrap" }}><div><label>Test date</label><input type="date" name="asOf" defaultValue={asOf} /></div><div style={{ flex: 0 }}><button>Show</button></div></form></div>
      <p className="muted">Balance sheet figures as of {asOf}; income figures for the 12 months {fmtDate(m.from)} to {asOf}. Watch = less than 10% headroom. A breach at the reporting date makes the loan current unless the lender&apos;s waiver, obtained by that date, runs at least 12 months (PAS 1.74–75).</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Loan</th><th>Covenant</th><th>Measure</th><th className="num">Required</th><th className="num">Actual</th><th className="num">Headroom</th><th>Status</th><th>Effect on classification</th></tr></thead>
        <tbody>
          {results.map((r) => {
            const peso = METRICS[r.covenant.metric]?.unit === "peso";
            return (
              <tr key={r.covenant.id}><td><Link href={`/debt/${r.loan.id}`}>{r.loan.number}</Link><div className="muted">{r.loan.lender}</div></td><td>{r.covenant.name}</td><td>{METRICS[r.covenant.metric]?.label}</td>
                <td className="num">{r.covenant.operator === "MIN" ? "≥" : "≤"} {peso ? Number(r.covenant.threshold).toLocaleString("en-PH", { minimumFractionDigits: 2 }) : Number(r.covenant.threshold)}</td>
                <td className="num">{r.value === null ? "—" : peso ? r.value.toLocaleString("en-PH", { minimumFractionDigits: 2 }) : r.value.toFixed(2)}</td>
                <td className="num">{r.headroomPct === null ? "" : `${r.headroomPct}%`}</td>
                <td><span className={`badge ${BADGE[r.status]}`}>{r.status.replace("_", " ")}</span>{r.covenant.waiverUntil && <div className="muted">waiver to {fmtDate(r.covenant.waiverUntil)}</div>}</td>
                <td>{r.classifyCurrent ? <span className="diff-bad">Whole loan current</span> : r.status === "BREACH" || r.status === "WAIVED" ? "Stays non-current (waiver)" : ""}</td></tr>
            );
          })}
          {results.length === 0 && <tr><td colSpan={8} className="muted">No covenants set up. Add them on each loan&apos;s page.</td></tr>}
        </tbody>
      </table></div>
      <h2>Figures used</h2>
      <div className="card grid">
        <div><label>Current ratio</label>{x(m.values.CURRENT_RATIO)}<div className="muted">{formatPeso(m.parts.ca)} / {formatPeso(m.parts.cl)}</div></div>
        <div><label>Loans outstanding</label>{formatPeso(m.parts.debt)}</div>
        <div><label>Total equity</label>{formatPeso(m.parts.equity)}</div>
        <div><label>Debt to equity</label>{x(m.values.DEBT_TO_EQUITY)}</div>
        <div><label>Liabilities to equity</label>{x(m.values.LIABILITIES_TO_EQUITY)}</div>
        <div><label>EBIT (12 months)</label>{formatPeso(m.parts.ebit)}</div>
        <div><label>EBITDA (12 months)</label>{formatPeso(m.parts.ebitda)}<div className="muted">depreciation and amortization {formatPeso(m.parts.da)}</div></div>
        <div><label>Interest expense (12 months)</label>{formatPeso(m.parts.interest)}</div>
        <div><label>Debt service paid (12 months)</label>{formatPeso(m.parts.debtService)}</div>
        <div><label>Interest coverage</label>{x(m.values.INTEREST_COVERAGE)}</div>
        <div><label>DSCR</label>{x(m.values.DSCR)}</div>
        <div><label>Net debt to EBITDA</label>{x(m.values.NET_DEBT_TO_EBITDA)}</div>
      </div>
    </>
  );
}
