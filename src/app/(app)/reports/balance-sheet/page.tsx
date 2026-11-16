import { CustomizeLink } from "@/components/reporting/CustomizeLink";
import { requireCtx } from "@/lib/auth";
import { balanceSheet } from "@/lib/ledger/reports";
import { parseDateParam, today } from "@/lib/format";
import { SectionRows, TotalRow } from "@/components/Statement";
import { DimFilter, dimsFrom } from "@/components/DimFilter";

type SP = Promise<Record<string, string | undefined>>;

export default async function BalanceSheet({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = parseDateParam(sp.asOf, today());
  const r = await balanceSheet(ctx.org.id, new Date(asOf), { dims: dimsFrom(sp) });
  const detail = sp.detail === "1";
  const qs = `&to=${asOf}`;
  return (
    <>
      <div className="top"><h1>Statement of Financial Position</h1><CustomizeLink template="balance_sheet" to={asOf} /><span className="muted">{ctx.org.name} · as of {asOf}</span></div>
      <form className="card row noprint">
        <div><label>As of</label><input type="date" name="asOf" defaultValue={asOf} /></div>
        <DimFilter organizationId={ctx.org.id} sp={sp} />
        <div><label>Detail</label><select name="detail" defaultValue={sp.detail ?? ""}><option value="">Line items</option><option value="1">Show accounts</option></select></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="table-wrap"><table><tbody>
        <tr className="header"><td colSpan={2}><b>ASSETS</b></td></tr>
        <SectionRows s={r.nca} detail={detail} ledgerQs={qs} />
        <SectionRows s={r.ca} detail={detail} ledgerQs={qs} />
        <TotalRow label="TOTAL ASSETS" amount={r.totalAssets} strong />
        <tr className="header"><td colSpan={2}><b>EQUITY AND LIABILITIES</b></td></tr>
        <SectionRows s={r.equity} detail={detail} ledgerQs={qs} />
        <SectionRows s={r.ncl} detail={detail} ledgerQs={qs} />
        <SectionRows s={r.cl} detail={detail} ledgerQs={qs} />
        <TotalRow label="Total liabilities" amount={r.totalLiabilities} />
        <TotalRow label="TOTAL EQUITY AND LIABILITIES" amount={r.totalLE} strong />
      </tbody></table></div>
      <p className={r.balanced ? "diff-ok" : "diff-bad"}>{r.balanced ? "Assets = Liabilities + Equity ✓" : "Does not balance"}</p>
    </>
  );
}
