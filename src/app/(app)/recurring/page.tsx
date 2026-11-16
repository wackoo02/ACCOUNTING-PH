import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate, today } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { runRecurringAction, toggleRecurring } from "../actions";

export default async function Recurring() {
  const ctx = await requireCtx("reports.view");
  const rows = await prisma.recurringJournal.findMany({ where: { organizationId: ctx.org.id }, orderBy: { nextRunDate: "asc" } });
  const due = rows.filter((r) => r.isActive && r.nextRunDate <= new Date()).length;
  return (
    <>
      <div className="top"><h1>Recurring Entries</h1></div>
      <p className="muted">Templates for entries that repeat, such as rent, amortization or monthly accruals. To add one, open any manual journal entry and use &quot;Make recurring&quot;. Generated entries go through the normal approval workflow.</p>
      {can(ctx.role, "journal.create") && (
        <ActionForm action={runRecurringAction} className="card row">
          <div className="row">
            <div><label>Generate everything due up to</label><input type="date" name="asOf" defaultValue={today()} /></div>
            <div style={{ flex: 0 }}><button>Generate due entries{due ? ` (${due} due)` : ""}</button></div>
          </div>
        </ActionForm>
      )}
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Frequency</th><th>Next run</th><th>Ends</th><th>Creates as</th><th className="num">Runs</th><th>Status</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}><td>{r.name}<div className="muted">{r.memo}</div></td><td>{r.frequency.replace("_", " ").toLowerCase()}</td><td>{fmtDate(r.nextRunDate)}</td>
              <td>{r.endDate ? fmtDate(r.endDate) : "—"}</td><td>{r.autoSubmit ? "Submitted for approval" : "Draft"}</td><td className="num">{r.runCount}</td>
              <td><span className={`badge ${r.isActive ? "OPEN" : "VOID"}`}>{r.isActive ? "ACTIVE" : "PAUSED"}</span></td>
              <td>{can(ctx.role, "journal.create") && <ActionForm action={toggleRecurring}><input type="hidden" name="id" value={r.id} /><button className="secondary">{r.isActive ? "Pause" : "Resume"}</button></ActionForm>}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={8} className="muted">No recurring entries yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
