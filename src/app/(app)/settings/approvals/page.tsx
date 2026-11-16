import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DOC_LABELS, type DocType } from "@/lib/approvals";
import { ROLE_LABELS } from "@/lib/permissions";
import { peso } from "@/lib/ap/view";
import { ActionForm } from "@/components/ActionForm";
import { approvalRuleAction } from "../../ap-actions";

export default async function ApprovalMatrix() {
  const ctx = await requireCtx("org.manage");
  const [rules, members] = await Promise.all([
    prisma.approvalRule.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: [{ docType: "asc" }, { level: "asc" }, { minAmount: "asc" }] }),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id }, include: { user: true } }),
  ]);
  const uname = new Map(members.map((m) => [m.userId, m.user.name]));
  return (<>
    <div className="top"><h1>Approval Matrix</h1></div>
    <p className="muted">Set who approves purchase requests, purchase orders, supplier bills and payment vouchers. A document needs every level whose minimum amount is at or below its total, in order (level 1 first). Each level can be a role (anyone with it) or a named person, such as a department head with a Viewer login. The preparer can never approve, and one person approves one level only. With no rules for a document type, one approval by an accountant, administrator or owner (within their approval limit) is enough.</p>
    {(Object.keys(DOC_LABELS) as DocType[]).map((t) => { const rs = rules.filter((r) => r.docType === t); return (
      <div key={t}><h2>{DOC_LABELS[t]}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Level</th><th>Name</th><th className="num">Applies from (PHP)</th><th>Approver</th><th /></tr></thead>
          <tbody>{rs.map((r) => <tr key={r.id}><td>{r.level}</td><td>{r.name}</td><td className="num">{peso(r.minAmount)}</td><td>{r.approverUserId ? uname.get(r.approverUserId) : r.approverRole ? `Any ${ROLE_LABELS[r.approverRole]}` : ""}</td>
            <td><ActionForm action={approvalRuleAction}><input type="hidden" name="op" value="delete" /><input type="hidden" name="id" value={r.id} /><button className="link" style={{ color: "var(--danger)" }}>Remove</button></ActionForm></td></tr>)}
            {!rs.length && <tr><td colSpan={5} className="muted">Default: one approval by an accountant, administrator or owner.</td></tr>}</tbody>
        </table></div></div>); })}
    <ActionForm action={approvalRuleAction} className="card" style={{ marginTop: 16 }}>
      <strong>Add a level</strong>
      <div className="row" style={{ marginTop: 8 }}>
        <div><label>Document</label><select name="docType">{(Object.keys(DOC_LABELS) as DocType[]).map((t) => <option key={t} value={t}>{DOC_LABELS[t]}</option>)}</select></div>
        <div style={{ maxWidth: 90 }}><label>Level</label><input name="level" className="num" defaultValue="1" /></div>
        <div><label>Name</label><input name="name" placeholder="e.g. Department head, CFO" /></div>
        <div><label>Applies when total is at least</label><input name="minAmount" className="num" defaultValue="0" /></div>
        <div style={{ flex: 2 }}><label>Approver</label><select name="who" required><option value="">Choose…</option>
          <optgroup label="Anyone with role">{Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={`ROLE:${k}`}>{v}</option>)}</optgroup>
          <optgroup label="Named person">{members.map((m) => <option key={m.userId} value={`USER:${m.userId}`}>{m.user.name} ({ROLE_LABELS[m.role]})</option>)}</optgroup></select></div>
        <div style={{ flex: 0 }}><button>Add</button></div>
      </div>
      <p className="muted">Example: POs level 1 Department head from 0, level 2 Accountant from 50,000, level 3 Owner from 500,000.</p>
    </ActionForm>
  </>);
}
