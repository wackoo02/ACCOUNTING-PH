import { CustomizeLink } from "@/components/reporting/CustomizeLink";
import { Fragment } from "react";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { budgetVsActual } from "@/lib/ledger/reports";
import { fiscalStart } from "@/lib/budgets";
import { fiscalYearOf } from "@/lib/ledger/service";
import { formatPeso } from "@/lib/money";
import { ActionForm } from "@/components/ActionForm";
import { uploadBudget } from "../../actions";

type SP = Promise<Record<string, string | undefined>>;

export default async function BudgetVsActual({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const fy = Number(sp.fy) || fiscalYearOf(org.fiscalYearStartMonth, new Date());
  const { start, labels } = await fiscalStart(ctx.org.id, fy);
  const mFrom = Math.min(12, Math.max(1, Number(sp.m1) || 1));
  const mTo = Math.min(12, Math.max(mFrom, Number(sp.m2) || 12));
  const dims = await prisma.dimensionValue.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ type: "asc" }, { code: "asc" }] });
  const r = await budgetVsActual(ctx.org.id, fy, start, mFrom, mTo, sp.dim || undefined);
  const rows = r.rows.filter((x) => x.account.type === "INCOME" || x.account.type === "EXPENSE" || x.budget !== 0n);
  const tot = (t: string) => rows.filter((x) => x.account.type === t).reduce((s, x) => ({ budget: s.budget + x.budget, actual: s.actual + x.actual, annual: s.annual + x.annual }), { budget: 0n, actual: 0n, annual: 0n });
  const inc = tot("INCOME"), exp = tot("EXPENSE");
  const pct = (v: bigint, b: bigint) => (b === 0n ? "—" : `${(Number((v * 10000n) / (b < 0n ? -b : b)) / 100).toFixed(1)}%`);
  return (
    <>
      <div className="top"><h1>Budget vs Actual · FY{fy}</h1><CustomizeLink template="budget_vs_actual" />
        <a className="btn secondary noprint" href={`/api/budgets/${fy}`}>Download budget template (Excel)</a></div>
      {can(ctx.role, "masters.manage") && (
        <ActionForm action={uploadBudget} className="card noprint">
          <input type="hidden" name="year" value={fy} />
          <div className="row">
            <div style={{ flex: 3 }}><label>Upload FY{fy} budget (annual and monthly amounts per account, optionally per department/project)</label><input type="file" name="file" accept=".xlsx" required /></div>
            <div style={{ flex: 0 }}><button>Upload budget</button></div>
          </div>
        </ActionForm>
      )}
      <form className="card row noprint">
        <div><label>Fiscal year</label><input name="fy" type="number" defaultValue={fy} /></div>
        <div><label>From period</label><select name="m1" defaultValue={mFrom}>{labels.map((l, i) => <option key={i} value={i + 1}>P{i + 1} {l}</option>)}</select></div>
        <div><label>To period</label><select name="m2" defaultValue={mTo}>{labels.map((l, i) => <option key={i} value={i + 1}>P{i + 1} {l}</option>)}</select></div>
        <div><label>Budget for</label><select name="dim" defaultValue={sp.dim ?? ""}><option value="">Whole company</option>{dims.map((d) => <option key={d.id} value={d.id}>{d.type.replace("_", " ")}: {d.code} · {d.name}</option>)}</select></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Account</th><th className="num">Annual budget</th><th className="num">Budget (P{mFrom}–P{mTo})</th><th className="num">Actual</th><th className="num">Variance</th><th className="num">Variance %</th></tr></thead>
        <tbody>
          {(["INCOME", "EXPENSE"] as const).map((t) => (
            <Fragment key={t}>
              <tr className="header"><td colSpan={7}>{t === "INCOME" ? "Income" : "Expenses"}</td></tr>
              {rows.filter((x) => x.account.type === t).map((x) => (
                <tr key={x.account.id}><td>{x.account.code}</td><td>{x.account.name}</td>
                  <td className="num">{formatPeso(x.annual, { blankZero: true })}</td><td className="num">{formatPeso(x.budget, { blankZero: true })}</td>
                  <td className="num">{formatPeso(x.actual, { blankZero: true })}</td>
                  <td className={`num ${x.variance < 0n ? "diff-bad" : ""}`}>{formatPeso(x.variance)}</td>
                  <td className={`num ${x.variance < 0n ? "diff-bad" : ""}`}>{x.pct === null ? "—" : `${x.pct.toFixed(1)}%`}</td></tr>
              ))}
            </Fragment>
          ))}
          <tr className="total"><td colSpan={2}>Net income</td><td className="num">{formatPeso(inc.annual - exp.annual)}</td><td className="num">{formatPeso(inc.budget - exp.budget)}</td>
            <td className="num">{formatPeso(inc.actual - exp.actual)}</td><td className="num">{formatPeso(inc.actual - exp.actual - (inc.budget - exp.budget))}</td>
            <td className="num">{pct(inc.actual - exp.actual - (inc.budget - exp.budget), inc.budget - exp.budget)}</td></tr>
        </tbody>
      </table></div>
      <p className="muted">Variance is favourable when positive: income above budget, or expenses below budget. Unfavourable variances are in red.</p>
    </>
  );
}
