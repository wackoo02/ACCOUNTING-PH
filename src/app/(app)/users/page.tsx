import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ROLE_LABELS } from "@/lib/permissions";
import { changeRole, setApprovalLimit } from "../actions";
import { ActionForm } from "@/components/ActionForm";
import { AddUserForm } from "./forms";

export default async function Users() {
  const ctx = await requireCtx("users.manage");
  const members = await prisma.membership.findMany({ where: { organizationId: ctx.org.id }, include: { user: true }, orderBy: { createdAt: "asc" } });
  return (
    <>
      <div className="top"><h1>Users and Roles</h1></div>
      <div className="card">
        <strong>What each role can do</strong>
        <ul className="muted" style={{ margin: "6px 0 0" }}>
          <li><b>Owner / Administrator</b>: everything, including the chart of accounts, master lists, uploads and users.</li>
          <li><b>Accountant</b>: create, approve/post and reverse entries (up to their approval limit); close periods; view reports.</li>
          <li><b>Bookkeeper</b>: prepare entries and submit them for approval; view reports.</li>
          <li><b>Viewer</b>: read-only access to reports.</li>
        </ul>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Approval limit (PHP)</th><th /></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.user.name}</td><td>{m.user.email}</td>
              <td>{m.role === "OWNER" ? ROLE_LABELS.OWNER : (
                <form action={changeRole} className="row" style={{ gap: 6 }}>
                  <input type="hidden" name="membershipId" value={m.id} />
                  <select name="role" defaultValue={m.role} style={{ maxWidth: 200 }}>
                    {(["ADMIN", "ACCOUNTANT", "BOOKKEEPER", "VIEWER"] as const).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  <button className="secondary">Save</button>
                </form>
              )}</td>
              <td>{["OWNER", "ADMIN", "ACCOUNTANT"].includes(m.role) ? (
                <ActionForm action={setApprovalLimit} className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                  <input type="hidden" name="membershipId" value={m.id} />
                  <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                    <input name="limit" className="num" style={{ maxWidth: 140 }} placeholder="No limit" defaultValue={m.approvalLimit?.toString() ?? ""} />
                    <button className="secondary">Set</button>
                  </div>
                </ActionForm>
              ) : <span className="muted">Cannot approve</span>}</td>
              <td>{m.role !== "OWNER" && m.userId !== ctx.user.id && (
                <form action={changeRole}><input type="hidden" name="membershipId" value={m.id} /><input type="hidden" name="remove" value="1" /><button className="danger">Remove access</button></form>
              )}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <h2>Add a user</h2>
      <AddUserForm />
    </>
  );
}
