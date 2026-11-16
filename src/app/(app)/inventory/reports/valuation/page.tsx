import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { parseDateParam, today } from "@/lib/format";
import { valuation } from "@/lib/inventory/reports";
import { COSTING_LABELS } from "@/lib/inventory/engine";
import { formatQty, formatUnitCost } from "@/lib/inventory/qty";
import { InvFilters } from "../Filters";

type SP = Promise<Record<string, string | undefined>>;

export default async function Valuation({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = parseDateParam(sp.asOf, today());
  const r = await valuation(ctx.org.id, { asOf: new Date(asOf), warehouseId: sp.wh || undefined, category: sp.cat || undefined });
  return (
    <>
      <div className="top"><h1>Inventory Valuation as of {asOf}</h1></div>
      <p className="muted">At cost under PAS 2, using each item&apos;s costing method (FIFO, weighted average or specific identification).</p>
      <InvFilters organizationId={ctx.org.id} sp={sp}><div><label>As of</label><input type="date" name="asOf" defaultValue={asOf} /></div></InvFilters>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Category</th><th>Warehouse</th><th>Costing</th><th className="num">Quantity</th><th>Unit</th><th className="num">Unit cost</th><th className="num">Value</th></tr></thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={`${x.itemId}-${x.warehouseCode}`}>
              <td><Link href={`/inventory/items/${x.itemId}?to=${asOf}`}>{x.code}</Link> {x.name}</td><td>{x.category}</td><td>{x.warehouseCode}</td><td>{COSTING_LABELS[x.method]}</td>
              <td className="num">{formatQty(x.qty)}</td><td>{x.unit}</td><td className="num">{formatUnitCost(x.unitCost)}</td><td className="num">{formatPeso(x.value)}</td>
            </tr>
          ))}
          {r.rows.length === 0 && <tr><td colSpan={8} className="muted">No stock on hand at this date.</td></tr>}
          <tr className="total"><td colSpan={7}>Total inventory at cost</td><td className="num">{formatPeso(r.total)}</td></tr>
        </tbody>
      </table></div>
      <h2>Agreement with the general ledger</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Inventory GL account</th><th className="num">GL balance</th></tr></thead>
        <tbody>
          {r.gl.map((a) => <tr key={a.code}><td>{a.code} · {a.name}</td><td className="num">{formatPeso(a.balance)}</td></tr>)}
          <tr className="total"><td>Total per GL</td><td className="num">{formatPeso(r.glTotal)}</td></tr>
          {r.glDifference !== null && <tr className="total"><td>Difference (GL − stock ledger)</td><td className="num">{formatPeso(r.glDifference)}</td></tr>}
        </tbody>
      </table></div>
      {r.glDifference === null ? <p className="muted">Clear the warehouse and category filters to compare with the GL.</p>
        : r.glDifference !== 0n ? <div className="errors">The GL differs from the stock ledger. Usually this is a manual journal posted to an inventory account, or opening balances entered as a journal instead of a receipt. Inventory accounts should only be changed through inventory documents.</div>
        : <div className="notice">The stock ledger agrees with the GL.</div>}
    </>
  );
}
