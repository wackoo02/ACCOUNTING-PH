import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { parseDateParam, today } from "@/lib/format";
import { AGING_BUCKETS, aging } from "@/lib/inventory/reports";
import { formatQty } from "@/lib/inventory/qty";
import { InvFilters } from "../Filters";

type SP = Promise<Record<string, string | undefined>>;

export default async function Aging({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = parseDateParam(sp.asOf, today());
  const r = await aging(ctx.org.id, { asOf: new Date(asOf), warehouseId: sp.wh || undefined, category: sp.cat || undefined });
  return (
    <>
      <div className="top"><h1>Inventory Aging</h1></div>
      <p className="muted">Stock on hand now, aged by the date it was received (transfers keep the original date), with ages counted to {asOf}. Use it with Slow Moving Inventory when reviewing write-downs to net realizable value (PAS 2).</p>
      <InvFilters organizationId={ctx.org.id} sp={sp}><div><label>Age as of</label><input type="date" name="asOf" defaultValue={asOf} /></div></InvFilters>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Warehouse</th><th className="num">Qty</th>{AGING_BUCKETS.map((b) => <th key={b.label} className="num">{b.label}</th>)}<th className="num">Total</th><th className="num">Oldest (days)</th></tr></thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={`${x.itemId}-${x.warehouseCode}`}>
              <td><Link href={`/inventory/items/${x.itemId}`}>{x.code}</Link> {x.name}</td><td>{x.warehouseCode}</td><td className="num">{formatQty(x.qty)}</td>
              {x.buckets.map((b, j) => <td key={j} className="num">{formatPeso(b.value, { blankZero: true })}</td>)}
              <td className="num">{formatPeso(x.value)}</td><td className="num">{x.oldestDays}</td>
            </tr>
          ))}
          {r.rows.length === 0 && <tr><td colSpan={AGING_BUCKETS.length + 5} className="muted">No stock on hand.</td></tr>}
          <tr className="total"><td colSpan={3}>Total</td>{r.totals.map((t, j) => <td key={j} className="num">{formatPeso(t)}</td>)}<td className="num">{formatPeso(r.total)}</td><td /></tr>
          {r.total > 0n && <tr><td colSpan={3} className="muted">% of total</td>{r.totals.map((t, j) => <td key={j} className="num muted">{((Number(t) / Number(r.total)) * 100).toFixed(1)}%</td>)}<td /><td /></tr>}
        </tbody>
      </table></div>
    </>
  );
}
