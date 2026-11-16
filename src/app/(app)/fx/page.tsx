import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { today } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { revalueAction } from "../actions";

export default async function FX() {
  const ctx = await requireCtx("reports.view");
  const [accts, currencies] = await Promise.all([
    prisma.account.findMany({ where: { organizationId: ctx.org.id, currencyCode: { not: null } }, orderBy: { code: "asc" } }),
    prisma.currency.findMany({ where: { organizationId: ctx.org.id, code: { not: "PHP" } } }),
  ]);
  const rows = [];
  for (const a of accts) {
    const s = await prisma.journalLine.aggregate({ where: { organizationId: ctx.org.id, accountId: a.id, journalEntry: { status: "POSTED" } }, _sum: { debit: true, credit: true, fxDebit: true, fxCredit: true } });
    const c = (d: { toString(): string } | null) => toCentavos(d?.toString() ?? "0");
    rows.push({ a, fx: c(s._sum.fxDebit) - c(s._sum.fxCredit), base: c(s._sum.debit) - c(s._sum.credit) });
  }
  const used = [...new Set(accts.map((a) => a.currencyCode!))];
  return (
    <>
      <div className="top"><h1>Foreign Currency Revaluation</h1></div>
      <div className="card">
        <p style={{ marginTop: 0 }}>Under PAS 21 (IAS 21), monetary items in foreign currency are restated at the closing rate at each reporting date.</p>
        <ul className="muted" style={{ marginBottom: 0 }}>
          <li><b>Realized gain/loss</b>: when a foreign invoice is settled at a different rate, add a line to <i>7020 Foreign Exchange Gain - Realized</i> or <i>7530 Foreign Exchange Loss - Realized</i>. The journal form tells you the exact difference.</li>
          <li><b>Unrealized gain/loss</b>: run the revaluation below at month-end. It posts to <i>7025 / 7535 Unrealized</i> and reverses automatically on the 1st of next month.</li>
          <li>Mark an account as foreign currency by setting its <i>Account Currency</i> in the Chart of Accounts (e.g. a USD bank account).</li>
        </ul>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Account</th><th>Ccy</th><th className="num">Forex balance</th><th className="num">Book value (PHP)</th><th className="num">Implied rate</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.a.id}><td>{r.a.code} · {r.a.name}</td><td>{r.a.currencyCode}</td><td className="num">{formatPeso(r.fx)}</td><td className="num">{formatPeso(r.base)}</td>
            <td className="num">{r.fx === 0n ? "—" : (Number(r.base) / Number(r.fx)).toFixed(4)}</td></tr>)}
          {rows.length === 0 && <tr><td colSpan={5} className="muted">No foreign-currency accounts yet.</td></tr>}
        </tbody>
      </table></div>
      {can(ctx.role, "journal.post") && used.length > 0 && (
        <ActionForm action={revalueAction} className="card" style={{ marginTop: 12 }}>
          <div className="row">
            <div><label>Revaluation date (month-end)</label><input type="date" name="asOf" defaultValue={today()} required /></div>
            {used.map((c) => (
              <div key={c}><label>Closing rate: 1 {c} = ? PHP</label><input name={`rate_${c}`} className="num" defaultValue={currencies.find((x) => x.code === c)?.rateToBase.toString()} required /></div>
            ))}
            <div style={{ flex: 0 }}><button>Revalue and post</button></div>
          </div>
        </ActionForm>
      )}
    </>
  );
}
