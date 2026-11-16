import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { parseDateParam } from "@/lib/format";
import { interestSchedule } from "@/lib/leases/reports";

type SP = Promise<Record<string, string | undefined>>;
export default async function InterestSchedule({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const y = new Date().getUTCFullYear();
  const from = parseDateParam(sp.from, `${y}-01-01`), to = parseDateParam(sp.to, `${y}-12-31`);
  const r = await interestSchedule(ctx.org.id, from, to);
  const a = (c: bigint) => formatPeso(c, { blankZero: true });
  return (
    <>
      <div className="top"><h1>Lease Interest Expense Schedule</h1><span className="muted">{ctx.org.name} · {from} to {to}</span></div>
      <form className="card row noprint"><div><label>From</label><input type="date" name="from" defaultValue={from} /></div><div><label>To</label><input type="date" name="to" defaultValue={to} /></div><div style={{ flex: 0 }}><button>Show</button></div></form>
      <div className="table-wrap"><table>
        <thead><tr><th>Lease</th><th>Cur.</th>{r.months.map((m) => <th key={m} className="num">{m}</th>)}<th className="num">Total</th><th className="num">Posted</th><th className="num">Still to post</th></tr></thead>
        <tbody>
          {r.rows.map((x) => <tr key={x.id}><td><Link href={`/leases/${x.id}`}>{x.number}</Link><div className="muted">{x.asset}</div></td><td>{x.currency}</td>{x.byMonth.map((v, i) => <td key={i} className="num">{a(v)}</td>)}<td className="num"><b>{a(x.total)}</b></td><td className="num">{a(x.posted)}</td><td className="num">{a(x.total - x.posted)}</td></tr>)}
          {r.rows.length === 0 && <tr><td colSpan={r.months.length + 5} className="muted">No lease interest in this period.</td></tr>}
          {r.rows.length > 0 && <tr className="total"><td colSpan={2}>Total</td>{r.months.map((_, i) => <td key={i} className="num">{a(r.rows.reduce((s, x) => s + x.byMonth[i], 0n))}</td>)}<td className="num">{a(r.rows.reduce((s, x) => s + x.total, 0n))}</td><td className="num">{a(r.rows.reduce((s, x) => s + x.posted, 0n))}</td><td className="num">{a(r.rows.reduce((s, x) => s + x.total - x.posted, 0n))}</td></tr>}
        </tbody>
      </table></div>
      <p className="muted">Includes months not yet posted, so it doubles as a finance cost forecast. Amounts in each lease&apos;s currency.</p>
    </>
  );
}
