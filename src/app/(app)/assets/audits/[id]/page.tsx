import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { auditSummary } from "@/lib/assets/audit";
import { ActionForm } from "@/components/ActionForm";
import { PrintButton } from "@/components/PrintButton";
import { peso } from "@/components/ExpenseUi";
import { closeAuditAction } from "../../../expense-actions";

const RESULT: Record<string, string> = { FOUND: "Found", WRONG_LOCATION: "Wrong location", UNKNOWN: "Unknown tag" };

function Buckets({ title, rows }: { title: string; rows: { key: string; expected: number; found: number; missing: number; pct: number; missingCost: string }[] }) {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {rows.length === 0 ? <p className="muted">No assets in scope.</p> : rows.map((r) => (
        <div key={r.key} className="hbar" title={`${r.found} of ${r.expected} found`}>
          <span className="lbl">{r.key}</span><span className="track"><i style={{ width: `${r.pct}%` }} /></span><b>{r.found}/{r.expected}</b><span className="muted cnt">{r.pct}%</span>
        </div>
      ))}
    </div>
  );
}

export default async function AuditDetail({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const s = await auditSummary(ctx.org.id, id);
  const t = s.totals;
  const tiles: [string, string | number][] = [
    ["Found", `${t.found} of ${t.expected} (${t.pctFound}%)`], ["Missing", t.missing], ["Missing at cost", peso(t.missingCost)],
    ["Wrong location", t.wrongLocation], ["Unknown tags", t.unknown], ["Never tagged", t.neverTagged],
  ];
  return (
    <>
      <div className="crumbs noprint"><Link href="/assets/audits">Asset counts</Link> / {s.audit.number}</div>
      <div className="top">
        <h1>{s.audit.name} <span className={`badge ${s.audit.status}`}>{s.audit.status}</span></h1>
        <PrintButton label="Print report" />
      </div>
      <p className="muted">{s.audit.number} · {s.audit.location ?? "All locations"} · started {s.audit.createdAt.toISOString().slice(0, 10)}{s.audit.closedAt ? ` · closed ${s.audit.closedAt.toISOString().slice(0, 10)}` : ""}</p>
      <div className="grid">{tiles.map(([l, n]) => <div key={l} className="card stat"><div className="n">{n}</div><div className="l">{l}</div></div>)}</div>
      {s.audit.status === "OPEN" && can(ctx.role, "journal.post") && (
        <ActionForm action={closeAuditAction} className="card noprint" confirm="Close this count? Assets not scanned will be marked missing.">
          <input type="hidden" name="id" value={s.audit.id} />
          <div className="row" style={{ alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", margin: 0 }}><input type="checkbox" name="markMissing" defaultChecked style={{ width: "auto" }} />Mark the {t.missing} unscanned asset{t.missing === 1 ? "" : "s"} as missing in the register</label>
            <div style={{ flex: 0 }}><button>Close count</button></div>
          </div>
        </ActionForm>
      )}
      <div className="grid2">
        <Buckets title="By location" rows={s.byLocation} />
        <Buckets title="By category" rows={s.byCategory} />
      </div>
      {s.missing.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Not scanned ({s.missing.length})</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Asset</th><th>Name</th><th>Location</th><th>Custodian</th><th>Last seen</th><th className="num">Cost</th></tr></thead>
            <tbody>{s.missing.map((m) => <tr key={m.id}><td>{m.code}</td><td>{m.name}</td><td>{m.location}</td><td>{m.custodianCode}</td><td>{m.lastSeenAt?.toISOString().slice(0, 10) ?? "Never"}</td><td className="num">{peso(m.cost)}</td></tr>)}</tbody>
          </table></div>
        </div>
      )}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Scans ({s.scans.length})</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>Time</th><th>Tag</th><th>Asset</th><th>Result</th><th>Scanned at</th><th>Condition</th><th>Note</th></tr></thead>
          <tbody>
            {s.scans.length === 0 && <tr><td colSpan={7} className="muted">No scans yet. Open the Asset Audit tile in the Veritus Mobility app.</td></tr>}
            {s.scans.map((x) => <tr key={x.id}><td>{x.scannedAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{x.tagText}</td><td>{x.asset ? `${x.asset.code} ${x.asset.name}` : ""}</td><td><span className={`badge X-${x.result}`}>{RESULT[x.result] ?? x.result}</span>{x.result === "WRONG_LOCATION" && x.asset?.expectedLocation ? <span className="muted"> (register: {x.asset.expectedLocation})</span> : null}</td><td>{x.location}</td><td>{x.condition?.replace("_", " ")}</td><td>{x.note}</td></tr>)}
          </tbody>
        </table></div>
      </div>
    </>
  );
}
