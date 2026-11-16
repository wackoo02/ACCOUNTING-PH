import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listAudits } from "@/lib/assets/audit";
import { ActionForm } from "@/components/ActionForm";
import { startAuditAction } from "../../expense-actions";

export default async function Audits() {
  const ctx = await requireCtx("reports.view");
  const rows = await listAudits(ctx.org.id);
  return (
    <>
      <div className="top"><h1>Asset counts</h1><Link className="btn secondary" href="/assets/stickers">Print QR stickers</Link></div>
      <p className="muted">Start a count here or in the Veritus Mobility app, then walk the site scanning each sticker with the phone camera. Each scan updates the register (tagged, last seen, location, condition). Closing the count marks the assets nobody scanned as missing.</p>
      {can(ctx.role, "assets.audit") && (
        <ActionForm action={startAuditAction} className="card noprint">
          <div className="row" style={{ alignItems: "end" }}>
            <div><label>Name</label><input name="name" placeholder="e.g. Q4 asset count" /></div>
            <div><label>Location (blank = all)</label><input name="location" placeholder="e.g. Makati HQ" /></div>
            <div style={{ flex: 0 }}><button>Start count</button></div>
          </div>
        </ActionForm>
      )}
      <div className="table-wrap"><table>
        <thead><tr><th>Count</th><th>Name</th><th>Location</th><th>Started</th><th>Closed</th><th className="num">Scans</th><th>Status</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="muted">No counts yet.</td></tr>}
          {rows.map((a) => <tr key={a.id}><td><Link href={`/assets/audits/${a.id}`}>{a.number}</Link></td><td>{a.name}</td><td>{a.location ?? "All locations"}</td><td>{a.createdAt.toISOString().slice(0, 10)}</td><td>{a.closedAt?.toISOString().slice(0, 10) ?? ""}</td><td className="num">{a.scans}</td><td><span className={`badge ${a.status}`}>{a.status}</span></td></tr>)}
        </tbody>
      </table></div>
    </>
  );
}
