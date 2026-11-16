import { CustomizeLink } from "@/components/reporting/CustomizeLink";
import { requireCtx } from "@/lib/auth";
import { cashFlow } from "@/lib/ledger/reports";
import { formatPeso } from "@/lib/money";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { SectionRows, TotalRow } from "@/components/Statement";

type SP = Promise<Record<string, string | undefined>>;

export default async function CashFlow({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const r = await cashFlow(ctx.org.id, new Date(from), new Date(to));
  return (
    <>
      <div className="top"><h1>Statement of Cash Flows</h1><CustomizeLink template="cash_flow" from={from} to={to} /><span className="muted">{ctx.org.name} · {from} to {to} · indirect method</span></div>
      <form className="card row noprint">
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="table-wrap"><table><tbody>
        <SectionRows s={r.operating} />
        <SectionRows s={r.investing} />
        <SectionRows s={r.financing} />
        <TotalRow label="Net increase (decrease) in cash and cash equivalents" amount={r.netChange} />
        <tr><td>Cash and cash equivalents, beginning</td><td className="num">{formatPeso(r.openingCash)}</td></tr>
        <TotalRow label="Cash and cash equivalents, end" amount={r.openingCash + r.netChange} strong />
      </tbody></table></div>
      <p className={r.reconciles ? "diff-ok" : "diff-bad"}>{r.reconciles ? `Agrees with cash per books (${formatPeso(r.closingCash)}) ✓` : `Does not agree with cash per books (${formatPeso(r.closingCash)})`}</p>
    </>
  );
}
