import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { DIMENSIONS } from "@/lib/ledger/dimensions";
import { firstOfYear, today } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { runAllocationAction } from "../actions";
import { RuleForm } from "./RuleForm";

export default async function Allocations() {
  const ctx = await requireCtx("reports.view");
  const [rules, accounts, dims] = await Promise.all([
    prisma.allocationRule.findMany({ where: { organizationId: ctx.org.id }, orderBy: { createdAt: "desc" } }),
    prisma.account.findMany({ where: { organizationId: ctx.org.id, isPostable: true, isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.dimensionValue.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true, type: true } }),
  ]);
  const acct = (id: string | null) => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : "same account"; };
  const dv = (id: string) => dims.find((d) => d.id === id)?.code ?? "?";
  return (
    <>
      <div className="top"><h1>Allocations</h1></div>
      <p className="muted">Spread a shared cost (rent, utilities, head-office overhead) across departments, branches, projects or any dimension by fixed percentages. Running a rule takes the untagged balance of the source account for the period and creates an entry for approval.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Rule</th><th>From account</th><th>To account</th><th>Split by</th><th>Splits</th><th>Run for period</th></tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}><td>{r.name}</td><td>{acct(r.sourceAccountId)}</td><td>{acct(r.targetAccountId)}</td><td>{DIMENSIONS.find((d) => d.type === r.dimensionType)?.label}</td>
              <td>{(r.splits as { dimensionValueId: string; pct: string }[]).map((s) => `${dv(s.dimensionValueId)} ${s.pct}%`).join(", ")}</td>
              <td>{can(ctx.role, "journal.create") && (
                <ActionForm action={runAllocationAction}>
                  <input type="hidden" name="ruleId" value={r.id} />
                  <div className="row" style={{ gap: 4 }}>
                    <div><input type="date" name="from" defaultValue={firstOfYear()} aria-label="From" /></div>
                    <div><input type="date" name="to" defaultValue={today()} aria-label="To" /></div>
                    <div><input type="date" name="date" defaultValue={today()} aria-label="Posting date" title="Posting date" /></div>
                    <div style={{ flex: 0 }}><button className="secondary">Run</button></div>
                  </div>
                </ActionForm>
              )}</td></tr>
          ))}
          {rules.length === 0 && <tr><td colSpan={6} className="muted">No allocation rules yet.</td></tr>}
        </tbody>
      </table></div>
      {can(ctx.role, "journal.post") && (
        <>
          <h2>New allocation rule</h2>
          <RuleForm accounts={accounts} dims={dims} types={DIMENSIONS.map((d) => ({ type: d.type, label: d.label }))} />
        </>
      )}
    </>
  );
}
