"use client";
import Link from "next/link";
import { useActionState, useRef, useState, type FormEvent } from "react";
import { saveMasterRecord } from "../../../actions";
import { Errors } from "@/components/Errors";
import { SimilarPopup } from "@/components/SimilarPopup";
import { MasterPicker } from "@/components/MasterPicker";
import type { LookupOption } from "@/components/MasterLookup";
import type { Field } from "@/lib/masters/config";
import type { SimilarMatch } from "@/lib/masters/similar";

const savedUrl = (kind: string, code: string, type?: string) =>
  `/embed/masters/${kind}/saved?${new URLSearchParams({ code, ...(type ? { type } : {}) })}`;
const closeEmbed = () => window.parent?.postMessage({ source: "veritus-master", type: "close" }, window.location.origin);

/** In the pop-up: pick an existing record and go back to the entry. */
export function UseRecordButton({ kind, code, type }: { kind: string; code: string; type?: string }) {
  return (
    <div className="row" style={{ marginTop: 12, gap: 8 }}>
      <button type="button" onClick={() => window.location.assign(savedUrl(kind, code, type))}>Use this record</button>
      <button type="button" className="secondary" onClick={closeEmbed}>Close</button>
    </div>
  );
}

function refAdd(f: Field, dimType?: string) {
  const type = f.ref!.sameType ? dimType : f.ref!.type;
  return { kind: f.ref!.kind, ...(type ? { type, prefill: { type } } : {}) };
}

export function MasterForm({ kind, fields, record, originalCode, embed, skip = [], dimType, singular, refs = {} }: {
  kind: string; fields: Field[]; record: Record<string, string | boolean>; originalCode?: string;
  embed?: boolean; skip?: string[]; dimType?: string; singular?: string;
  /** Options for fields that hold another master record's code (Field.ref). */
  refs?: Record<string, LookupOption[]>;
}) {
  const [s, a, p] = useActionState(saveMasterRecord, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const confirmed = useRef(false);
  const [dups, setDups] = useState<{ matches: SimilarMatch[]; text: string } | null>(null);
  const [checking, setChecking] = useState(false);

  // Before adding a new record, look for one that already exists (same name, TIN, email, account no.).
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    if (originalCode || confirmed.current) return;
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (k: string) => String(fd.get(k) ?? "").trim();
    const name = kind === "employees" ? `${get("firstName")} ${get("lastName")}` : get("name");
    const u = new URLSearchParams({ q: name, code: get("code") });
    for (const k of ["tin", "email", "accountNumber"]) if (get(k)) u.set(k, get(k));
    if (kind === "dimensions" && get("type")) u.set("type", get("type"));
    setChecking(true);
    try {
      const res = await fetch(`/api/lookup/${kind}?${u}`);
      const data = (await res.json()) as { matches: SimilarMatch[] };
      // A record with the same code is an update, which the save already explains; skip the ones already reviewed.
      const matches = data.matches.filter((m) => !skip.includes(m.id) && m.reason !== "Same code");
      if (matches.length) { setDups({ matches, text: name }); return; }
    } catch { /* if the check fails, do not block saving */ } finally { setChecking(false); }
    confirmed.current = true;
    formRef.current?.requestSubmit();
  };

  const review = (m: SimilarMatch) => {
    const href = embed ? `/embed/masters/${kind}?${new URLSearchParams({ code: m.code, ...(dimType ? { type: dimType } : {}) })}` : `/masters/${kind}/edit?code=${encodeURIComponent(m.code)}`;
    window.open(href, embed ? "_self" : "_blank");
  };

  return (
    <form ref={formRef} action={a} onSubmit={onSubmit} className={"card" + (embed ? " embed-form" : "")}>
      <Errors errors={s?.errors} />
      <input type="hidden" name="_kind" value={kind} />
      <input type="hidden" name="_original" value={originalCode ?? ""} />
      {embed && <input type="hidden" name="_embed" value="1" />}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        {fields.map((f) => (
          <div key={f.key} className={f.required ? "req" : undefined}>
            <label>{f.header}{f.required ? " *" : ""}</label>
            {f.type === "bool" ? (
              <input type="checkbox" name={f.key} defaultChecked={Boolean(record[f.key])} style={{ width: "auto" }} />
            ) : f.type === "enum" ? (
              <select name={f.key} defaultValue={String(record[f.key] ?? "")} required={f.required} disabled={false}>
                {!f.required && <option value="">—</option>}
                {f.options!.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : f.ref && refs[f.key] ? (
              <MasterPicker name={f.key} ariaLabel={f.header} options={refs[f.key]} defaultValue={String(record[f.key] ?? "")} required={f.required} valueIsCode
                emptyLabel={f.required ? undefined : "— None"} placeholder={f.example !== undefined && f.example !== "" ? `e.g. ${f.example}` : "Type to search…"}
                add={refAdd(f, dimType ?? (typeof record.type === "string" ? record.type : undefined))} />
            ) : (
              <input name={f.key} type={f.type === "date" ? "date" : "text"} inputMode={f.type === "number" || f.type === "int" ? "decimal" : undefined}
                defaultValue={String(record[f.key] ?? "")} required={f.required} readOnly={f.key === "code" && !!originalCode} placeholder={f.example !== undefined && f.example !== "" ? `e.g. ${f.example}` : ""} />
            )}
            {f.help && <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{f.help}</div>}
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 16, gap: 8, position: "relative" }}>
        <button disabled={p || checking}>{embed ? "Save and use" : "Save"}</button>
        {embed && originalCode && <button type="button" className="secondary" onClick={() => window.location.assign(savedUrl(kind, originalCode, dimType))}>Use without changes</button>}
        {embed
          ? <button type="button" className="secondary" onClick={closeEmbed}>Cancel</button>
          : <Link className="btn secondary" href={`/masters/${kind}`}>Cancel</Link>}
        {dups && (
          <SimilarPopup
            style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, width: "min(440px, 100%)" }}
            singular={singular ?? "record"}
            text={dups.text}
            matches={dups.matches}
            canAdd
            onUse={embed ? (m) => window.location.assign(savedUrl(kind, m.code, dimType)) : undefined}
            onReview={review}
            onSkip={() => { setDups(null); confirmed.current = true; formRef.current?.requestSubmit(); }}
            onCancel={() => setDups(null)}
            skipLabel="Skip & save as new"
          />
        )}
      </div>
    </form>
  );
}
