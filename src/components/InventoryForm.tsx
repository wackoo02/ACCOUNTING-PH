"use client";
import { Fragment, useActionState, useMemo, useRef, useState } from "react";
import { saveInventoryDoc } from "@/app/(app)/inventory-actions";
import type { InventoryFormData } from "@/lib/inventory/form-data";
import { Errors } from "./Errors";
import { MasterLookup, type AddTarget } from "./MasterLookup";
import { dimAdd, idOpts, partyAdd, partyOpt } from "@/lib/lookup";

export type InvMode = "RECEIPT" | "ISSUE" | "TRANSFER" | "ADJUSTMENT" | "RETURN_IN" | "RETURN_OUT";
type Line = { itemId: string; qty: string; unitCost: string; locationId: string; toLocationId: string; lotNo: string; accountId: string; description: string; dims: Record<string, string> };
export type InvInitial = { id?: string; date: string; warehouseId: string; toWarehouseId: string; party: string; reference: string; memo: string; offsetAccountId: string; lines: Line[] };

export const blankInvLine = (): Line => ({ itemId: "", qty: "", unitCost: "", locationId: "", toLocationId: "", lotNo: "", accountId: "", description: "", dims: {} });

const OFFSET_HELP: Record<InvMode, string> = {
  RECEIPT: "Credit account (blank = Goods Received Not Yet Invoiced)",
  ISSUE: "Charge to (blank = the item's COGS account)",
  TRANSFER: "",
  ADJUSTMENT: "Adjustment account (blank = 5030 Inventory Losses and Count Adjustments)",
  RETURN_IN: "Credit account (blank = the item's COGS account)",
  RETURN_OUT: "Debit account (blank = Goods Received Not Yet Invoiced; use Accounts Payable if already billed)",
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

  const itemOpts = useMemo(() => idOpts(items), [items]);
  const accountOpts = useMemo(() => idOpts(accounts), [accounts]);
  const binAdd = (whId: string): AddTarget | undefined => {
    const w = warehouses.find((x) => x.id === whId);
    return w ? { kind: "locations", noun: "bin", prefill: { warehouseCode: w.code } } : undefined;
  };
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
            <MasterLookup ariaLabel="Warehouse" required value={h.warehouseId} options={idOpts(warehouses)} add={{ kind: "warehouses" }} onChange={(v) => setH({ ...h, warehouseId: v })} /></div>
          {transfer && <div><label>To warehouse</label>
            <MasterLookup ariaLabel="To warehouse" required value={h.toWarehouseId} options={idOpts(warehouses, (w) => (w.id === h.warehouseId ? "move between bins" : undefined))} add={{ kind: "warehouses" }} onChange={(v) => setH({ ...h, toWarehouseId: v })} /></div>}
          <div><label>Date</label><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} required /></div>
          {!transfer && <div style={{ flex: 2 }}><label>{mode === "ISSUE" ? "Issued to" : mode === "RETURN_IN" ? "Customer" : mode === "ADJUSTMENT" ? "Party (optional)" : "Supplier"}</label>
            <MasterLookup ariaLabel="Party" placeholder="—" emptyLabel="— None" value={h.party} options={parties.map((p) => partyOpt(p.value, p.label))} onChange={(v) => setH({ ...h, party: v })}
              add={partyAdd(mode === "ISSUE" ? ["employees", "customers", "vendors"] : mode === "RETURN_IN" ? ["customers"] : ["vendors", "customers", "employees"])} /></div>}
          <div><label>Reference (DR, PO, SI, CM)</label><input value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} /></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ flex: 3 }}><label>Particulars / purpose</label><input value={h.memo} onChange={(e) => setH({ ...h, memo: e.target.value })} required placeholder={MEMO_HINT[mode]} /></div>
          {!transfer && <div style={{ flex: 2 }}><label>{OFFSET_HELP[mode]}</label>
            <MasterLookup ariaLabel="Offset account" placeholder="Default" emptyLabel="Default" value={h.offsetAccountId} options={accountOpts} add={{ kind: "accounts" }} onChange={(v) => setH({ ...h, offsetAccountId: v })} /></div>}
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
                  <td><MasterLookup ariaLabel={`Item line ${i + 1}`} placeholder="Type item code or name…" value={l.itemId} options={itemOpts} add={{ kind: "products", noun: "item" }} onChange={(v) => pickItem(i, v)} />{it && <div className="muted">{it.unit ?? ""} · {it.method === "SPECIFIC" ? "specific identification" : it.method === "FIFO" ? "FIFO" : "weighted average"}</div>}</td>
                  <td><input className="num" inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} aria-label={`Quantity line ${i + 1}`} /></td>
                  {mode !== "ISSUE" && mode !== "TRANSFER" && mode !== "RETURN_OUT" && <td>{inbound(l)
                    ? <input className="num" inputMode="decimal" value={l.unitCost} onChange={(e) => set(i, { unitCost: e.target.value })} placeholder={mode === "RECEIPT" ? "" : "Current cost"} aria-label={`Unit cost line ${i + 1}`} />
                    : <span className="muted">at cost</span>}</td>}
                  <td><MasterLookup ariaLabel={`Bin line ${i + 1}`} placeholder={inbound(l) ? "Default bin" : "Any"} emptyLabel={inbound(l) ? "Default bin" : "Any"} value={l.locationId} options={idOpts(locsOf(h.warehouseId))}
                    add={binAdd(h.warehouseId)} onChange={(v) => set(i, { locationId: v })} /></td>
                  {transfer && <td><MasterLookup ariaLabel={`To bin line ${i + 1}`} placeholder="Default bin" emptyLabel="Default bin" value={l.toLocationId} options={idOpts(locsOf(h.toWarehouseId))}
                    add={binAdd(h.toWarehouseId)} onChange={(v) => set(i, { toLocationId: v })} /></td>}
                  <td>{it?.method === "SPECIFIC" && !inbound(l)
                    ? <select value={l.lotNo} onChange={(e) => set(i, { lotNo: e.target.value })}><option value="">Choose lot…</option>{outLots.map((x) => <option key={x.lotNo} value={x.lotNo}>{x.lotNo} ({Number(x.qty)})</option>)}</select>
                    : <input value={l.lotNo} onChange={(e) => set(i, { lotNo: e.target.value })} placeholder={it?.method === "SPECIFIC" ? "Required" : "Optional"} />}</td>
                  <td><input value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
                  <td>{lines.length > 1 && <button type="button" className="link" style={{ color: "var(--danger)" }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>}</td>
                </tr>
                {showMore && !transfer && (
                  <tr><td colSpan={8} style={{ background: "#fafbfc" }}><div className="row" style={{ gap: 6 }}>
                    <div style={{ minWidth: 220 }}><label>Account for this line</label>
                      <MasterLookup ariaLabel={`Account line ${i + 1}`} placeholder="Document default" emptyLabel="Document default" value={l.accountId} options={accountOpts} add={{ kind: "accounts" }} onChange={(v) => set(i, { accountId: v })} /></div>
                    {dims.map((d) => <div key={d.key} style={{ minWidth: 130 }}><label>{d.label}</label>
                      <MasterLookup ariaLabel={`${d.label} line ${i + 1}`} placeholder="—" emptyLabel="— None" value={l.dims[d.key] ?? ""} options={idOpts(d.values)} add={dimAdd(d.key)} onChange={(v) => setDim(i, d.key, v)} /></div>)}
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
