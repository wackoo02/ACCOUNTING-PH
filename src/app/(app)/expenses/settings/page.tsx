import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { mappingTable } from "@/lib/expense/service";
import { CONNECTORS, MODULES } from "@/lib/expense/catalog";
import { ActionForm } from "@/components/ActionForm";

import { saveMappingAction } from "../../expense-actions";

export default async function MobilitySettings() {
  const ctx = await requireCtx("reports.view");
  const [map, accounts] = await Promise.all([
    mappingTable(ctx.org.id),
    prisma.account.findMany({ where: { organizationId: ctx.org.id, isActive: true, isPostable: true, OR: [{ type: "EXPENSE" }, { systemRole: "INVENTORY_IN_TRANSIT" }] }, orderBy: { code: "asc" } }),
  ]);
  const admin = can(ctx.role, "masters.manage");
  return (
    <>
      <h1>Mobility settings</h1>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>GL mapping</h3>
        <p className="muted">The account each kind of claim is charged to. The credit side follows who paid: the corporate wallet or card account, Employee Reimbursements Payable, or the petty cash fund.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Module</th><th>Transaction type</th><th>Debit account</th>{admin && <th />}</tr></thead>
          <tbody>{map.map((t) => (
            <tr key={t.key}>
              <td>{MODULES[t.module].label}</td><td>{t.label}</td>
              <td>{admin ? (
                <ActionForm action={saveMappingAction} className="row">
                  <input type="hidden" name="transactionType" value={t.key} />
                  <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    <select name="accountId" defaultValue={t.account?.id ?? ""}><option value="">Default ({t.codes.join(" or ")})</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select>
                    <button className="secondary">Save</button>
                  </div>
                </ActionForm>
              ) : t.account ? `${t.account.code} ${t.account.name}` : <span className="diff-bad">Not mapped</span>}</td>
              {admin && <td>{t.custom ? <span className="badge X-APPROVED">Custom</span> : <span className="muted">Default</span>}</td>}
            </tr>
          ))}</tbody>
        </table></div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Provider connections</h3>
        <p className="muted">What works today without any agreement, and what needs a business partnership with the provider before Veritus can connect directly.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Provider</th><th>Covers</th><th>Works today</th><th>Needs a partnership</th></tr></thead>
          <tbody>{CONNECTORS.map((c) => <tr key={c.key}><td><b>{c.name}</b></td><td>{c.covers}</td><td>{c.today}</td><td className="muted">{c.partnership}</td></tr>)}</tbody>
        </table></div>
      </div>
    </>
  );
}
