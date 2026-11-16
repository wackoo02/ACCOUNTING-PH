import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { listReports } from "@/lib/reporting/saved";
import { TEMPLATES } from "@/lib/reporting/templates";
import { SOURCES, sourceInfo } from "@/lib/reporting/catalog";

const VIS: Record<string, string> = { PRIVATE: "Only me", COMPANY: "Whole company", ROLES: "By role", USERS: "Specific people" };

export default async function CustomReports() {
  const ctx = await requireCtx("reports.view");
  const reports = await listReports({ userId: ctx.user.id, organizationId: ctx.org.id, role: ctx.role });
  const mine = reports.filter((r) => r.mine), shared = reports.filter((r) => !r.mine);
  const groups = [...new Set(SOURCES.map((s) => s.group))];
  const table = (list: typeof reports, showOwner: boolean) => (
    <div className="table-wrap"><table>
      <thead><tr><th>Report</th><th>Type</th>{showOwner && <th>Shared by</th>}<th>Who can open it</th><th>Updated</th></tr></thead>
      <tbody>
        {list.map((r) => (
          <tr key={r.id}>
            <td><Link href={`/reports/custom/${r.id}`}>{r.name}</Link>{r.description && <div className="muted small">{r.description}</div>}</td>
            <td>{sourceInfo(r.source)?.label ?? r.source}</td>
            {showOwner && <td>{r.ownerName}</td>}
            <td>{VIS[r.visibility]}{r.allowEdit && r.visibility !== "PRIVATE" ? " · can edit" : ""}</td>
            <td className="muted">{r.updatedAt.toISOString().slice(0, 10)}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
  return (
    <>
      <div className="top"><h1>Custom Reports</h1><Link className="btn" href="/reports/custom/new?template=trial_balance">New report</Link></div>
      <p className="muted">Start from any report below, change its columns, rows, periods, comparisons, entities, departments and accounts, then save it for yourself or share it with your team.</p>
      <h2>My reports</h2>
      {mine.length ? table(mine, false) : <p className="muted">You have not saved any reports yet.</p>}
      {shared.length > 0 && (<><h2>Shared with me</h2>{table(shared, true)}</>)}
      <h2>Start from</h2>
      {groups.map((g) => {
        const ts = TEMPLATES.filter((t) => sourceInfo(t.def.source)?.group === g);
        if (!ts.length) return null;
        return (
          <div key={g}>
            <h3 className="muted small" style={{ textTransform: "uppercase", letterSpacing: ".05em", margin: "14px 0 6px" }}>{g}</h3>
            <div className="grid">
              {ts.map((t) => (
                <Link key={t.id} href={`/reports/custom/new?template=${t.id}`} className="card tile" style={{ marginBottom: 0 }}>
                  <b>{t.name}</b><div className="muted small">{t.description}</div>
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
