import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { fmtDate, parseDateParam, today } from "@/lib/format";
import { slowMoving } from "@/lib/inventory/reports";
import { formatQty } from "@/lib/inventory/qty";
import { InvFilters } from "../Filters";

type SP = Promise<Record<string, string | undefined>>;

export default async function SlowMoving({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = parseDateParam(sp.asOf, today());
  const days = Math.max(1, Number(sp.days) || 90);
  const r = await slowMoving(ctx.org.id, { asOf: new Date(asOf), days, warehouseId: sp.wh || undefined, category: sp.cat || undefined });
  return (
    <>
      <div className="top"><h1>Slow Moving and Non-moving Inventory</h1></div>
      <p className="muted">Items with stock on hand and no issue or sale in the last {days} days up to {asOf}, largest value first.</p>
      <InvFilters organizationId={ctx.org.id} sp={sp}>
        <div><label>No movement for (days)</label><input type="number" name="days" min={1} defaultValue={days} /></div>
        <div><label>As of</label><input type="date" name="asOf" defaultValue={asOf} /></div>
      </InvFilters>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Category</th><th>Warehouse</th><th className="num">On hand</th><th className="num">Value</th><th>Last issue</th><th className="num">Days idle</th><th>Last receipt</th></tr></thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={`${x.itemId}-${x.warehouseCode}`}>
              <td><Link href={`/inventory/items/${x.itemId}`}>{x.code}</Link> {x.name}</td><td>{x.category}</td><td>{x.warehouseCode}</td>
              <td className="num">{formatQty(x.qty)}</td><td className="num">{formatPeso(x.value)}</td>
              <td>{x.lastIssue ? fmtDate(x.lastIssue) : <span className="badge DRAFT">NEVER ISSUED</span>}</td><td className="num">{x.daysIdle ?? ""}</td><td>{x.lastReceipt ? fmtDate(x.lastReceipt) : ""}</td>
            </tr>
          ))}
          {r.rows.length === 0 && <tr><td colSpan={8} className="muted">Nothing slow moving.</td></tr>}
          <tr className="total"><td colSpan={4}>Total</td><td className="num">{formatPeso(r.total)}</td><td colSpan={3} /></tr>
        </tbody>
      </table></div>
    </>
  );
}
