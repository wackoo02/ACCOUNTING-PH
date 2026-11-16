import { requireCtx } from "@/lib/auth";
import { incomeStatement } from "@/lib/ledger/reports";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { SectionRows, TotalRow } from "@/components/Statement";
import { DimFilter, dimsFrom, dimsQs } from "@/components/DimFilter";

type SP = Promise<Record<string, string | undefined>>;

export default async function IncomeStatement({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const r = await incomeStatement(ctx.org.id, new Date(from), new Date(to), { dims: dimsFrom(sp) });
  const detail = sp.detail === "1";
  const qs = `&from=${from}&to=${to}${dimsQs(sp)}`;
  return (
    <>
      <div className="top"><h1>Statement of Profit or Loss</h1><span className="muted">{ctx.org.name} · {from} to {to}</span></div>
      <form className="card row noprint">
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <DimFilter organizationId={ctx.org.id} sp={sp} />
        <div><label>Detail</label><select name="detail" defaultValue={sp.detail ?? ""}><option value="">Line items</option><option value="1">Show accounts</option></select></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="table-wrap"><table><tbody>
        <SectionRows s={r.revenue} detail={detail} ledgerQs={qs} />
        <SectionRows s={r.cos} detail={detail} ledgerQs={qs} />
        <TotalRow label="Gross profit" amount={r.grossProfit} />
        <SectionRows s={r.otherIncome} detail={detail} ledgerQs={qs} />
        <SectionRows s={r.opex} detail={detail} ledgerQs={qs} />
        <SectionRows s={r.otherExp} detail={detail} ledgerQs={qs} />
        <TotalRow label="Operating profit" amount={r.operatingProfit} />
        <SectionRows s={r.finInc} detail={detail} ledgerQs={qs} />
        <SectionRows s={r.finCost} detail={detail} ledgerQs={qs} />
        <TotalRow label="Profit before tax" amount={r.profitBeforeTax} />
        <SectionRows s={r.tax} detail={detail} ledgerQs={qs} />
        <TotalRow label="Net profit (loss) for the period" amount={r.netProfit} strong />
      </tbody></table></div>
      <p className="muted">Excludes year-end closing entries. Amounts in parentheses are negative.</p>
    </>
  );
}
