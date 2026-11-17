"use client";
import { useDeferredValue, useRef, useState } from "react";

const toggle = (arr: string[] | undefined, v: string) => (arr ?? []).includes(v) ? (arr ?? []).filter((x) => x !== v) : [...(arr ?? []), v];

/** Pick several records from a list, with type-to-search. */
export function Multi({ options, value, onChange, placeholder }: { options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [q, setQ] = useState("");
  const search = useRef<HTMLInputElement>(null);
  // Every word typed must appear (code or name), like the single-value pickers.
  const dq = useDeferredValue(q); // filter the list behind the typing, not on the keystroke
  const toks = dq.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = toks.length ? options.filter((o) => { const l = o.label.toLowerCase(); return toks.every((t) => l.includes(t)); }) : options;
  const summary = value.length === 0 ? placeholder ?? "All" : value.length <= 3 ? value.map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ") : `${value.length} selected`;
  return (
    <details className="multi" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) setTimeout(() => search.current?.focus(), 0); }}>
      <summary>{summary}</summary>
      <div className="multi-pop">
        {options.length > 5 && <input ref={search} placeholder="Type to search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />}
        <div className="multi-actions"><button type="button" className="link" onClick={() => onChange([])}>Clear</button>{q && <button type="button" className="link" onClick={() => onChange([...new Set([...value, ...shown.map((o) => o.value)])])}>Select shown</button>}</div>
        {shown.slice(0, 200).map((o) => <label key={o.value} className="check"><input type="checkbox" checked={value.includes(o.value)} onChange={() => onChange(toggle(value, o.value))} /> {o.label}</label>)}
        {shown.length === 0 && <span className="muted">No matches</span>}
        {shown.length > 200 && <span className="muted">{shown.length - 200} more: type to narrow the list.</span>}
      </div>
    </details>
  );
}

/** Uncontrolled Multi for plain <form>s: posts one `name` value per picked record. */
export function MultiPicker({ name, options, defaultValue, placeholder }: { name: string; options: { value: string; label: string }[]; defaultValue?: string[]; placeholder?: string }) {
  const [v, setV] = useState(defaultValue ?? []);
  return <>{v.map((x) => <input key={x} type="hidden" name={name} value={x} />)}<Multi options={options} value={v} onChange={setV} placeholder={placeholder} /></>;
}
