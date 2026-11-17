"use client";
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import type { MasterKind } from "@/lib/masters/config";
import { typeaheadScore, type SimilarMatch } from "@/lib/masters/similar";
import { SimilarPopup } from "./SimilarPopup";

export type LookupOption = { value: string; label: string; code?: string; group?: string; hint?: string; kind?: MasterKind };
export type SavedRecord = { kind: MasterKind; id: string; code: string; label: string; [k: string]: unknown };
export type AddTarget = {
  kind: MasterKind;
  /** e.g. "customer"; defaults to the list's singular name */
  noun?: string;
  /** Field value for a newly saved record. Default: its id. */
  toValue?: (r: SavedRecord) => string;
  /** Values to pre-fill on the new record form, e.g. { type: "DEPARTMENT" }. */
  prefill?: Record<string, string>;
  /** Dimension type, so the duplicate check compares within the same dimension. */
  type?: string;
};

type LookupData = { canAdd: boolean; singular: string; matches: SimilarMatch[]; nextCode: string | null; prefill: Record<string, string> };
type Row = { t: "opt"; o: LookupOption; fuzzy?: boolean } | { t: "add"; target: AddTarget };

const NOUN: Record<MasterKind, string> = {
  accounts: "account", dimensions: "value", taxes: "tax code", banks: "bank / cash account", products: "product",
  employees: "employee", vendors: "vendor", customers: "customer", currencies: "currency", assets: "asset", "asset-categories": "asset category", warehouses: "warehouse", locations: "location",
};

// Lower-cased search text for each option, built once per list (not on every keystroke).
type Indexed = { o: LookupOption; code: string; label: string; words: string; hay: string };
const indexOptions = (options: LookupOption[]): Indexed[] => options.map((o) => {
  const code = (o.code ?? "").toLowerCase(), label = o.label.toLowerCase();
  return { o, code, label, words: " " + label.replace(/[^a-z0-9]+/g, " "), hay: `${code} ${label} ${(o.hint ?? "").toLowerCase()}` };
});

const SHOW_EMPTY = 40, SHOW_MATCHES = 50;

/** Options containing every typed word, best first: code starts with it, name starts with it, a word starts with it, anywhere. */
function search(index: Indexed[], text: string): LookupOption[] {
  const toks = text.toLowerCase().split(/\s+/).filter(Boolean);
  const q0 = toks[0], w0 = " " + q0;
  const buckets: LookupOption[][] = [[], [], [], []];
  for (const x of index) {
    let ok = true;
    for (const t of toks) if (!x.hay.includes(t)) { ok = false; break; }
    if (!ok) continue;
    const r = x.code.startsWith(q0) ? 0 : x.label.startsWith(q0) ? 1 : x.words.includes(w0) ? 2 : 3;
    if (buckets[r].length < SHOW_MATCHES) buckets[r].push(x.o);
    if (r === 0 && buckets[0].length >= SHOW_MATCHES) break; // nothing can rank higher
  }
  return buckets.flat().slice(0, SHOW_MATCHES);
}

