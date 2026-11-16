import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { MASTERS, isMasterKind } from "@/lib/masters/config";
import { listMasters } from "@/lib/masters/query";
import { MasterForm, UseRecordButton } from "@/app/(app)/masters/[kind]/edit/MasterForm";

const DEFAULTS = { isActive: true, isPostable: true, allowManualPosting: true, vatRegistered: true };

export default async function EmbedMaster({ params, searchParams }: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<{ code?: string; type?: string; prefill?: string; skip?: string }>;
}) {
  const { kind } = await params;
  if (!isMasterKind(kind)) notFound();
  const ctx = await requireCtx();
  const { code, type, prefill, skip } = await searchParams;
  const def = MASTERS[kind];
  const admin = can(ctx.role, "masters.manage");
  let record: Record<string, string | boolean> = { ...DEFAULTS };
  if (code) {
    const [r] = await listMasters(kind, ctx.org.id, code, type);
    if (!r) notFound();
    record = {};
    for (const f of def.fields) {
      const v = r[f.key];
      record[f.key] = f.type === "bool" ? Boolean(v) : v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    }
  } else {
    if (!admin) return <p className="errors">Only an owner or admin can add master records.</p>;
    try {
      const p = JSON.parse(prefill ?? "{}") as Record<string, unknown>;
      for (const f of def.fields) if (typeof p[f.key] === "string" && p[f.key]) record[f.key] = String(p[f.key]);
    } catch { /* ignore a bad prefill */ }
  }
  if (code && !admin) {
    // Read-only view for staff who can pick records but not change them.
    return (
      <div className="card">
        <table><tbody>
          {def.fields.map((f) => <tr key={f.key}><th style={{ width: "40%" }}>{f.header}</th><td>{typeof record[f.key] === "boolean" ? (record[f.key] ? "Yes" : "No") : String(record[f.key] || "—")}</td></tr>)}
        </tbody></table>
        <UseRecordButton kind={kind} code={code} type={type} />
      </div>
    );
  }
  return <MasterForm kind={kind} fields={def.fields} record={record} originalCode={code} embed skip={skip ? skip.split(",") : []} dimType={type} singular={def.singular} />;
}
