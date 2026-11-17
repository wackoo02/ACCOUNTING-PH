"use client";
import { useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { ReportVisibility, Role } from "@prisma/client";
import { definitionSchema, MEASURES, type CustomLine, type Measure, type PeriodSpec, type ReportDefinition } from "@/lib/reporting/definition";
import { ROW_GROUP_OPTIONS, SOURCES, sourceInfo } from "@/lib/reporting/catalog";
import type { ReportResult } from "@/lib/reporting/result";
import { ReportTable } from "./ReportTable";
import { Errors } from "@/components/Errors";
import { MasterLookup } from "@/components/MasterLookup";
import { Multi } from "@/components/Multi";
export { Multi };
import { deleteReportAction, runReportAction, saveReportAction, type RunState } from "@/app/(app)/reports/custom/actions";

export type BuilderLookups = {
  currentOrgId: string;
  entities: { id: string; name: string }[];
  dims: { key: string; label: string; values: { code: string; name: string }[] }[];
  accounts: { code: string; name: string; type: string; ifrsGroup: string }[];
  ifrsGroups: string[];
  journalSources: string[];
  parties: { code: string; name: string; type: string }[];
  members: { id: string; name: string; role: Role }[];
  roles: { id: Role; label: string }[];
};
export type SavedMeta = {
  id: string; name: string; description: string | null; visibility: ReportVisibility; sharedRoles: Role[]; sharedUserIds: string[];
  allowEdit: boolean; editable: boolean; deletable: boolean; shareable: boolean; ownerName: string; mine: boolean;
};

const MEASURE_LABEL: Record<Measure, string> = {
  opening: "Opening balance", debit: "Debit", credit: "Credit", net: "Net movement", closing: "Closing balance",
  budget: "Budget", budgetVariance: "Budget variance", budgetVariancePct: "Budget variance %",
};
const TYPES = [["ASSET", "Assets"], ["LIABILITY", "Liabilities"], ["EQUITY", "Equity"], ["INCOME", "Income"], ["EXPENSE", "Expenses"]] as const;
const PARTY_TYPES = [["CUSTOMER", "Customers"], ["VENDOR", "Vendors"], ["EMPLOYEE", "Employees"], ["PARTNER", "Partners"]] as const;
const STATUSES = [["DRAFT", "Draft"], ["PENDING_APPROVAL", "For approval"], ["POSTED", "Posted"], ["VOID", "Void"]] as const;

const OFFSETS: Record<PeriodSpec["kind"], [number, string][]> = {
  month: [[0, "This month"], [-1, "Last month"], [-2, "2 months ago"], [-3, "3 months ago"], [-6, "6 months ago"], [-12, "Same month last year"], [1, "Next month"]],
  quarter: [[0, "This quarter"], [-1, "Last quarter"], [-2, "2 quarters ago"], [-4, "Same quarter last year"], [1, "Next quarter"]],
  ytd: [[0, "This year to date"], [-1, "Same period last year"], [-2, "Same period 2 years ago"]],
  fy: [[0, "This fiscal year"], [-1, "Last fiscal year"], [-2, "2 fiscal years ago"], [1, "Next fiscal year"]],
  to_date: [[0, "As of report date"], [-1, "Same date last year"], [-2, "Same date 2 years ago"]],
  custom: [[0, "Pick dates"]],
};
const KIND_LABEL: Record<PeriodSpec["kind"], string> = { month: "Month", quarter: "Quarter", ytd: "Year to date", fy: "Fiscal year", to_date: "Balance as of", custom: "Custom dates" };

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const toggle = (arr: string[] | undefined, v: string) => (arr ?? []).includes(v) ? (arr ?? []).filter((x) => x !== v) : [...(arr ?? []), v];
let seq = 0;
const nid = (p: string) => `${p}${Date.now().toString(36).slice(-3)}${seq++}`;

export function ReportBuilder({ initialDef, initialResult, lookups, saved, startOpen }: {
  initialDef: ReportDefinition; initialResult: RunState | null; lookups: BuilderLookups; saved: SavedMeta | null; startOpen?: boolean;
}) {
  const router = useRouter();
  const [def, setDef] = useState<ReportDefinition>(initialDef);
  const [ranDef, setRanDef] = useState(JSON.stringify(initialDef));
  const [result, setResult] = useState<ReportResult | null>(initialResult?.ok ? initialResult.result : null);
  const [errors, setErrors] = useState<string[]>(initialResult && !initialResult.ok ? initialResult.errors : []);
  const [tab, setTab] = useState<string>(startOpen ? "report" : "");
  const [pending, start] = useTransition();
  const [saveMsg, setSaveMsg] = useState<string>("");
  const exportRef = useRef<HTMLFormElement>(null);
  const info = sourceInfo(def.source)!;
  const dirty = JSON.stringify(def) !== ranDef;
  const readOnly = !!saved && !saved.editable;

  const up = (fn: (d: ReportDefinition) => void) => setDef((cur) => { const n = clone(cur); fn(n); return n; });
  const run = (d = def) => start(async () => {
    const r = await runReportAction(d);
    setRanDef(JSON.stringify(d));
    if (r.ok) { setResult(r.result); setErrors([]); } else setErrors(r.errors);
  });

  const changeSource = (id: string) => {
    const si = sourceInfo(id)!;
    const n = definitionSchema.parse({ source: id, title: def.title, asOf: def.asOf, periods: si.periods === "many" ? def.periods : [def.periods[0]], filters: def.filters,
      measures: id === "balances" ? (def.measures.length ? def.measures : ["closing"]) : ["closing"] });
    setDef(n);
    run(n);
  };

  return (
    <>
      <div className="top">
        <div>
          <h1>{result?.title || def.title || info.label}</h1>
          <span className="muted">{result?.subtitle}{saved ? ` · saved by ${saved.mine ? "you" : saved.ownerName}` : ""}</span>
        </div>
        <div className="noprint toolbar">
          <button type="button" className="secondary" onClick={() => setTab(tab ? "" : "report")}>{tab ? "Hide design" : "Customize"}</button>
          <button type="button" onClick={() => run()} disabled={pending}>{pending ? "Running…" : dirty ? "Run (changed)" : "Run"}</button>
          <button type="button" className="secondary" onClick={() => exportRef.current?.requestSubmit()}>Excel</button>
          <button type="button" className="secondary" onClick={() => window.print()}>Print / PDF</button>
        </div>
      </div>
      <form ref={exportRef} method="post" action="/api/reports/export" style={{ display: "none" }}>
        <input type="hidden" name="definition" value={JSON.stringify(def)} readOnly />
      </form>

      {tab && (
        <div className="card noprint builder">
          <div className="tabs">
            {[["report", "Report and dates"], ["columns", "Columns"], ["rows", "Rows"], ["filters", "Filters"], ["save", saved ? "Save and share" : "Save"]].map(([id, l]) => (
              <button key={id} type="button" className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>{l}</button>
            ))}
          </div>
          {readOnly && <div className="notice">{saved!.ownerName} shared this report with you. Change anything to explore, then use <b>Save as my copy</b> to keep your version.</div>}

          {tab === "report" && (
            <div className="stack">
              <div className="row">
                <div><label>Report type</label>
                  <select value={def.source} onChange={(e) => changeSource(e.target.value)}>
                    {[...new Set(SOURCES.map((s) => s.group))].map((g) => <optgroup key={g} label={g}>{SOURCES.filter((s) => s.group === g).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</optgroup>)}
                  </select></div>
                <div style={{ flex: 2 }}><label>Title</label><input value={def.title ?? ""} placeholder={info.label} onChange={(e) => up((d) => { d.title = e.target.value; })} /></div>
                <div><label>Report date</label>
                  <select value={/^\d/.test(def.asOf) ? "date" : def.asOf} onChange={(e) => up((d) => { d.asOf = e.target.value === "date" ? new Date().toISOString().slice(0, 10) : e.target.value; })}>
                    <option value="today">Today</option><option value="end_of_last_month">End of last month</option><option value="date">A fixed date</option>
                  </select></div>
                {/^\d/.test(def.asOf) && <div><label>Fixed date</label><input type="date" value={def.asOf} onChange={(e) => up((d) => { d.asOf = e.target.value; })} /></div>}
              </div>
              <p className="muted small">{info.description} Periods move with the report date, so a saved report always shows current figures.</p>
              <PeriodsEditor def={def} up={up} mode={info.periods} />
            </div>
          )}

          {tab === "columns" && (
            <div className="stack">
              {info.split && (
                <div className="row">
                  <div><label>Columns by</label>
                    <select value={def.split.by} onChange={(e) => up((d) => { d.split.by = e.target.value as ReportDefinition["split"]["by"]; d.split.values = []; })}>
                      <option value="none">Nothing (one column per period)</option>
                      <option value="entity">Entity / subsidiary</option>
                      {lookups.dims.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                    </select></div>
                  {def.split.by !== "none" && (
                    <div style={{ flex: 2 }}><label>Show</label>
                      <Multi placeholder="All with amounts" value={def.split.values ?? []} onChange={(v) => up((d) => { d.split.values = v; })}
                        options={def.split.by === "entity" ? lookups.entities.map((e) => ({ value: e.id, label: e.name })) : (lookups.dims.find((x) => x.key === def.split.by)?.values ?? []).map((v) => ({ value: v.code, label: `${v.code} · ${v.name}` }))} />
                    </div>
                  )}
                  {def.split.by !== "none" && <Check label="Total column" checked={def.split.total} onChange={(v) => up((d) => { d.split.total = v; })} />}
                  {def.split.by !== "none" && def.split.by !== "entity" && <Check label="Column for untagged" checked={def.split.untagged} onChange={(v) => up((d) => { d.split.untagged = v; })} />}
                  {def.split.by !== "none" && info.periods === "many" && (
                    <div><label>Order</label><select value={def.columnOrder} onChange={(e) => up((d) => { d.columnOrder = e.target.value as ReportDefinition["columnOrder"]; })}>
                      <option value="period_first">Period, then {def.split.by === "entity" ? "entity" : "value"}</option><option value="split_first">{def.split.by === "entity" ? "Entity" : "Value"}, then period</option></select></div>
                  )}
                </div>
              )}
              {info.measures && (
                <div><label>Amounts to show</label>
                  <div className="measure-checks">
                    {MEASURES.map((m) => <Check key={m} label={MEASURE_LABEL[m]} checked={def.measures.includes(m)} onChange={() => up((d) => { const next = toggle(d.measures, m) as Measure[]; d.measures = MEASURES.filter((x) => next.includes(x)); })} />)}
                  </div>
                  <p className="muted small">Debit/credit and net movement are for each period; opening and closing balances are as of its start and end. Budget amounts come from Budgets (by department or project when you group or filter by one).</p>
                </div>
              )}
              {info.comparisons && <ComparisonsEditor def={def} up={up} />}
              {info.detailColumns && <ColumnPicker def={def} up={up} options={info.detailColumns} />}
              {info.aging && (
                <div className="row">
                  <div><label>Aging buckets (days)</label><input defaultValue={def.aging.buckets.join(", ")} onBlur={(e) => up((d) => { const b = e.target.value.split(/[,\s]+/).map(Number).filter((n) => n > 0); if (b.length) d.aging.buckets = b; })} /></div>
                  <div><label>Age by</label><select value={def.aging.basis} onChange={(e) => up((d) => { d.aging.basis = e.target.value as ReportDefinition["aging"]["basis"]; })}>
                    <option value="transactionDate">Document date (days outstanding)</option><option value="date">Posting date</option><option value="dueDate">Due date (days past due, uses payment terms)</option></select></div>
                  <Check label="Show each open item" checked={def.aging.showItems} onChange={(v) => up((d) => { d.aging.showItems = v; })} />
                </div>
              )}
            </div>
          )}

          {tab === "rows" && <RowsEditor def={def} up={up} lookups={lookups} />}

          {tab === "filters" && <FiltersEditor def={def} up={up} lookups={lookups} />}

          {tab === "save" && <SavePanel def={def} saved={saved} lookups={lookups} onSaved={(id, msg) => { setSaveMsg(msg); if (!saved || saved.id !== id) router.push(`/reports/custom/${id}`); else router.refresh(); }} msg={saveMsg} />}
        </div>
      )}

      <Errors errors={errors} />
      {result && (
        <div style={{ opacity: pending ? 0.55 : 1, transition: "opacity .15s" }}>
          <ReportTable r={result} />
          {result.notes.map((n, i) => <p key={i} className="muted small">{n}</p>)}
        </div>
      )}
    </>
  );
}

// ---------- small inputs ----------

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="check"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
}


type Up = (fn: (d: ReportDefinition) => void) => void;

// ---------- periods and comparisons ----------

function PeriodsEditor({ def, up, mode }: { def: ReportDefinition; up: Up; mode: "many" | "one" | "asOf" }) {
  const list = mode === "many" ? def.periods : def.periods.slice(0, 1);
  const kinds = (mode === "asOf" ? ["to_date", "custom"] : ["month", "quarter", "ytd", "fy", "to_date", "custom"]) as PeriodSpec["kind"][];
  const lastYear = (p: PeriodSpec): PeriodSpec => {
    const n = { ...p, id: nid("p"), label: undefined };
    if (p.kind === "month") n.offset = p.offset - 12; else if (p.kind === "quarter") n.offset = p.offset - 4;
    else if (p.kind === "custom" && p.from && p.to) { const y = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`; n.from = y(p.from); n.to = y(p.to); }
    else n.offset = p.offset - 1;
    return n;
  };
  return (
    <div>
      <label>{mode === "asOf" ? "As of" : mode === "one" ? "Dates" : "Periods (one set of columns each)"}</label>
      <table className="mini"><tbody>
        {list.map((p, i) => (
          <tr key={p.id}>
            <td><select value={p.kind} onChange={(e) => up((d) => { const k = e.target.value as PeriodSpec["kind"]; d.periods[i].kind = k; d.periods[i].offset = 0; if (k === "custom") { const t = new Date().toISOString().slice(0, 10); d.periods[i].from ??= `${t.slice(0, 4)}-01-01`; d.periods[i].to ??= t; } })}>
              {kinds.map((k) => <option key={k} value={k}>{mode === "asOf" && k === "custom" ? "A fixed date" : KIND_LABEL[k]}</option>)}</select></td>
            <td>{p.kind === "custom" ? (
              <div className="row" style={{ flexWrap: "nowrap", gap: 6 }}>
                {mode !== "asOf" && <input type="date" value={p.from ?? ""} onChange={(e) => up((d) => { d.periods[i].from = e.target.value; })} />}
                <input type="date" value={p.to ?? ""} onChange={(e) => up((d) => { d.periods[i].to = e.target.value; if (mode === "asOf") d.periods[i].from = e.target.value; })} />
              </div>
            ) : (
              <select value={p.offset} onChange={(e) => up((d) => { d.periods[i].offset = Number(e.target.value); })}>
                {(OFFSETS[p.kind].some(([o]) => o === p.offset) ? OFFSETS[p.kind] : [...OFFSETS[p.kind], [p.offset, `${p.offset} back`] as [number, string]]).map(([o, l]) => <option key={o} value={o}>{l}</option>)}
              </select>
            )}</td>
            {mode === "many" && <td><input placeholder="Column label (optional)" value={p.label ?? ""} onChange={(e) => up((d) => { d.periods[i].label = e.target.value || undefined; })} /></td>}
            {mode === "many" && <td className="nowrap">
              <button type="button" className="link" disabled={i === 0} onClick={() => up((d) => { [d.periods[i - 1], d.periods[i]] = [d.periods[i], d.periods[i - 1]]; })}>↑</button>{" "}
              <button type="button" className="link" disabled={def.periods.length === 1} onClick={() => up((d) => { d.periods.splice(i, 1); d.comparisons = d.comparisons.filter((c) => c.base !== p.id && c.against !== p.id); })}>Remove</button>
            </td>}
          </tr>
        ))}
      </tbody></table>
      {mode === "many" && (
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button type="button" className="secondary" disabled={def.periods.length >= 24} onClick={() => up((d) => { d.periods.push({ id: nid("p"), kind: "month", offset: 0 }); })}>+ Period</button>
          <button type="button" className="secondary" disabled={def.periods.length >= 24} onClick={() => up((d) => { const np = lastYear(d.periods[d.periods.length - 1]); d.periods.push(np); d.comparisons.push({ id: nid("c"), base: d.periods[0].id, against: np.id, show: "both" }); })}>+ Same period last year (with comparison)</button>
          <button type="button" className="secondary" onClick={() => up((d) => { d.periods = Array.from({ length: 12 }, (_, k) => ({ id: `m${k + 1}`, kind: "month" as const, offset: k - 11 })); d.comparisons = []; })}>Last 12 months</button>
          <button type="button" className="secondary" onClick={() => up((d) => { d.periods = Array.from({ length: 4 }, (_, k) => ({ id: `q${k + 1}`, kind: "quarter" as const, offset: k - 3 })); d.comparisons = []; })}>Last 4 quarters</button>
        </div>
      )}
    </div>
  );
}

function ComparisonsEditor({ def, up }: { def: ReportDefinition; up: Up }) {
  const opts = def.periods.map((p, i) => ({ id: p.id, label: p.label || (p.kind === "custom" ? `${p.from} to ${p.to}` : OFFSETS[p.kind].find(([o]) => o === p.offset)?.[1]) || `Period ${i + 1}` }));
  return (
    <div>
      <label>Comparisons (variance between two periods)</label>
      {def.comparisons.length === 0 && <p className="muted small">None. Add a second period first, then compare them.</p>}
      <table className="mini"><tbody>
        {def.comparisons.map((c, i) => (
          <tr key={c.id}>
            <td><select value={c.base} onChange={(e) => up((d) => { d.comparisons[i].base = e.target.value; })}>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></td>
            <td className="muted">vs</td>
            <td><select value={c.against} onChange={(e) => up((d) => { d.comparisons[i].against = e.target.value; })}>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></td>
            <td><select value={c.show} onChange={(e) => up((d) => { d.comparisons[i].show = e.target.value as "diff" | "pct" | "both"; })}><option value="both">Change and %</option><option value="diff">Change</option><option value="pct">%</option></select></td>
            <td><input placeholder="Label (optional)" value={c.label ?? ""} onChange={(e) => up((d) => { d.comparisons[i].label = e.target.value || undefined; })} /></td>
            <td><button type="button" className="link" onClick={() => up((d) => { d.comparisons.splice(i, 1); })}>Remove</button></td>
          </tr>
        ))}
      </tbody></table>
      <button type="button" className="secondary" style={{ marginTop: 8 }} disabled={def.periods.length < 2} onClick={() => up((d) => { d.comparisons.push({ id: nid("c"), base: d.periods[0].id, against: d.periods[1].id, show: "both" }); })}>+ Comparison</button>
    </div>
  );
}

function ColumnPicker({ def, up, options }: { def: ReportDefinition; up: Up; options: { id: string; label: string }[] }) {
  const info = sourceInfo(def.source)!;
  const cols = def.columns.length ? def.columns : (def.source === "gl_detail" ? ["date", "number", "accountCode", "accountName", "memo", "reference", "debit", "credit", "balance"] : ["number", "date", "memo", "reference", "source", "status", "totalDebit", "preparedBy", "approvedBy"]);
  const label = (id: string) => options.find((o) => o.id === id)?.label ?? id;
  const set = (next: string[]) => up((d) => { d.columns = next; });
  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <div style={{ flex: 2 }}>
        <label>Columns, in order</label>
        <ol className="colpick">
          {cols.map((id, i) => (
            <li key={id}><span>{label(id)}</span>
              <span className="nowrap">
                <button type="button" className="link" disabled={i === 0} onClick={() => { const n = [...cols]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set(n); }}>↑</button>{" "}
                <button type="button" className="link" disabled={i === cols.length - 1} onClick={() => { const n = [...cols]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; set(n); }}>↓</button>{" "}
                <button type="button" className="link" disabled={cols.length === 1} onClick={() => set(cols.filter((x) => x !== id))}>✕</button>
              </span></li>
          ))}
        </ol>
        <select value="" onChange={(e) => e.target.value && set([...cols, e.target.value])}>
          <option value="">+ Add a column…</option>
          {options.filter((o) => !cols.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>
      <div>
        <label>Sort by</label>
        <select value={def.sort} onChange={(e) => up((d) => { d.sort = e.target.value as ReportDefinition["sort"]; })}>
          <option value="date">Date</option><option value="number">JE number</option>{def.source === "gl_detail" && <option value="account">Account</option>}<option value="amount">Amount (largest first)</option>
        </select>
        <label style={{ marginTop: 10 }}>Group and subtotal by</label>
        <select value={def.groupDetailBy} onChange={(e) => up((d) => { d.groupDetailBy = e.target.value as ReportDefinition["groupDetailBy"]; })}>
          {info.groupDetailBy!.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>
    </div>
  );
}

// ---------- rows ----------

function RowsEditor({ def, up, lookups }: { def: ReportDefinition; up: Up; lookups: BuilderLookups }) {
  const info = sourceInfo(def.source)!;
  if (info.statementDetail || def.source === "cash_flow") return (
    <div className="stack">
      <p className="muted small">Statements keep the PFRS presentation. For your own row layout, choose report type <b>Account balances</b> and <b>Your own rows</b>.</p>
      <div className="row">
        {info.statementDetail && <Check label="Show accounts under each line item" checked={def.rows.detail} onChange={(v) => up((d) => { d.rows.detail = v; })} />}
        <Check label="Hide lines with no amounts" checked={def.rows.hideZero} onChange={(v) => up((d) => { d.rows.hideZero = v; })} />
      </div>
    </div>
  );
  if (!info.rowGroups) return <p className="muted small">This report lists one row per {def.source === "aging" ? "customer, vendor or employee" : def.source === "journal_entries" ? "journal entry" : "journal line"}. Choose its columns, sorting and grouping under <b>Columns</b>, and narrow it under <b>Filters</b>.</p>;
  const levels = def.rows.groupBy;
  return (
    <div className="stack">
      <div className="row">
        <div><label>Row layout</label>
          <select value={def.rows.mode} onChange={(e) => up((d) => { d.rows.mode = e.target.value as "grouped" | "custom"; if (d.rows.mode === "custom" && !d.rows.lines.length) d.rows.lines = [{ id: "L1", label: "Revenue", kind: "accounts", types: ["INCOME"] }, { id: "L2", label: "Expenses", kind: "accounts", types: ["EXPENSE"] }, { id: "L3", label: "Net", kind: "formula", formula: "L1 - L2", bold: true }]; if (d.rows.mode === "custom") d.rows.sign = "natural"; })}>
            <option value="grouped">Grouped by fields</option><option value="custom">Your own rows (account ranges and formulas)</option>
          </select></div>
        <div><label>Signs</label>
          <select value={def.rows.sign} onChange={(e) => up((d) => { d.rows.sign = e.target.value as "debit" | "natural"; })}>
            <option value="debit">Debit positive, credit negative</option><option value="natural">Normal balance positive (income, liabilities as positive)</option>
          </select></div>
        <Check label="Hide rows with no amounts" checked={def.rows.hideZero} onChange={(v) => up((d) => { d.rows.hideZero = v; })} />
      </div>
      {def.rows.mode === "grouped" ? (
        <div className="row">
          {[0, 1, 2, 3].map((i) => (i === 0 || levels[i - 1]) && (
            <div key={i}><label>{i === 0 ? "Rows by" : `Then by`}</label>
              <select value={levels[i] ?? ""} onChange={(e) => up((d) => { const v = e.target.value; if (!v) d.rows.groupBy = d.rows.groupBy.slice(0, i); else d.rows.groupBy[i] = v as never; d.rows.groupBy = d.rows.groupBy.filter(Boolean); })}>
                {i > 0 && <option value="">(none)</option>}
                {ROW_GROUP_OPTIONS.filter((o) => o.id === levels[i] || !levels.includes(o.id as never)).filter((o) => !o.id.endsWith("Id") || lookups.dims.some((x) => x.key === o.id)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select></div>
          ))}
          {levels.length > 1 && <Check label="Headings and subtotals" checked={def.rows.subtotals} onChange={(v) => up((d) => { d.rows.subtotals = v; })} />}
          <div><label>Sort</label><select value={def.rows.sortBy} onChange={(e) => up((d) => { d.rows.sortBy = e.target.value as "code" | "label" | "amount"; })}>
            <option value="code">By code</option><option value="label">By name</option><option value="amount">By amount (largest first)</option></select></div>
        </div>
      ) : <CustomLinesEditor def={def} up={up} lookups={lookups} />}
    </div>
  );
}

function CustomLinesEditor({ def, up, lookups }: { def: ReportDefinition; up: Up; lookups: BuilderLookups }) {
  const lines = def.rows.lines;
  const set = (i: number, fn: (l: CustomLine) => void) => up((d) => { fn(d.rows.lines[i]); });
  const add = (kind: CustomLine["kind"]) => up((d) => {
    let n = d.rows.lines.length + 1; while (d.rows.lines.some((l) => l.id === `L${n}`)) n++;
    d.rows.lines.push({ id: `L${n}`, label: kind === "header" ? "Heading" : kind === "formula" ? "Subtotal" : kind === "spacer" ? "" : "New line", kind, ...(kind === "formula" ? { formula: d.rows.lines.filter((l) => l.kind === "accounts").map((l) => l.id).join(" + "), bold: true } : {}) });
  });
  return (
    <div>
      <p className="muted small">Each row adds up the accounts you pick (by code range, list, type or IFRS line item). Formula rows combine rows above by their ID, e.g. <code>REV - COS</code>.</p>
      <div className="table-wrap"><table className="mini lines">
        <thead><tr><th>ID</th><th>Label</th><th>Kind</th><th>Accounts or formula</th><th>Options</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td style={{ width: 70 }}><input value={l.id} onChange={(e) => set(i, (x) => { x.id = e.target.value.replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) || x.id; })} /></td>
              <td><input value={l.label} onChange={(e) => set(i, (x) => { x.label = e.target.value; })} /></td>
              <td style={{ width: 120 }}><select value={l.kind} onChange={(e) => set(i, (x) => { x.kind = e.target.value as CustomLine["kind"]; })}>
                <option value="accounts">Accounts</option><option value="formula">Formula</option><option value="header">Heading</option><option value="spacer">Blank line</option></select></td>
              <td>
                {l.kind === "accounts" && (
                  <div className="row" style={{ gap: 6 }}>
                    <div style={{ minWidth: 80 }}><input placeholder="Code from" value={l.codeFrom ?? ""} onChange={(e) => set(i, (x) => { x.codeFrom = e.target.value || undefined; })} /></div>
                    <div style={{ minWidth: 80 }}><input placeholder="Code to" value={l.codeTo ?? ""} onChange={(e) => set(i, (x) => { x.codeTo = e.target.value || undefined; })} /></div>
                    <div style={{ minWidth: 140 }}><Multi placeholder="Any account" value={l.codes ?? []} onChange={(v) => set(i, (x) => { x.codes = v.length ? v : undefined; })} options={lookups.accounts.map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` }))} /></div>
                    <div style={{ minWidth: 120 }}><Multi placeholder="Any type" value={l.types ?? []} onChange={(v) => set(i, (x) => { x.types = v.length ? (v as CustomLine["types"]) : undefined; })} options={TYPES.map(([v, t]) => ({ value: v, label: t }))} /></div>
                    <div style={{ minWidth: 140 }}><Multi placeholder="Any IFRS line" value={l.ifrsGroups ?? []} onChange={(v) => set(i, (x) => { x.ifrsGroups = v.length ? v : undefined; })} options={lookups.ifrsGroups.map((g) => ({ value: g, label: g }))} /></div>
                  </div>
                )}
                {l.kind === "formula" && <input placeholder="e.g. L1 + L2 - L3" value={l.formula ?? ""} onChange={(e) => set(i, (x) => { x.formula = e.target.value; })} />}
              </td>
              <td className="nowrap small">
                {l.kind === "accounts" && <Check label="Show accounts" checked={!!l.showAccounts} onChange={(v) => set(i, (x) => { x.showAccounts = v; })} />}
                {(l.kind === "accounts" || l.kind === "formula") && <Check label="Flip sign" checked={!!l.negate} onChange={(v) => set(i, (x) => { x.negate = v; })} />}
                {l.kind === "accounts" && <Check label="Bold" checked={!!l.bold} onChange={(v) => set(i, (x) => { x.bold = v; })} />}
              </td>
              <td className="nowrap">
                <button type="button" className="link" disabled={i === 0} onClick={() => up((d) => { const a = d.rows.lines; [a[i - 1], a[i]] = [a[i], a[i - 1]]; })}>↑</button>{" "}
                <button type="button" className="link" disabled={i === lines.length - 1} onClick={() => up((d) => { const a = d.rows.lines; [a[i + 1], a[i]] = [a[i], a[i + 1]]; })}>↓</button>{" "}
                <button type="button" className="link" onClick={() => up((d) => { d.rows.lines.splice(i, 1); })}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button type="button" className="secondary" onClick={() => add("accounts")}>+ Accounts row</button>
        <button type="button" className="secondary" onClick={() => add("formula")}>+ Formula row</button>
        <button type="button" className="secondary" onClick={() => add("header")}>+ Heading</button>
        <button type="button" className="secondary" onClick={() => add("spacer")}>+ Blank line</button>
      </div>
    </div>
  );
}

