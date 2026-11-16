import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { MASTERS, isMasterKind, type Field } from "@/lib/masters/config";
import { listMasters } from "@/lib/masters/query";
import { UploadForm } from "./UploadForm";

function show(f: Field, v: unknown) {
  if (v === null || v === undefined) return "";
  if (f.type === "bool") return v ? "Yes" : "No";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (f.type === "number") return Number(String(v)).toLocaleString("en-PH", { maximumFractionDigits: 6 });
  return String(v);
}

export default async function MasterList({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<{ q?: string; saved?: string }> }) {
  const { kind } = await params;
  if (!isMasterKind(kind)) notFound();
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const def = MASTERS[kind];
  const admin = can(ctx.role, "masters.manage");
  let rows = await listMasters(kind, ctx.org.id);
  if (sp.q) {
    const q = sp.q.toLowerCase();
    rows = rows.filter((r) => def.fields.some((f) => String(r[f.key] ?? "").toLowerCase().includes(q)));
  }
  const cols = def.fields.filter((f) => f.list);
  return (
    <>
      <div className="top">
        <h1>{def.title}</h1>
        <div className="row noprint" style={{ flex: 0, gap: 8, flexWrap: "nowrap" }}>
          <a className="btn secondary" href={`/api/masters/${kind}/template`}>Download Excel template</a>
          <a className="btn secondary" href={`/api/masters/${kind}/export`}>Export to Excel</a>
          {admin && <Link className="btn" href={`/masters/${kind}/edit`}>Add {def.singular.toLowerCase()}</Link>}
        </div>
      </div>
      {sp.saved && <div className="notice">Saved.</div>}
      {admin ? <UploadForm kind={kind} /> : <div className="notice">Only owners and administrators can add, edit or upload {def.title.toLowerCase()}.</div>}
      <form className="row noprint" style={{ marginBottom: 10 }}>
        <div><input name="q" defaultValue={sp.q} placeholder={`Search ${def.title.toLowerCase()}…`} /></div>
        <div style={{ flex: 0 }}><button className="secondary">Search</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr>{cols.map((f) => <th key={f.key} className={f.type === "number" || f.type === "int" ? "num" : ""}>{f.header}</th>)}{admin && <th />}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.id)} className={kind === "accounts" && r.isPostable === false ? "header" : ""}>
              {cols.map((f) => <td key={f.key} className={f.type === "number" || f.type === "int" ? "num" : ""}>{show(f, r[f.key])}</td>)}
              {admin && <td><Link href={`/masters/${kind}/edit?code=${encodeURIComponent(String(r.code))}${kind === "dimensions" ? `&type=${r.type}` : ""}`}>Edit</Link></td>}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={cols.length + 1} className="muted">No records yet. Add one, or download the template, fill it in and upload it.</td></tr>}
        </tbody>
      </table></div>
      <p className="muted">{rows.length} record(s)</p>
    </>
  );
}
