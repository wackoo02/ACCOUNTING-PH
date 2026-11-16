import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { leaseLiabilitySummary } from "@/lib/leases/reports";

type SP = Promise<Record<string, string | undefined>>;
export default async function LiabilitySchedule({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const r = await leaseLiabilitySummary(ctx.org.id, to, from);
  const a = (c: bigint) => formatPeso(c, { blankZero: true });
  const cols = [["opening", "Beginning"], ["additions", "New leases"], ["remeasurements", "Remeasurements"], ["interest", "Interest"], ["payments", "Payments"], ["derecognized", "Derecognised"], ["closing", "End"], ["current", "Current"], ["nonCurrent", "Non-current"]] as const;
  const byCur = [...new Set(r.rows.map((x) => x.currency))];
  return (
    <>
      <div className="top"><h1>Lease Liability Schedule</h1><span className="muted">{ctx.org.name} · {from} to {to}</span></div>
      <form className="card row noprint"><div><label>From</label><input type="date" name="from" defaultValue={from} /></div><div><label>To</label><input type="date" name="to" defaultValue={to} /></div><div style={{ flex: 0 }}><button>Show</button></div></form>
      {byCur.map((cur) => { const rows = r.rows.filter((x) => x.currency === cur); return (
        <div key={cur} className="table-wrap"><table>
          <thead><tr><th>Lease ({cur})</th><th style={{ minWidth: 200 }}>Asset</th>{cols.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
          <tbody>
            {rows.map((x) => <tr key={x.id}><td><Link href={`/leases/${x.id}`}>{x.number}</Link></td><td>{x.asset}</td>{cols.map(([k]) => <td key={k} className="num">{a(x[k])}</td>)}</tr>)}
            <tr className="total"><td colSpan={2}>Total {cur}</td>{cols.map(([k]) => <td key={k} className="num">{a(rows.reduce((s, x) => s + x[k], 0n))}</td>)}</tr>
          </tbody>
        </table></div>); })}
      {r.rows.length === 0 && <p className="muted">No lease liabilities in this period.</p>}
      <p className="muted">Current = the part of the liability that reduces within 12 months of {to}. Open a lease for its month-by-month amortization schedule.</p>
    </>
  );
}
