import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { parseDateParam } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { periodEndAction } from "../../debt-actions";
import { reclassify } from "@/lib/debt/service";

function monthEnd() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

export default async function PeriodEnd({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const ctx = await requireCtx("journal.post");
  const date = parseDateParam((await searchParams).date, monthEnd());
  const preview = await reclassify(ctx.org.id, ctx.user.id, new Date(`${date}T00:00:00.000Z`), false);
  return (
    <>
      <div className="top"><h1>Debt period-end run</h1></div>
      <p className="muted">Run at each month-end (or before any financial statements): accrues interest on every active loan up to the date at the effective rate, then moves principal falling due within the next 12 months from non-current to current (PAS 1). A loan with a covenant breached at the date, and no lender waiver covering at least 12 months, is shown as current in full.</p>
      <form className="card row noprint"><div><label>Period-end date</label><input type="date" name="date" defaultValue={date} /></div><div style={{ flex: 0 }}><button className="secondary">Preview</button></div></form>
      <div className="table-wrap"><table>
        <thead><tr><th>Loan</th><th>Lender</th><th className="num">Principal</th><th className="num">Current now</th><th className="num">Current should be</th><th className="num">Reclassify (LT → ST)</th><th>Note</th></tr></thead>
        <tbody>
          {preview.map((r) => (
            <tr key={r.loan.id}><td>{r.loan.number}</td><td>{r.loan.lender}</td><td className="num">{formatPeso(r.principal)}</td><td className="num">{formatPeso(r.current)}</td>
              <td className="num">{formatPeso(r.target)}</td><td className="num">{formatPeso(r.change, { blankZero: true })}</td><td>{r.breached && <span className="badge BREACH">COVENANT BREACH</span>}</td></tr>
          ))}
          {preview.length === 0 && <tr><td colSpan={7} className="muted">No active drawn loans.</td></tr>}
        </tbody>
      </table></div>
      <p className="muted">The preview uses balances before this run&apos;s interest accrual; principal amounts are not affected by the accrual.</p>
      <ActionForm action={periodEndAction} confirm={`Accrue interest and reclassify all loans as of ${date}?`}>
        <input type="hidden" name="date" value={date} />
        <div className="row" style={{ gap: 8 }}>
          <button name="op" value="run">Accrue interest and reclassify as of {date}</button>
          <button name="op" value="reclass" className="secondary">Reclassify only</button>
        </div>
      </ActionForm>
    </>
  );
}