// ---------- filters ----------

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <div style={wide ? { flex: 2 } : undefined}><label>{label}</label>{children}</div>;
}

function FiltersEditor({ def, up, lookups }: { def: ReportDefinition; up: Up; lookups: BuilderLookups }) {
  const f = def.filters;
  const info = sourceInfo(def.source)!;
  const accountOpts = useMemo(() => lookups.accounts.map((a) => ({ value: a.code, label: `${a.code} · ${a.name}` })), [lookups.accounts]);
  const codeOpts = useMemo(() => lookups.accounts.map((a) => ({ value: a.code, code: a.code, label: a.name })), [lookups.accounts]);
  return (
    <div className="stack">
      <div className="row">
        {lookups.entities.length > 1 && <Field label="Entities / subsidiaries" wide><Multi placeholder="This company only" value={f.entityIds ?? []} onChange={(v) => up((d) => { d.filters.entityIds = v; })} options={lookups.entities.map((e) => ({ value: e.id, label: e.name }))} /></Field>}
        <Field label="Specific accounts" wide><Multi placeholder="All accounts" value={f.accountCodes ?? []} onChange={(v) => up((d) => { d.filters.accountCodes = v; })} options={accountOpts} /></Field>
        <Field label="Account code from"><MasterLookup ariaLabel="Account code from" placeholder="e.g. 6000" emptyLabel="Any" value={f.accountCodeFrom ?? ""} options={codeOpts} onChange={(v) => up((d) => { d.filters.accountCodeFrom = v || undefined; })} /></Field>
        <Field label="to"><MasterLookup ariaLabel="Account code to" placeholder="e.g. 6999" emptyLabel="Any" value={f.accountCodeTo ?? ""} options={codeOpts} onChange={(v) => up((d) => { d.filters.accountCodeTo = v || undefined; })} /></Field>
      </div>
      <div className="row">
        <Field label="Account types"><Multi value={f.accountTypes ?? []} onChange={(v) => up((d) => { d.filters.accountTypes = v as ReportDefinition["filters"]["accountTypes"]; })} options={TYPES.map(([v, l]) => ({ value: v, label: l }))} /></Field>
        <Field label="IFRS line items" wide><Multi value={f.ifrsGroups ?? []} onChange={(v) => up((d) => { d.filters.ifrsGroups = v; })} options={lookups.ifrsGroups.map((g) => ({ value: g, label: g }))} /></Field>
        <Field label="Source modules"><Multi value={f.sources ?? []} onChange={(v) => up((d) => { d.filters.sources = v; })} options={lookups.journalSources.map((s) => ({ value: s, label: s.replace(/_/g, " ").toLowerCase() }))} /></Field>
      </div>
      {lookups.dims.length > 0 && (
        <div className="row">
          {lookups.dims.map((x) => (
            <Field key={x.key} label={x.label}><Multi value={f.dims?.[x.key as keyof NonNullable<typeof f.dims>] ?? []} onChange={(v) => up((d) => { d.filters.dims = { ...(d.filters.dims ?? {}), [x.key]: v }; })} options={x.values.map((v) => ({ value: v.code, label: `${v.code} · ${v.name}` }))} /></Field>
          ))}
          <Check label="Also include untagged lines" checked={!!f.includeUntagged} onChange={(v) => up((d) => { d.filters.includeUntagged = v; })} />
        </div>
      )}
      <div className="row">
        <Field label="Customer / vendor / employee type"><Multi value={f.partyTypes ?? []} onChange={(v) => up((d) => { d.filters.partyTypes = v as ReportDefinition["filters"]["partyTypes"]; })} options={PARTY_TYPES.map(([v, l]) => ({ value: v, label: l }))} /></Field>
        <Field label="Specific customers / vendors / employees" wide><Multi placeholder="All" value={f.partyCodes ?? []} onChange={(v) => up((d) => { d.filters.partyCodes = v; })}
          options={lookups.parties.filter((p) => !f.partyTypes?.length || f.partyTypes.some((t) => t.toLowerCase() === p.type.toLowerCase())).map((p) => ({ value: p.code, label: `${p.code} · ${p.name} (${p.type})` }))} /></Field>
        <Field label="Text in narration, line or reference"><input value={f.text ?? ""} onChange={(e) => up((d) => { d.filters.text = e.target.value || undefined; })} /></Field>
        {info.statuses && <Field label="Entry status"><Multi placeholder={def.source === "gl_detail" ? "Posted" : "All"} value={f.statuses ?? []} onChange={(v) => up((d) => { d.filters.statuses = v as ReportDefinition["filters"]["statuses"]; })} options={STATUSES.map(([v, l]) => ({ value: v, label: l }))} /></Field>}
      </div>
      <div className="row">
        <Check label="Leave out year-end closing entries" checked={!!f.excludeClosing} onChange={(v) => up((d) => { d.filters.excludeClosing = v; })} />
        <Check label="Include group consolidation adjustments" checked={!!f.includeConsolidation} onChange={(v) => up((d) => { d.filters.includeConsolidation = v; })} />
      </div>
    </div>
  );
}

