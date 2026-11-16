import { CustomizeLink } from "@/components/reporting/CustomizeLink";
import { requireCtx } from "@/lib/auth";
import { consolidatedTrialBalance } from "@/lib/ledger/reports";
import { groupOf } from "@/lib/group";
import { formatPeso } from "@/lib/money";
import { parseDateParam, today } from "@/lib/format";

type SP = Promise<Record<string, string | undefined>>;

export default async function Consolidated({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = parseDateParam(sp.asOf, today());
  const group = await groupOf(ctx.user.id, ctx.org.id);
  const r = await consolidatedTrialBalance(group.map((g) => g.id), new Date(asOf));
  return (
    <>
      <div className="top"><h1>Consolidated Trial Balance</h1><CustomizeLink template="balance_sheet_entity" to={asOf} /><span className="muted">{ctx.org.name} group · as of {asOf}</span></div>
      <p className="muted">Includes {group.map((g) => g.name).join(", ")}. Intercompany balances tagged with a counterparty in the group are eliminated. Switch to the parent entity to consolidate the whole group. Debit balances positive, credits in parentheses.</p>
      <form className="card row noprint"><div><label>As of</label><input type="date" name="asOf" defaultValue={asOf} /></div><div style={{ flex: 0 }}><button>Show</button></div></form>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Account</th>{group.map((g) => <th key={g.id} className="num">{g.code ?? g.name}</th>)}<th className="num">Combined</th><th className="num">Eliminations</th><th className="num">Consol. adj.</th><th className="num">Consolidated</th></tr></thead>
        <tbody>
          {r.rows.filter((x) => x.combined !== 0n || x.adjustment !== 0n).map((x) => (
            <tr key={x.code + x.name}><td>{x.code}</td><td>{x.name}</td>
              {group.map((g) => <td key={g.id} className="num">{formatPeso(x.entities.get(g.id) ?? 0n, { blankZero: true })}</td>)}
              <td className="num">{formatPeso(x.combined)}</td><td className="num">{formatPeso(x.elimination, { blankZero: true })}</td>
              <td className="num">{formatPeso(x.adjustment, { blankZero: true })}</td><td className="num"><b>{formatPeso(x.consolidated)}</b></td></tr>
          ))}
          <tr className="total"><td colSpan={2 + group.length + 3}>Net (should be zero)</td><td className="num">{formatPeso(r.total)}</td></tr>
        </tbody>
      </table></div>
    </>
  );
}
