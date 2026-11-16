"use client";
import { Fragment, useActionState, useRef, useState } from "react";
import { saveInventoryDoc } from "@/app/(app)/inventory-actions";
import type { InventoryFormData } from "@/lib/inventory/form-data";
import { Errors } from "./Errors";

export type InvMode = "RECEIPT" | "ISSUE" | "TRANSFER" | "ADJUSTMENT" | "RETURN_IN" | "RETURN_OUT";
type Line = { itemId: string; qty: string; unitCost: string; locationId: string; toLocationId: string; lotNo: string; accountId: string; description: string; dims: Record<string, string> };
export type InvInitial = { id?: string; date: string; warehouseId: string; toWarehouseId: string; party: string; reference: string; memo: string; offsetAccountId: string; lines: Line[] };

export const blankInvLine = (): Line => ({ itemId: "", qty: "", unitCost: "", locationId: "", toLocationId: "", lotNo: "", accountId: "", description: "", dims: {} });

const OFFSET_HELP: Record<InvMode, string> = {
  RECEIPT: "Credit account (blank = 2022 Goods Received Not Yet Invoiced)",
  ISSUE: "Charge to (blank = the item's COGS account)",
  TRANSFER: "",
  ADJUSTMENT: "Adjustment account (blank = 5030 Inventory Losses and Count Adjustments)",
  RETURN_IN: "Credit account (blank = the item's COGS account)",
  RETURN_OUT: "Debit account (blank = 2022 GRNI; use Accounts Payable if already billed)",
};
const MEMO_HINT: Record<InvMode, string> = {
  RECEIPT: "e.g. Delivery from ABC Trading, DR 1234", ISSUE: "e.g. Issued to Production / Sales delivery", TRANSFER: "e.g. Replenish Cebu branch stock",
  ADJUSTMENT: "e.g. Damaged items written off", RETURN_IN: "e.g. Customer return, CM 0012", RETURN_OUT: "e.g. Defective items returned to supplier",
};