const rowIndex = (t: EventTarget): number | null => {
  const el = (t as HTMLElement).closest?.("[data-i]");
  return el ? Number(el.getAttribute("data-i")) : null;
};

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function Highlight({ text, re }: { text: string; re: RegExp | null }) {
  if (!re) return <>{text}</>;
  const parts = text.split(re);
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

/** One option row; memoized so moving the highlight re-renders two rows, not the whole list. */
const OptionRow = memo(function OptionRow({ o, i, on, sel, group, re }: { o: LookupOption; i: number; on: boolean; sel: boolean; group?: string; re: RegExp | null }) {
  return (
    <div>
      {group && <div className="lookup-group">{group}</div>}
      <div data-i={i} className={"lookup-opt" + (on ? " on" : "") + (sel ? " sel" : "")} role="option" aria-selected={sel}>
        {o.code && <span className="lookup-code"><Highlight text={o.code} re={re} /></span>}
        <span className="lookup-label"><Highlight text={o.label} re={re} /></span>
        {o.hint && <span className="lookup-hint">{o.hint}</span>}
      </div>
    </div>
  );
});

/**
 * Type-to-search picker for master data. Suggests existing records as you type,
 * offers "Add new" when nothing fits, warns about look-alike records, and opens the
 * full master form so the new record is complete before you carry on.
 */
export function MasterLookup(props: {
  options: LookupOption[];
  value: string;
  onChange: (value: string, record?: SavedRecord) => void;
  add?: AddTarget | AddTarget[];
  placeholder?: string;
  emptyLabel?: string;
  ariaLabel?: string;
  required?: boolean;
  disabled?: boolean;
  name?: string;
  style?: CSSProperties;
}) {
  const { options, value, onChange } = props;
  const targets = useMemo(() => (props.add ? (Array.isArray(props.add) ? props.add : [props.add]) : []), [props.add]);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<CSSProperties>({});
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<LookupOption | null>(null);
  const [pop, setPop] = useState<{ target: AddTarget; text: string; data: LookupData } | null>(null);
  const [modal, setModal] = useState<{ target: AddTarget; url: string; title: string } | null>(null);

  const selected = options.find((o) => o.value === value) ?? (pending?.value === value ? pending : undefined);
  const shown = selected ? (selected.code && selected.label ? `${selected.code} · ${selected.label}` : selected.code || selected.label) : "";

  // Filtering and drawing the list follow the typing at lower priority, so each key shows at once.
  const dq = useDeferredValue(q);
  // The typo search compares every record, so it waits until typing pauses.
  const [settled, setSettled] = useState("");
  useEffect(() => { const t = setTimeout(() => setSettled(dq), 250); return () => clearTimeout(t); }, [dq]);
  const index = useMemo(() => (open ? indexOptions(options) : []), [open, options]);
  const re = useMemo(() => {
    const toks = dq.trim().split(/\s+/).filter(Boolean).map(escapeRe);
    return toks.length ? new RegExp(`(${toks.join("|")})`, "ig") : null;
  }, [dq]);
  const rows: Row[] = useMemo(() => {
    if (!open) return [];
    const text = dq.trim();
    let list: Row[];
    if (!text) list = options.slice(0, SHOW_EMPTY).map((o) => ({ t: "opt", o }));
    else {
      list = search(index, text).map((o) => ({ t: "opt", o }));
      if (!list.length && text.length >= 3 && settled === dq) {
        // Nothing contains the text: once typing pauses, suggest the closest names, which catches typos.
        list = options.map((o) => ({ o, s: typeaheadScore(text, `${o.code ?? ""} ${o.label}`) })).filter((x) => x.s >= 0.7)
          .sort((a, b) => b.s - a.s).slice(0, 5).map((x) => ({ t: "opt", o: x.o, fuzzy: true }));
      }
    }
    if (text) for (const target of targets) list.push({ t: "add", target });
    return list;
  }, [open, dq, settled, index, options, targets]);

  const place = useCallback(() => {
    const r = inputRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 340);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom;
    setPos(below < 280 && r.top > below ? { left, width, bottom: window.innerHeight - r.top + 4 } : { left, width, top: r.bottom + 4 });
  }, []);

  useEffect(() => {
    if (!open && !pop) return;
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, pop, place]);

  const pick = useCallback((target: AddTarget, rec: SavedRecord) => {
    const v = target.toValue ? target.toValue(rec) : rec.id;
    setPending({ value: v, label: rec.label, code: rec.code });
    onChange(v, rec);
    router.refresh(); // reload the page's lists so the new record has all its details
  }, [onChange, router]);

  // Messages from the master form in the pop-up window.
  useEffect(() => {
    if (!modal) return;
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frameRef.current?.contentWindow) return;
      const d = e.data as { source?: string; type?: string; record?: SavedRecord };
      if (d?.source !== "veritus-master") return;
      if (d.type === "saved" && d.record) pick(modal.target, d.record);
      if (d.type === "saved" || d.type === "close") setModal(null);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [modal, pick]);

  // Rendered on <body> so table scroll areas and page animations cannot clip them.
  const portal = (node: ReactNode) => (typeof document === "undefined" ? null : createPortal(node, document.body));

  const noun = (t: AddTarget) => t.noun ?? NOUN[t.kind];

  const openCreate = (target: AddTarget, text: string, data: LookupData, skip: string[] = []) => {
    const prefill = { ...data.prefill, ...(target.prefill ?? {}) };
    if (!prefill.code && data.nextCode) prefill.code = data.nextCode;
    const u = new URLSearchParams({ prefill: JSON.stringify(prefill) });
    if (skip.length) u.set("skip", skip.join(","));
    if (target.type) u.set("type", target.type);
    setPop(null);
    setModal({ target, url: `/embed/masters/${target.kind}?${u}`, title: `New ${noun(target)}` });
  };

  const review = (target: AddTarget, m: SimilarMatch) => {
    const u = new URLSearchParams({ code: m.code });
    if (target.type) u.set("type", target.type);
    setPop(null);
    setModal({ target, url: `/embed/masters/${target.kind}?${u}`, title: `${m.code} · ${m.label}` });
  };

  const startAdd = async (target: AddTarget) => {
    const text = q.trim();
    if (!text) return;
    setBusy(true);
    try {
      const u = new URLSearchParams({ q: text });
      if (target.type) u.set("type", target.type);
      const res = await fetch(`/api/lookup/${target.kind}?${u}`);
      const data = (await res.json()) as LookupData;
      setOpen(false);
      if (data.matches.length || !data.canAdd) setPop({ target, text, data });
      else openCreate(target, text, data);
    } finally { setBusy(false); }
  };

  const optionFor = (target: AddTarget, m: SimilarMatch) =>
    options.find((o) => (o.kind ?? target.kind) === target.kind && o.code === m.code);

  const choose = (row: Row) => {
    if (row.t === "add") { void startAdd(row.target); return; }
    onChange(row.o.value);
    setQ(""); setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && open) { e.preventDefault(); if (rows[active]) choose(rows[active]); }
    else if (e.key === "Escape") { setOpen(false); setQ(""); }
  };

  return (
    <div className="lookup" style={props.style}>
      {props.name && <input type="hidden" name={props.name} value={value} />}
      <input
        ref={inputRef}
        value={open ? q : shown}
        placeholder={props.placeholder ?? (targets.length ? "Type to search or add…" : "Type to search…")}
        aria-label={props.ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        role="combobox"
        required={props.required && !value}
        disabled={props.disabled}
        onFocus={(e) => { setQ(""); setActive(0); setOpen(true); e.currentTarget.select(); }}
        onChange={(e) => { setQ(e.target.value); setActive(0); setOpen(true); }}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      {busy && <span className="lookup-spin" aria-hidden="true" />}
      {open && portal(
        <div className="lookup-list" style={pos} role="listbox" onMouseDown={(e) => e.preventDefault()}
          onMouseOver={(e) => { const i = rowIndex(e.target); if (i !== null && i !== active) setActive(i); }}
          onClick={(e) => { const i = rowIndex(e.target); if (i !== null && rows[i]) choose(rows[i]); }}>
          {props.emptyLabel && !q.trim() && (
            <div className={"lookup-opt" + (value === "" ? " sel" : "")} onClick={() => { onChange(""); setOpen(false); }}>
              <span className="muted">{props.emptyLabel}</span>
            </div>
          )}
          {rows.some((r) => r.t === "opt" && r.fuzzy) && <div className="lookup-group">Did you mean</div>}
          {rows.map((row, i) => {
            if (row.t === "add") {
              return (
                <div key={"add" + row.target.kind} className={"lookup-opt lookup-add" + (i === active ? " on" : "")} onMouseEnter={() => setActive(i)} onClick={() => choose(row)}>
                  <span className="lookup-plus" aria-hidden="true">+</span> Add &ldquo;{q.trim()}&rdquo; as a new {noun(row.target)}
                </div>
              );
            }
            const prev = rows[i - 1];
            const showGroup = row.o.group && !row.fuzzy && (!prev || prev.t !== "opt" || prev.o.group !== row.o.group);
            return <OptionRow key={row.o.value} o={row.o} i={i} on={i === active} sel={row.o.value === value} group={showGroup ? row.o.group : undefined} re={re} />;
          })}
          {dq.trim() && !rows.some((r) => r.t === "opt") && <div className="lookup-empty">No record matches &ldquo;{dq.trim()}&rdquo;.</div>}
          {!q.trim() && !options.length && <div className="lookup-empty">No records yet. Type a name to add one.</div>}
        </div>
      )}
      {pop && portal(
        <>
          <div className="lookup-scrim" onClick={() => setPop(null)} />
          <SimilarPopup
            style={{ ...pos, position: "fixed" }}
            singular={noun(pop.target)}
            text={pop.text}
            matches={pop.data.matches}
            canAdd={pop.data.canAdd}
            canUse={(m) => !!optionFor(pop.target, m)}
            onUse={(m) => { const o = optionFor(pop.target, m); if (o) onChange(o.value); setPop(null); }}
            onReview={(m) => review(pop.target, m)}
            onSkip={() => openCreate(pop.target, pop.text, pop.data, pop.data.matches.map((m) => m.id))}
            onCancel={() => { setPop(null); inputRef.current?.focus(); }}
          />
        </>
      )}
      {modal && portal(
        <div className="lookup-modal" role="dialog" aria-label={modal.title}>
          <div className="lookup-modal-box">
            <div className="lookup-modal-head">
              <strong>{modal.title}</strong>
              <span className="muted" style={{ fontSize: 12 }}>Fill in the fields marked * then save. You will come back to this entry.</span>
              <button type="button" className="link" onClick={() => setModal(null)} aria-label="Close">✕</button>
            </div>
            <iframe ref={frameRef} src={modal.url} title={modal.title} />
          </div>
        </div>
      )}
    </div>
  );
}
