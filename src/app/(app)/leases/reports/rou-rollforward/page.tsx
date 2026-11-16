import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { rouRollforward } from "@/lib/leases/reports";

type SP = Promise<Record<string, string | undefined>>;
export default async function RouRollforward({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const r = await rouRollforward(ctx.org.id, from, to);
  const a = (c: bigint) => formatPeso(c, { blankZero: true });
  const cols: [keyof typeof r.total, string][] = [["costOpening", "Cost, beginning"], ["additions", "Additions"], ["remeasurements", "Remeasurements"], ["derecognized", "Derecognised"], ["costClosing", "Cost, end"],
    ["accOpening", "Acc. dep., beginning"], ["depreciation", "Depreciation"], ["accDerecognized", "Derecognised"], ["accClosing", "Acc. dep., end"], ["nbvClosing", "Carrying amount, end"]];
  return (
    <>
      <div className="top"><h1>Right-of-Use Asset Rollforward</h1><span className="muted">{ctx.org.name} · {from} to {to}</span></div>
      <form className="card row noprint"><div><label>From</label><input type="date" name="from" defaultValue={from} /></div><div><label>To</label><input type="date" name="to" defaultValue={to} /></div><div style={{ flex: 0 }}><button>Show</button></div></form>
      <div className="table-wrap"><table>
        <thead><tr><th>Lease</th><th>Asset</th>{cols.map(([k, l]) => <th key={k} className="num">{l}</th>)}</tr></thead>
        <tbody>
          {r.rows.map((x) => <tr key={x.id}><td><Link href={`/leases/${x.id}`}>{x.number}</Link></td><td>{x.asset}<div className="muted">{x.lessor}</div></td>{cols.map(([k]) => <td key={k} className="num">{a(x[k])}</td>)}</tr>)}
          {r.rows.length === 0 && <tr><td colSpan={12} className="muted">No right-of-use assets in this period.</td></tr>}
          <tr className="total"><td colSpan={2}>Total</td>{cols.map(([k]) => <td key={k} className="num">{a(r.total[k])}</td>)}</tr>
        </tbody>
      </table></div>
      <p className="muted">In {ctx.org.name}&apos;s base currency. Additions include leases taken up at go-live. Short-term and low-value leases have no ROU asset and are not listed.</p>
    </>
  );
}