// ---------- save and share ----------

function SavePanel({ def, saved, lookups, onSaved, msg }: { def: ReportDefinition; saved: SavedMeta | null; lookups: BuilderLookups; onSaved: (id: string, msg: string) => void; msg: string }) {
  const [name, setName] = useState(saved?.name ?? def.title ?? "");
  const [description, setDescription] = useState(saved?.description ?? "");
  const [visibility, setVisibility] = useState<ReportVisibility>(saved?.visibility ?? "PRIVATE");
  const [roles, setRoles] = useState<string[]>(saved?.sharedRoles ?? []);
  const [users, setUsers] = useState<string[]>(saved?.sharedUserIds ?? []);
  const [allowEdit, setAllowEdit] = useState(saved?.allowEdit ?? false);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const canShare = !saved || saved.shareable;
  const save = (asCopy: boolean) => start(async () => {
    const r = await saveReportAction({ id: saved?.id, asCopy, name: asCopy && saved && name === saved.name ? `${name} (copy)` : name, description, definition: def,
      visibility: asCopy && !saved?.shareable ? "PRIVATE" : visibility, sharedRoles: roles as Role[], sharedUserIds: users, allowEdit });
    if (r.ok) { setErrors([]); onSaved(r.id, r.message); } else setErrors(r.errors);
  });
  return (
    <div className="stack">
      <Errors errors={errors} />
      {msg && <div className="notice">{msg}</div>}
      <div className="row">
        <Field label="Report name" wide><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly management pack" /></Field>
        <Field label="Description (optional)" wide><input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      {canShare ? (
        <div className="row">
          <Field label="Who can open it">
            <select value={visibility} onChange={(e) => setVisibility(e.target.value as ReportVisibility)}>
              <option value="PRIVATE">Only me (owners and admins can still see it)</option>
              <option value="COMPANY">Everyone in this company</option>
              <option value="ROLES">People with these roles</option>
              <option value="USERS">Specific people</option>
            </select></Field>
          {visibility === "ROLES" && <Field label="Roles" wide><Multi placeholder="Pick roles" value={roles} onChange={setRoles} options={lookups.roles.map((r) => ({ value: r.id, label: r.label }))} /></Field>}
          {visibility === "USERS" && <Field label="People" wide><Multi placeholder="Pick people" value={users} onChange={setUsers} options={lookups.members.map((m) => ({ value: m.id, label: m.name }))} /></Field>}
          {visibility !== "PRIVATE" && <Check label="They can change it too (otherwise they can run and copy it)" checked={allowEdit} onChange={setAllowEdit} />}
        </div>
      ) : <p className="muted small">Shared by {saved!.ownerName}. Only the owner or an administrator can change who it is shared with.</p>}
      <p className="muted small">Each person only ever sees data for the companies they belong to, whatever is saved in the report.</p>
      <div className="row" style={{ gap: 8 }}>
        {(!saved || saved.editable) && <button type="button" disabled={pending} onClick={() => save(false)}>{saved ? "Save changes" : "Save report"}</button>}
        {saved && <button type="button" className="secondary" disabled={pending} onClick={() => save(true)}>Save as my copy</button>}
        {saved?.deletable && <button type="button" className="danger" disabled={pending} onClick={() => { if (window.confirm(`Delete "${saved.name}" for everyone it is shared with?`)) start(async () => { const r = await deleteReportAction(saved.id); if (r && !r.ok) setErrors(r.errors); }); }}>Delete</button>}
      </div>
    </div>
  );
}
