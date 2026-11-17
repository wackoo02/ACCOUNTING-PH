"use client";
import { Fragment, useActionState, useMemo, useState } from "react";
import { saveJournal } from "@/app/(app)/actions";
import { Errors } from "./Errors";
import { MasterLookup, type LookupOption } from "./MasterLookup";
import { DIMENSIONS } from "@/lib/ledger/dimensions";

type Acct = { id: string; code: string; name: string; type: string; currencyCode: string | null };
type DimOpt = { key: string; label: string; values: { id: string; code: string; name: string }[] };
type Line = { accountId: string; description: string; debit: string; credit: string; dims: Record<string, string> };
type Initial = {
  id?: string; date: string; transactionDate: string; memo: string; reference: string;
  currencyCode: string; fxRate: string; lines: Line[]; attachments: { name: string; url: string }[]; book?: string;
};

const blank = (): Line => ({ accountId: "", description: "", debit: "", credit: "", dims: {} });
const cents = (s: string) => {
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const money = (c: number) => (c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
const dimAdd = (key: string) => {
  const type = DIMENSIONS.find((d) => d.key === key)?.type;
  return type ? { kind: "dimensions" as const, type, prefill: { type } } : undefined;
};

export function JournalForm(props: {
  accounts: Acct[]; dims: DimOpt[]; currencies: { code: string; rate: string }[]; baseCurrency: string;
  initial: Initial; canPost: boolean; requireApproval: boolean; hasGroup?: boolean;
}) {
  const { accounts, dims, currencies, baseCurrency, initial, canPost, requireApproval } = props;
  const [state, action, pending] = useActionState(saveJournal, undefined);
  const [book, setBook] = useState(initial.book ?? "STATUTORY");
  const [h, setH] = useState({ date: initial.date, transactionDate: initial.transactionDate, memo: initial.memo, reference: initial.reference, currencyCode: initial.currencyCode, fxRate: initial.fxRate });
  const [lines, setLines] = useState<Line[]>(initial.lines.length ? initial.lines : [blank(), blank()]);
  const [atts, setAtts] = useState(initial.attachments);
  const [showDims, setShowDims] = useState(initial.lines.some((l) => Object.values(l.dims).some(Boolean)));
  const foreign = h.currencyCode !== baseCurrency;
  const rate = foreign ? Number(h.fxRate) || 0 : 1;

  const totals = useMemo(() => {
    const d = lines.reduce((s, l) => s + cents(l.debit), 0);
    const c = lines.reduce((s, l) => s + cents(l.credit), 0);
    return { d, c, diff: d - c };
  }, [lines]);

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setDim = (i: number, k: string, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, dims: { ...l.dims, [k]: v } } : l)));
  const payload = (intent: "draft" | "submit" | "post") => JSON.stringify({
    ...h, fxRate: foreign ? h.fxRate : "1", lines: lines.map((l) => ({ ...l, dims: Object.fromEntries(Object.entries(l.dims).map(([k, v]) => [k, v || null])) })),
    attachments: atts.filter((a) => a.url.trim()), intent, entryId: initial.id, book,
  });

  const balanceHere = (i: number) => {
    const others = lines.reduce((s, l, j) => (j === i ? s : s + cents(l.debit) - cents(l.credit)), 0);
    if (others > 0) set(i, { credit: (others / 100).toFixed(2), debit: "" });
    else if (others < 0) set(i, { debit: (-others / 100).toFixed(2), credit: "" });
  };

  const balanced = totals.diff === 0 && totals.d > 0;
  const accountOptions: LookupOption[] = useMemo(() => {
    const available = accounts.filter((a) => !a.currencyCode || a.currencyCode === h.currencyCode);
    return TYPES.flatMap((t) => available.filter((a) => a.type === t).map((a) => ({ value: a.id, code: a.code, label: a.name, group: t, hint: a.currencyCode ?? undefined })));
  }, [accounts, h.currencyCode]);

  return (
    <form action={action}>
      <Errors errors={state?.errors} />
      <div className="card">
        <div className="row">
          <div><label>Posting date (GL period)</label><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value, transactionDate: h.transactionDate === h.date ? e.target.value : h.transactionDate })} required /></div>
          <div><label>Transaction / document date</label><input type="date" value={h.transactionDate} onChange={(e) => setH({ ...h, transactionDate: e.target.value })} required /></div>
          <div><label>Reference no. (OR, SI, CV, etc.)</label><input value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} /></div>
          <div><label>Currency</label>
            <MasterLookup
              ariaLabel="Currency"
              value={h.currencyCode}
              options={[{ value: baseCurrency, code: baseCurrency, label: "base currency" }, ...currencies.filter((c) => c.code !== baseCurrency).map((c) => ({ value: c.code, code: c.code, label: `rate ${c.rate}` }))]}
              add={{ kind: "currencies", toValue: (r) => r.code }}
              onChange={(v, rec) => {
                const c = currencies.find((x) => x.code === v);
                setH({ ...h, currencyCode: v || baseCurrency, fxRate: c?.rate ?? (rec?.rateToBase ? String(rec.rateToBase) : "1") });
              }}
            /></div>
          {foreign && <div><label>Exchange rate (1 {h.currencyCode} = ? {baseCurrency})</label><input className="num" value={h.fxRate} onChange={(e) => setH({ ...h, fxRate: e.target.value })} /></div>}
        </div>
        {props.hasGroup && (
          <label style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center", color: "var(--ink)" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={book === "CONSOLIDATION"} onChange={(e) => setBook(e.target.checked ? "CONSOLIDATION" : "STATUTORY")} />
            Consolidation adjustment only (appears in consolidated reports, not in this entity&apos;s own books)
          </label>
        )}
        <div style={{ marginTop: 10 }}><label>Description / narration</label><input value={h.memo} onChange={(e) => setH({ ...h, memo: e.target.value })} required placeholder="e.g. To record payment of office rent for November" /></div>
      </div>

      <div className="table-wrap"><table>
        <thead><tr>
          <th style={{ width: "32%" }}>Account</th><th>Line description</th>
          <th className="num" style={{ width: 140 }}>Debit{foreign ? ` (${h.currencyCode})` : ""}</th>
          <th className="num" style={{ width: 140 }}>Credit{foreign ? ` (${h.currencyCode})` : ""}</th>
          {foreign && <th className="num" style={{ width: 130 }}>{baseCurrency} equivalent</th>}
          <th style={{ width: 80 }} />
        </tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <Fragment key={i}>
              <tr>
                <td>
                  <MasterLookup ariaLabel={`Account line ${i + 1}`} placeholder="Type account code or name…" value={l.accountId}
                    options={accountOptions} add={{ kind: "accounts" }} onChange={(v) => set(i, { accountId: v })} />
                </td>
                <td><input value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
                <td><input className="num" inputMode="decimal" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} aria-label={`Debit line ${i + 1}`} /></td>
                <td><input className="num" inputMode="decimal" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} aria-label={`Credit line ${i + 1}`} /></td>
                {foreign && <td className="num muted">{money(Math.round((cents(l.debit) || cents(l.credit)) * rate))}</td>}
                <td style={{ whiteSpace: "nowrap" }}>
                  <button type="button" className="link" title="Fill the amount that balances the entry" onClick={() => balanceHere(i)}>balance</button>{" "}
                  {lines.length > 2 && <button type="button" className="link" style={{ color: "var(--danger)" }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>}
                </td>
              </tr>
              {showDims && dims.length > 0 && (
                <tr className="dims"><td colSpan={foreign ? 6 : 5} style={{ background: "#fafbfc" }}>
                  <div className="row" style={{ gap: 6 }}>
                    {dims.map((d) => (
                      <div key={d.key} style={{ minWidth: 130 }}>
                        <label>{d.label}</label>
                        <MasterLookup ariaLabel={`${d.label} line ${i + 1}`} placeholder="—" emptyLabel="— None" value={l.dims[d.key] ?? ""}
                          options={d.values.map((v) => ({ value: v.id, code: v.code, label: v.name }))}
                          add={dimAdd(d.key)} onChange={(v) => setDim(i, d.key, v)} />
                      </div>
                    ))}
                  </div>
                </td></tr>
              )}
            </Fragment>
          ))}
          <tr className="total">
            <td>
              <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, blank()])}>+ Add line</button>{" "}
              {dims.length > 0 && <button type="button" className="secondary" onClick={() => setShowDims(!showDims)}>{showDims ? "Hide" : "Show"} dimensions</button>}
            </td>
            <td className="num">Totals</td>
            <td className="num">{money(totals.d)}</td>
            <td className="num">{money(totals.c)}</td>
            {foreign && <td className="num">{money(Math.round(totals.d * rate))}</td>}
            <td />
          </tr>
        </tbody>
      </table></div>
      {dims.length === 0 && <p className="muted">Tip: add departments, branches, projects, cost centers and other dimensions under Master Lists → Dimensions to tag lines for management reports.</p>}
      <p className={balanced ? "diff-ok" : "diff-bad"}>
        {totals.diff === 0 ? (totals.d > 0 ? "Balanced ✓" : "Enter amounts") : `Out of balance by ${money(Math.abs(totals.diff))} (${totals.diff > 0 ? "more debits" : "more credits"})`}
      </p>

      <div className="card">
        <strong>Supporting documents</strong> <span className="muted">(links to the scanned invoice, OR, contract, etc.)</span>
        {atts.map((a, i) => (
          <div className="row" key={i} style={{ marginTop: 6 }}>
            <div><input placeholder="Name, e.g. SI 0001" value={a.name} onChange={(e) => setAtts(atts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></div>
            <div style={{ flex: 3 }}><input placeholder="https://drive.google.com/…" value={a.url} onChange={(e) => setAtts(atts.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} /></div>
            <div style={{ flex: 0 }}><button type="button" className="link" onClick={() => setAtts(atts.filter((_, j) => j !== i))}>✕</button></div>
          </div>
        ))}
        <div style={{ marginTop: 6 }}><button type="button" className="secondary" onClick={() => setAtts([...atts, { name: "", url: "" }])}>+ Add document link</button></div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button name="payload" value={payload("draft")} className="secondary" disabled={pending}>Save as draft</button>
        <button name="payload" value={payload("submit")} className={requireApproval ? "" : "secondary"} disabled={pending || !balanced}>Submit for approval</button>
        {canPost && !requireApproval && <button name="payload" value={payload("post")} disabled={pending || !balanced}>Save and post</button>}
      </div>
    </form>
  );
}
