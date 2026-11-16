import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { parseDateParam, today } from "@/lib/format";
import { maturityAnalysis } from "@/lib/leases/reports";

type SP = Promise<Record<string, string | undefined>>;
export default async function Maturity({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = parseDateParam(sp.asOf, today());
  const r = await maturityAnalysis(ctx.org.id, asOf);
  const a = (c: bigint) => formatPeso(c, { blankZero: true });
  const curs = [...new Set(r.rows.map((x) => x.currency))];
  return (
    <>
      <div className="top"><h1>Lease Liability Maturity Analysis</h1><span className="muted">{ctx.org.name} · as of {asOf}</span></div>
      <form className="card row noprint"><div><label>As of</label><input type="date" name="asOf" defaultValue={asOf} /></div><div style={{ flex: 0 }}><button>Show</button></div></form>
      {curs.map((cur) => { const rows = r.rows.filter((x) => x.currency === cur); const sum = (f: (x: typeof rows[number]) => bigint) => rows.reduce((s, x) => s + f(x), 0n); return (
        <div key={cur} className="table-wrap"><table>
          <thead><tr><th>Lease ({cur})</th>{r.buckets.map((b) => <th key={b} className="num">{b}</th>)}<th className="num">Total undiscounted</th><th className="num">Less: future interest</th><th className="num">Lease liability</th></tr></thead>
          <tbody>
            {rows.map((x) => <tr key={x.id}><td><Link href={`/leases/${x.id}`}>{x.number}</Link><div className="muted">{x.asset}</div></td>{x.buckets.map((v, i) => <td key={i} className="num">{a(v)}</td>)}<td className="num">{a(x.total)}</td><td className="num">({a(x.futureInterest)})</td><td className="num">{a(x.carrying)}</td></tr>)}
            <tr className="total"><td>Total {cur}</td>{r.buckets.map((_, i) => <td key={i} className="num">{a(sum((x) => x.buckets[i]))}</td>)}<td className="num">{a(sum((x) => x.total))}</td><td className="num">({a(sum((x) => x.futureInterest))})</td><td className="num">{a(sum((x) => x.carrying))}</td></tr>
          </tbody>
        </table></div>); })}
      {r.rows.length === 0 && <p className="muted">No lease liabilities at this date.</p>}
      <p className="muted">Contractual undiscounted cash flows after {asOf} (PFRS 16.58 and PFRS 7.39), excluding VAT, reconciled to the lease liability. Use a month-end date so the liability matches the posted schedule.</p>
    </>
  );
}
