"use client";
import Link from "next/link";
import { useActionState } from "react";
import { saveMasterRecord } from "../../../actions";
import { Errors } from "@/components/Errors";
import type { Field } from "@/lib/masters/config";

export function MasterForm({ kind, fields, record, originalCode }: { kind: string; fields: Field[]; record: Record<string, string | boolean>; originalCode?: string }) {
  const [s, a, p] = useActionState(saveMasterRecord, undefined);
  return (
    <form action={a} className="card">
      <Errors errors={s?.errors} />
      <input type="hidden" name="_kind" value={kind} />
      <input type="hidden" name="_original" value={originalCode ?? ""} />
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        {fields.map((f) => (
          <div key={f.key}>
            <label>{f.header}{f.required ? " *" : ""}</label>
            {f.type === "bool" ? (
              <input type="checkbox" name={f.key} defaultChecked={Boolean(record[f.key])} style={{ width: "auto" }} />
            ) : f.type === "enum" ? (
              <select name={f.key} defaultValue={String(record[f.key] ?? "")} required={f.required} disabled={false}>
                {!f.required && <option value="">—</option>}
                {f.options!.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <input name={f.key} type={f.type === "date" ? "date" : "text"} inputMode={f.type === "number" || f.type === "int" ? "decimal" : undefined}
                defaultValue={String(record[f.key] ?? "")} required={f.required} readOnly={f.key === "code" && !!originalCode} placeholder={f.example !== undefined ? String(f.example) : ""} />
            )}
            {f.help && <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{f.help}</div>}
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 16, gap: 8 }}>
        <button disabled={p}>Save</button>
        <Link className="btn secondary" href={`/masters/${kind}`}>Cancel</Link>
      </div>
    </form>
  );
}
