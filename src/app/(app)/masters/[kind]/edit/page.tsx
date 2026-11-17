import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { MASTERS, isMasterKind } from "@/lib/masters/config";
import { listMasters } from "@/lib/masters/query";
import { refOptions } from "@/lib/masters/ref-options";
import { MasterForm } from "./MasterForm";

export default async function EditMaster({ params, searchParams }: { params: Promise<{ kind: string }>; searchParams: Promise<{ code?: string; type?: string }> }) {
  const { kind } = await params;
  if (!isMasterKind(kind)) notFound();
  const ctx = await requireCtx("masters.manage");
  const { code, type } = await searchParams;
  const def = MASTERS[kind];
  let record: Record<string, string | boolean> = {};
  if (code) {
    const [r] = await listMasters(kind, ctx.org.id, code, type);
    if (!r) notFound();
    for (const f of def.fields) {
      const v = r[f.key];
      record[f.key] = f.type === "bool" ? Boolean(v) : v === null || v === undefined ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    }
  } else {
    record = { isActive: true, isPostable: true, allowManualPosting: true, vatRegistered: true };
  }
  return (
    <>
      <div className="top"><h1>{code ? `Edit ${def.singular.toLowerCase()} ${code}` : `Add ${def.singular.toLowerCase()}`}</h1></div>
      <MasterForm kind={kind} fields={def.fields} record={record} originalCode={code} singular={def.singular}
        refs={await refOptions(def.fields, ctx.org.id, type ?? (typeof record.type === "string" ? record.type : undefined))} />
    </>
  );
}