export function InventoryForm(props: InventoryFormData & { mode: InvMode; initial: InvInitial; canPost: boolean; canSubmit: boolean }) {
  const { mode, items, warehouses, locations, accounts, dims, parties, lots, initial, canPost, canSubmit } = props;
  const [state, action, pending] = useActionState(saveInventoryDoc, undefined);
  const [h, setH] = useState(initial);
  const [lines, setLines] = useState<Line[]>(initial.lines.length ? initial.lines : [blankInvLine()]);
  const [showMore, setShowMore] = useState(initial.lines.some((l) => l.accountId || Object.values(l.dims).some(Boolean)));
  const [scan, setScan] = useState("");
  const [scanMsg, setScanMsg] = useState("");
  const scanRef = useRef<HTMLInputElement>(null);
  const transfer = mode === "TRANSFER";
  const inbound = (l: Line) => mode === "RECEIPT" || mode === "RETURN_IN" || (mode === "ADJUSTMENT" && Number(l.qty) > 0);
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const locsOf = (whId: string) => locations.filter((l) => l.warehouseId === whId);

  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const setDim = (i: number, k: string, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, dims: { ...l.dims, [k]: v } } : l)));
  const pickItem = (i: number, id: string) => {
    const it = itemOf(id);
    set(i, { itemId: id, unitCost: mode === "RECEIPT" && it ? (Number(it.standardCost) ? it.standardCost : Number(it.purchaseCost) ? it.purchaseCost : "") : "" });
  };
  // A barcode scanner types the code and presses Enter.
  const onScan = () => {
    const s = scan.trim().toUpperCase();
    if (!s) return;
    const it = items.find((i) => i.barcode?.toUpperCase() === s || i.code.toUpperCase() === s);
    if (!it) { setScanMsg(`No inventory item with barcode or code "${scan.trim()}"`); return; }
    setScanMsg(`${it.code} ${it.name}`);
    setLines((ls) => {
      const k = ls.findIndex((l) => l.itemId === it.id && it.method !== "SPECIFIC");
      if (k >= 0) return ls.map((l, j) => (j === k ? { ...l, qty: String((Number(l.qty) || 0) + 1) } : l));
      const empty = ls.findIndex((l) => !l.itemId);
      const nl = { ...blankInvLine(), itemId: it.id, qty: "1", unitCost: mode === "RECEIPT" ? (Number(it.standardCost) ? it.standardCost : Number(it.purchaseCost) ? it.purchaseCost : "") : "" };
      return empty >= 0 ? ls.map((l, j) => (j === empty ? nl : l)) : [...ls, nl];
    });
    setScan("");
    scanRef.current?.focus();
  };
  const payload = (intent: "draft" | "submit" | "post") => JSON.stringify({
    ...h, id: initial.id, type: mode, intent, toWarehouseId: transfer ? h.toWarehouseId : "",
    lines: lines.filter((l) => l.itemId).map((l) => ({ ...l, unitCost: inbound(l) ? l.unitCost : "", dims: Object.fromEntries(Object.entries(l.dims).map(([k, v]) => [k, v || null])) })),
  });
  const total = lines.reduce((s, l) => s + (inbound(l) ? Math.abs(Number(l.qty) || 0) * (Number(l.unitCost) || 0) : 0), 0);
  const ready = !!h.warehouseId && (!transfer || !!h.toWarehouseId) && lines.some((l) => l.itemId && Number(l.qty));
  const approval = mode === "ADJUSTMENT";

  return (
    <form action={action}>
      <Errors errors={state?.errors} />
      <div className="card">
        <div className="row">
          <div><label>{transfer ? "From warehouse" : "Warehouse"}</label>
            <select value={h.warehouseId} onChange={(e) => setH({ ...h, warehouseId: e.target.value })} required>
              <option value="">Choose…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}
            </select></div>
          {transfer && <div><label>To warehouse</label>
            <select value={h.toWarehouseId} onChange={(e) => setH({ ...h, toWarehouseId: e.target.value })} required>
              <option value="">Choose…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}{w.id === h.warehouseId ? " (move between bins)" : ""}</option>)}
            </select></div>}
          <div><label>Date</label><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} required /></div>
          {!transfer && <div style={{ flex: 2 }}><label>{mode === "ISSUE" ? "Issued to" : mode === "RETURN_IN" ? "Customer" : mode === "ADJUSTMENT" ? "Party (optional)" : "Supplier"}</label>
            <select value={h.party} onChange={(e) => setH({ ...h, party: e.target.value })}>
              <option value="">—</option>{parties.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select></div>}
          <div><label>Reference (DR, PO, SI, CM)</label><input value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} /></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ flex: 3 }}><label>Particulars / purpose</label><input value={h.memo} onChange={(e) => setH({ ...h, memo: e.target.value })} required placeholder={MEMO_HINT[mode]} /></div>
          {!transfer && <div style={{ flex: 2 }}><label>{OFFSET_HELP[mode]}</label>
            <select value={h.offsetAccountId} onChange={(e) => setH({ ...h, offsetAccountId: e.target.value })}>
              <option value="">Default</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </select></div>}
        </div>
      </div>

      <div className="card row noprint">
        <div style={{ flex: 2 }}><label>Scan barcode or type item code, then Enter</label>
          <input ref={scanRef} value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onScan(); } }} placeholder="Barcode scanner input" autoComplete="off" /></div>
        <div style={{ flex: 3, alignSelf: "end" }} className="muted">{scanMsg}</div>
      </div>

      <div className="table-wrap"><table>
        <thead><tr>
          <th style={{ width: "30%" }}>Item</th>
          <th className="num" style={{ width: 110 }}>{mode === "ADJUSTMENT" ? "Qty (+ add / − remove)" : "Quantity"}</th>
          {mode !== "ISSUE" && mode !== "TRANSFER" && mode !== "RETURN_OUT" && <th className="num" style={{ width: 130 }}>Unit cost</th>}
          <th>{transfer ? "From bin" : "Location / bin"}</th>
          {transfer && <th>To bin</th>}
          <th>Lot / serial no.</th>
          <th>Line note</th><th style={{ width: 30 }} />
        </tr></thead>
        <tbody>
          {lines.map((l, i) => {
            const it = itemOf(l.itemId);
            const outLots = lots.filter((x) => x.itemId === l.itemId && x.warehouseId === h.warehouseId);
            return (
              <Fragment key={i}>
                <tr>
                  <td><select value={l.itemId} onChange={(e) => pickItem(i, e.target.value)} aria-label={`Item line ${i + 1}`}>
                    <option value="">Choose item…</option>{items.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}
                  </select>{it && <div className="muted">{it.unit ?? ""} · {it.method === "SPECIFIC" ? "specific identification" : it.method === "FIFO" ? "FIFO" : "weighted average"}</div>}</td>
                  <td><input className="num" inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} aria-label={`Quantity line ${i + 1}`} /></td>
                  {mode !== "ISSUE" && mode !== "TRANSFER" && mode !== "RETURN_OUT" && <td>{inbound(l)
                    ? <input className="num" inputMode="decimal" value={l.unitCost} onChange={(e) => set(i, { unitCost: e.target.value })} placeholder={mode === "RECEIPT" ? "" : "Current cost"} aria-label={`Unit cost line ${i + 1}`} />
                    : <span className="muted">at cost</span>}</td>}
                  <td><select value={l.locationId} onChange={(e) => set(i, { locationId: e.target.value })}>
                    <option value="">{inbound(l) ? "Default bin" : "Any"}</option>{locsOf(h.warehouseId).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
                  </select></td>
                  {transfer && <td><select value={l.toLocationId} onChange={(e) => set(i, { toLocationId: e.target.value })}>
                    <option value="">Default bin</option>{locsOf(h.toWarehouseId).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
                  </select></td>}
                  <td>{it?.method === "SPECIFIC" && !inbound(l)
                    ? <select value={l.lotNo} onChange={(e) => set(i, { lotNo: e.target.value })}><option value="">Choose lot…</option>{outLots.map((x) => <option key={x.lotNo} value={x.lotNo}>{x.lotNo} ({Number(x.qty)})</option>)}</select>
                    : <input value={l.lotNo} onChange={(e) => set(i, { lotNo: e.target.value })} placeholder={it?.method === "SPECIFIC" ? "Required" : "Optional"} />}</td>
                  <td><input value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
                  <td>{lines.length > 1 && <button type="button" className="link" style={{ color: "var(--danger)" }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>}</td>
                </tr>
                {showMore && !transfer && (
                  <tr><td colSpan={8} style={{ background: "#fafbfc" }}><div className="row" style={{ gap: 6 }}>
                    <div style={{ minWidth: 220 }}><label>Account for this line</label>
                      <select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })}><option value="">Document default</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></div>
                    {dims.map((d) => <div key={d.key} style={{ minWidth: 130 }}><label>{d.label}</label>
                      <select value={l.dims[d.key] ?? ""} onChange={(e) => setDim(i, d.key, e.target.value)}><option value="">—</option>{d.values.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}</select></div>)}
                  </div></td></tr>
                )}
              </Fragment>
            );
          })}
          <tr><td colSpan={8}>
            <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, blankInvLine()])}>+ Add line</button>{" "}
            {!transfer && <button type="button" className="secondary" onClick={() => setShowMore(!showMore)}>{showMore ? "Hide" : "Show"} accounts and dimensions</button>}
            {total > 0 && <span className="muted" style={{ marginLeft: 12 }}>Value of stock coming in: {total.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
          </td></tr>
        </tbody>
      </table></div>
      {mode === "ISSUE" || mode === "RETURN_OUT" || transfer ? <p className="muted">Cost is computed when posted, using each item&apos;s costing method (FIFO, weighted average or the chosen lot).</p> : null}

      <div className="row" style={{ gap: 8 }}>
        <button name="payload" value={payload("draft")} className="secondary" disabled={pending || !ready}>Save draft</button>
        {approval && canSubmit && <button name="payload" value={payload("submit")} disabled={pending || !ready}>Submit for approval</button>}
        {canPost && <button name="payload" value={payload("post")} className={approval ? "secondary" : ""} disabled={pending || !ready}>Post now</button>}
      </div>
    </form>
  );
}
