import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { turnover } from "@/lib/inventory/reports";
import { formatQty } from "@/lib/inventory/qty";
import { InvFilters } from "../Filters";

type SP = Promise<Record<string, string | undefined>>;
const n2 = (x: number | null) => (x === null ? "—" : x.toFixed(2));

export default async function Turnover({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const r = await turnover(ctx.org.id, { from: new Date(from), to: new Date(to), warehouseId: sp.wh || undefined, category: sp.cat || undefined });
  return (
    <>
      <div className="top"><h1>Inventory Turnover</h1></div>
      <p className="muted">Turnover = cost of goods issued ÷ average inventory ((opening + closing) ÷ 2) for {from} to {to} ({r.days} days). Days on hand = days in the period ÷ turnover.</p>
      <InvFilters organizationId={ctx.org.id} sp={sp}>
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
      </InvFilters>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Category</th><th className="num">Opening</th><th className="num">Closing</th><th className="num">Average</th><th className="num">Qty used</th><th className="num">Cost of goods issued</th><th className="num">Turnover (x)</th><th className="num">Days on hand</th></tr></thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={x.itemId}>
              <td><Link href={`/inventory/items/${x.itemId}?from=${from}&to=${to}`}>{x.code}</Link> {x.name}</td><td>{x.category}</td>
              <td className="num">{formatPeso(x.opening)}</td><td className="num">{formatPeso(x.closing)}</td><td className="num">{formatPeso(x.average)}</td>
              <td className="num">{formatQty(x.qtyUsed)}</td><td className="num">{formatPeso(x.cogs)}</td><td className="num">{n2(x.turns)}</td><td className="num">{x.daysOnHand === null ? "—" : Math.round(x.daysOnHand)}</td>
            </tr>
          ))}
          {r.rows.length === 0 && <tr><td colSpan={9} className="muted">No inventory activity in this period.</td></tr>}
          <tr className="total"><td colSpan={2}>Total</td><td className="num">{formatPeso(r.totals.opening)}</td><td className="num">{formatPeso(r.totals.closing)}</td><td className="num">{formatPeso(r.totals.average)}</td><td />
            <td className="num">{formatPeso(r.totals.cogs)}</td><td className="num">{n2(r.totals.turns)}</td><td className="num">{r.totals.daysOnHand === null ? "—" : Math.round(r.totals.daysOnHand)}</td></tr>
        </tbody>
      </table></div>
    </>
  );
}
