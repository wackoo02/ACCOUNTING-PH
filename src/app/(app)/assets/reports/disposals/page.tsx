import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { disposalReport } from "@/lib/assets/reports";
import { PrintButton } from "@/components/PrintButton";

type SP = Promise<Record<string, string | undefined>>;

export default async function Disposals({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const r = await disposalReport(ctx.org.id, from, to);
  return (
    <>
      <div className="top"><h1>Disposal report</h1><PrintButton label="Print" /></div>
      <p className="print-only"><strong>{ctx.org.name}</strong> · {from} to {to}</p>
      <form className="card row noprint">
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Asset</th><th>Type</th><th>Buyer / reason</th><th className="num">Cost</th><th className="num">Accum. depreciation</th><th className="num">Net book value</th><th className="num">Proceeds</th><th className="num">Output VAT</th><th className="num">Gain (loss)</th></tr></thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={x.txn.id}>
              <td>{x.txn.date.toISOString().slice(0, 10)}</td><td>{x.txn.number}</td>
              <td><Link href={`/assets/${x.asset.id}`}>{x.asset.code}</Link> {x.asset.name}</td>
              <td>{x.txn.type === "DISPOSAL" ? "Sale" : "Retirement"}</td><td>{x.buyer ?? x.txn.memo}</td>
              <td className="num">{formatPeso(x.cost)}</td><td className="num">{formatPeso(x.accum)}</td><td className="num">{formatPeso(x.nbv)}</td>
              <td className="num">{formatPeso(x.proceeds, { blankZero: true })}</td><td className="num">{formatPeso(x.outputVat, { blankZero: true })}</td><td className="num">{formatPeso(x.gainLoss)}</td>
            </tr>
          ))}
          {r.rows.length === 0 && <tr><td colSpan={11} className="muted">No disposals or retirements in this period.</td></tr>}
          {r.rows.length > 0 && <tr className="total"><td colSpan={5}>Total</td><td className="num">{formatPeso(r.totals.cost)}</td><td className="num">{formatPeso(r.totals.accum)}</td><td className="num">{formatPeso(r.totals.nbv)}</td><td className="num">{formatPeso(r.totals.proceeds)}</td><td /><td className="num">{formatPeso(r.totals.gainLoss)}</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
