import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { rollforward } from "@/lib/assets/reports";
import { PrintButton } from "@/components/PrintButton";

type SP = Promise<Record<string, string | undefined>>;

export default async function Rollforward({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const by = sp.by === "account" || sp.by === "location" ? sp.by : "category";
  const r = await rollforward(ctx.org.id, from, to, by);
  const rows = [...r.rows, r.total];
  const f = (v: bigint) => formatPeso(v, { blankZero: true });
  return (
    <>
      <div className="top"><h1>Property and equipment rollforward</h1><PrintButton label="Print" /></div>
      <p className="print-only"><strong>{ctx.org.name}</strong> · {from} to {to}</p>
      <form className="card row noprint">
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <div><label>Group by</label><select name="by" defaultValue={by}><option value="category">Category</option><option value="account">GL account</option><option value="location">Location</option></select></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <p className="muted">The PAS 16.73 reconciliation of carrying amounts for the notes to the financial statements. &quot;Additions&quot; includes assets brought into the register with their opening balances.</p>
      <h2>Cost</h2>
      <div className="table-wrap"><table>
        <thead><tr><th /><th className="num">Beginning</th><th className="num">Additions</th><th className="num">Improvements</th><th className="num">Disposals / retirements</th><th className="num">Ending</th></tr></thead>
        <tbody>{rows.map((x) => <tr key={x.key} className={x === r.total ? "total" : ""}><td>{x.key}</td><td className="num">{f(x.openCost)}</td><td className="num">{f(x.additions)}</td><td className="num">{f(x.improvements)}</td><td className="num">{f(x.disposals)}</td><td className="num">{f(x.closeCost)}</td></tr>)}</tbody>
      </table></div>
      <h2>Accumulated depreciation</h2>
      <div className="table-wrap"><table>
        <thead><tr><th /><th className="num">Beginning</th><th className="num">Depreciation</th><th className="num">Disposals / other</th><th className="num">Ending</th></tr></thead>
        <tbody>{rows.map((x) => <tr key={x.key} className={x === r.total ? "total" : ""}><td>{x.key}</td><td className="num">{f(x.openAccum)}</td><td className="num">{f(x.depreciation)}</td><td className="num">{f(x.accumDisposals)}</td><td className="num">{f(x.closeAccum)}</td></tr>)}</tbody>
      </table></div>
      <h2>Net book value</h2>
      <div className="table-wrap"><table>
        <thead><tr><th /><th className="num">Beginning</th><th className="num">Ending</th></tr></thead>
        <tbody>{rows.map((x) => <tr key={x.key} className={x === r.total ? "total" : ""}><td>{x.key}</td><td className="num">{f(x.openNbv)}</td><td className="num">{f(x.closeNbv)}</td></tr>)}</tbody>
      </table></div>
    </>
  );
}
