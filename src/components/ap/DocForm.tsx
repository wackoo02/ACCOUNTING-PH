"use client";
// One form for purchase requests, purchase orders and supplier bills (they share the item lines).
import { Fragment, useActionState, useMemo, useState } from "react";
import { savePrAction, savePoAction, saveBillAction } from "@/app/(app)/ap-actions";
import type { ApFormData } from "@/lib/ap/form-data";
import { Errors } from "../Errors";

export type DocMode = "PR" | "PO" | "BILL";
export type DocLine = {
  productId: string; description: string; category: string; accountId: string; quantity: string; unit: string; unitPrice: string; vatType: string;
  ewtTaxCodeId: string; poLineId: string; dims: Record<string, string>; prepaidStart: string; prepaidEnd: string; reason?: string;
};
export type DocHeader = {
  id?: string; vendorId: string; date: string; neededBy: string; purpose: string; deliverTo: string; terms: string; vatInclusive: boolean;
  currencyCode: string; fxRate: string; notes: string; invoiceNo: string; invoiceDate: string; dueDate: string; purchaseOrderId: string;
  departmentId: string; costCenterId: string; projectId: string; branchId: string; requestId: string; rfqId: string; inboxDocumentId: string;
};
export type OpenPo = { id: string; number: string; vendorId: string; vatInclusive: boolean; currencyCode: string; fxRate: string; lines: { id: string; lineNo: number; description: string; open: string; unit: string | null; unitPrice: string; vatType: string; category: string; accountId: string; dims: Record<string, string> }[] };

export const blankLine = (): DocLine => ({ productId: "", description: "", category: "EXPENSE", accountId: "", quantity: "1", unit: "", unitPrice: "", vatType: "VATABLE", ewtTaxCodeId: "", poLineId: "", dims: {}, prepaidStart: "", prepaidEnd: "" });
const CATS: [string, string][] = [["EXPENSE", "Expense"], ["PREPAYMENT", "Prepayment"], ["FIXED_ASSET", "Fixed asset"], ["INVENTORY", "Inventory"]];
const PPE = ["Property, plant and equipment", "Intangible assets", "Right-of-use assets"];
const fits = (cat: string, a: { type: string; ifrsGroup: string }) =>
  cat === "EXPENSE" ? a.type === "EXPENSE" : cat === "FIXED_ASSET" ? a.type === "ASSET" && PPE.includes(a.ifrsGroup) : cat === "INVENTORY" ? a.ifrsGroup === "Inventories" : a.type === "ASSET" && !PPE.includes(a.ifrsGroup) && a.ifrsGroup !== "Inventories";
const num = (v: string) => { const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const money = (n: number) => n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function DocForm({ mode, data, initial, initialLines, openPos = [], requireApproval = true, extraction }: {
  mode: DocMode; data: ApFormData; initial: DocHeader; initialLines: DocLine[]; openPos?: OpenPo[]; requireApproval?: boolean; extraction?: React.ReactNode;
}) {
  const action = mode === "PR" ? savePrAction : mode === "PO" ? savePoAction : saveBillAction;
  const [state, run, pending] = useActionState(action, undefined);
  const [h, setH] = useState(initial);
  const [lines, setLines] = useState<DocLine[]>(initialLines.length ? initialLines : [blankLine()]);
  const [showDims, setShowDims] = useState(initialLines.some((l) => Object.values(l.dims).some(Boolean)));
  const vendor = data.vendors.find((v) => v.id === h.vendorId);
  const vat = mode !== "PR" && (vendor?.vat ?? true);
  const po = openPos.find((p) => p.id === h.purchaseOrderId);
  const set = (i: number, p: Partial<DocLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const foreign = mode !== "PR" && h.currencyCode && h.currencyCode !== data.baseCurrency;

  const t = useMemo(() => {
    let net = 0, tax = 0, ewt = 0;
    for (const l of lines) {
      const gross = num(l.quantity) * num(l.unitPrice);
      const v = vat && l.vatType === "VATABLE" ? (h.vatInclusive ? (gross * 12) / 112 : gross * 0.12) : 0;
      const n = h.vatInclusive ? gross - v : gross;
      net += n; tax += v;
      const tc = data.taxCodes.find((x) => x.id === l.ewtTaxCodeId);
      if (mode === "BILL" && tc) ewt += (n * Number(tc.rate)) / 100;
    }
    return { net, tax, total: net + tax, ewt };
  }, [lines, vat, h.vatInclusive, data.taxCodes, mode]);

  const pickVendor = (id: string) => {
    const v = data.vendors.find((x) => x.id === id);
    setH({ ...h, vendorId: id, terms: v ? String(v.terms) : h.terms, currencyCode: v?.currency ?? h.currencyCode, purchaseOrderId: "", fxRate: v && v.currency !== data.baseCurrency ? data.currencies.find((c) => c.code === v.currency)?.rate ?? "" : "1" });
    if (mode === "BILL" && v?.ewtTaxCodeId) setLines((ls) => ls.map((l) => (l.ewtTaxCodeId ? l : { ...l, ewtTaxCodeId: v.ewtTaxCodeId })));
  };
  const copyPo = (p: OpenPo) => {
    setH((x) => ({ ...x, purchaseOrderId: p.id, vatInclusive: p.vatInclusive, currencyCode: p.currencyCode, fxRate: p.fxRate }));
    setLines(p.lines.filter((l) => num(l.open) > 0).map((l) => ({ ...blankLine(), description: l.description, category: l.category, accountId: l.accountId, quantity: l.open, unit: l.unit ?? "", unitPrice: l.unitPrice, vatType: l.vatType, poLineId: l.id, dims: l.dims, ewtTaxCodeId: vendor?.ewtTaxCodeId ?? "" })));
  };
  const pickProduct = (i: number, id: string) => {
    const p = data.products.find((x) => x.id === id);
    set(i, p ? { productId: id, description: p.name, unit: p.unit ?? "", unitPrice: p.cost !== "0" ? p.cost : lines[i].unitPrice, accountId: p.accountId || lines[i].accountId, vatType: p.vatType } : { productId: "" });
  };
  const body = (intent: string) => JSON.stringify({ ...h, intent, lines });
  const dimSel = (key: string, label: string) => {
    const d = data.dims.find((x) => x.key === key);
    if (!d) return null;
    return <div><label>{label}</label><select value={(h as unknown as Record<string, string>)[key] ?? ""} onChange={(e) => setH({ ...h, [key]: e.target.value })}><option value="">—</option>{d.values.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}</select></div>;
  };

  return (
    <form action={run}>
      <Errors errors={state?.errors} />
      {extraction}
      <div className="card">
        <div className="row">
          {mode !== "PR" && <div style={{ flex: 2 }}><label>Supplier</label>
            <select value={h.vendorId} onChange={(e) => pickVendor(e.target.value)} required>
              <option value="">Choose supplier…</option>
              {data.vendors.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.code}){v.tin ? ` · TIN ${v.tin}` : ""}</option>)}
            </select>{vendor && !vendor.vat && <div className="muted">Non-VAT supplier: no input VAT.</div>}</div>}
          {mode === "BILL" && <div><label>Supplier invoice no.</label><input value={h.invoiceNo} onChange={(e) => setH({ ...h, invoiceNo: e.target.value })} required /></div>}
          {mode === "BILL" && <div><label>Invoice date</label><input type="date" value={h.invoiceDate} onChange={(e) => setH({ ...h, invoiceDate: e.target.value })} required /></div>}
          <div><label>{mode === "BILL" ? "Posting date" : mode === "PO" ? "PO date" : "Date"}</label><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} required /></div>
          {mode !== "BILL" && <div><label>{mode === "PO" ? "Delivery date" : "Needed by"}</label><input type="date" value={h.neededBy} onChange={(e) => setH({ ...h, neededBy: e.target.value })} /></div>}
          {mode === "BILL" && <div><label>Due date (blank = invoice date + terms)</label><input type="date" value={h.dueDate} onChange={(e) => setH({ ...h, dueDate: e.target.value })} /></div>}
          {mode === "PO" && <div><label>Terms (days)</label><input className="num" value={h.terms} onChange={(e) => setH({ ...h, terms: e.target.value })} /></div>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ flex: 3 }}><label>{mode === "PR" ? "Purpose / justification" : mode === "PO" ? "What the PO is for" : "Particulars"}</label><input value={h.purpose} onChange={(e) => setH({ ...h, purpose: e.target.value })} required={mode !== "BILL"} /></div>
          {mode === "PO" && <div style={{ flex: 2 }}><label>Deliver to</label><input value={h.deliverTo} onChange={(e) => setH({ ...h, deliverTo: e.target.value })} /></div>}
          {mode === "BILL" && <div style={{ flex: 2 }}><label>Purchase order (for 3-way match)</label>
            <select value={h.purchaseOrderId} onChange={(e) => { const p = openPos.find((x) => x.id === e.target.value); if (p) copyPo(p); else setH({ ...h, purchaseOrderId: "" }); }}>
              <option value="">— No PO (direct expense) —</option>
              {openPos.filter((p) => !h.vendorId || p.vendorId === h.vendorId).map((p) => <option key={p.id} value={p.id}>{p.number}</option>)}
            </select>{po && <div className="muted">Lines copied from {po.number} with the quantity received and not yet billed.</div>}</div>}
        </div>
        {mode === "PR" && <div className="row" style={{ marginTop: 10 }}>{dimSel("departmentId", "Department")}{dimSel("costCenterId", "Cost center")}{dimSel("projectId", "Project")}{dimSel("branchId", "Branch")}</div>}
        {mode !== "PR" && <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
          <div style={{ flex: 2 }}><label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={h.vatInclusive} onChange={(e) => setH({ ...h, vatInclusive: e.target.checked })} disabled={!!po} /> Prices include 12% VAT (as printed on most PH invoices)</label></div>
          {foreign && <div><label>Rate (1 {h.currencyCode} = ? {data.baseCurrency})</label><input className="num" value={h.fxRate} onChange={(e) => setH({ ...h, fxRate: e.target.value })} disabled={!!po} /></div>}
          {mode === "PO" && <div style={{ flex: 2 }}><label>Notes to supplier</label><input value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></div>}
        </div>}
      </div>

      <div className="table-wrap"><table style={{ minWidth: mode === "PR" ? 760 : 1020 }}>
        <thead><tr>
          <th style={{ minWidth: 200 }}>Item</th><th>Type</th><th style={{ minWidth: 190 }}>Account</th><th className="num" style={{ width: 80, minWidth: 70 }}>Qty</th>
          {mode !== "BILL" && <th style={{ width: 70 }}>Unit</th>}
          <th className="num" style={{ width: 120 }}>{mode === "PR" ? "Est. unit cost" : "Unit price"}</th>
          {mode !== "PR" && <th style={{ width: 110 }}>VAT</th>}
          {mode === "BILL" && <th style={{ width: 150 }}>EWT</th>}
          <th className="num" style={{ width: 110 }}>Amount</th><th style={{ width: 30 }} />
        </tr></thead>
        <tbody>
          {lines.map((l, i) => {
            const opts = data.accounts.filter((a) => fits(l.category, a));
            const poLine = po?.lines.find((x) => x.id === l.poLineId);
            return (
              <Fragment key={i}>
                <tr>
                  <td>
                    {data.products.length > 0 && !l.poLineId && <select value={l.productId} onChange={(e) => pickProduct(i, e.target.value)} style={{ marginBottom: 4 }}><option value="">— free text —</option>{data.products.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select>}
                    <input value={l.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Description" aria-label={`Description line ${i + 1}`} />
                    {poLine && <div className="muted">PO line {poLine.lineNo} · open {poLine.open}</div>}
                    {l.reason && <div className="muted">AI: {l.reason}</div>}
                  </td>
                  <td><select value={l.category} onChange={(e) => set(i, { category: e.target.value, accountId: "" })} aria-label={`Type line ${i + 1}`}>{CATS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
                  <td><select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={`Account line ${i + 1}`} required={mode !== "PR"}>
                    <option value="">Choose…</option>{opts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                    {l.accountId && !opts.some((a) => a.id === l.accountId) && <option value={l.accountId}>{data.accounts.find((a) => a.id === l.accountId)?.code ?? "?"} (does not fit the type)</option>}
                  </select></td>
                  <td><input className="num" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} aria-label={`Quantity line ${i + 1}`} /></td>
                  {mode !== "BILL" && <td><input value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} /></td>}
                  <td><input className="num" inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} aria-label={`Unit price line ${i + 1}`} /></td>
                  {mode !== "PR" && <td><select value={l.vatType} onChange={(e) => set(i, { vatType: e.target.value })}><option value="VATABLE">VATable</option><option value="ZERO_RATED">Zero-rated</option><option value="EXEMPT">Exempt</option></select></td>}
                  {mode === "BILL" && <td><select value={l.ewtTaxCodeId} onChange={(e) => set(i, { ewtTaxCodeId: e.target.value })}><option value="">None</option>{data.taxCodes.map((t) => <option key={t.id} value={t.id}>{t.atc ?? t.code} {t.rate}%</option>)}</select></td>}
                  <td className="num">{money(num(l.quantity) * num(l.unitPrice))}</td>
                  <td>{lines.length > 1 && <button type="button" className="link" style={{ color: "var(--danger)" }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>}</td>
                </tr>
                {(showDims && mode !== "PR") || (mode === "BILL" && l.category === "PREPAYMENT") ? (
                  <tr><td colSpan={10} style={{ background: "#fafbfc" }}><div className="row" style={{ gap: 6 }}>
                    {mode === "BILL" && l.category === "PREPAYMENT" && <>
                      <div style={{ minWidth: 140 }}><label>Coverage from</label><input type="date" value={l.prepaidStart} onChange={(e) => set(i, { prepaidStart: e.target.value })} /></div>
                      <div style={{ minWidth: 140 }}><label>Coverage to</label><input type="date" value={l.prepaidEnd} onChange={(e) => set(i, { prepaidEnd: e.target.value })} /></div>
                    </>}
                    {showDims && data.dims.map((d) => <div key={d.key} style={{ minWidth: 130 }}><label>{d.label}</label>
                      <select value={l.dims[d.key] ?? ""} onChange={(e) => set(i, { dims: { ...l.dims, [d.key]: e.target.value } })}><option value="">—</option>{d.values.map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}</select></div>)}
                  </div></td></tr>
                ) : null}
              </Fragment>
            );
          })}
          <tr><td colSpan={10}>
            <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, { ...blankLine(), ewtTaxCodeId: vendor?.ewtTaxCodeId ?? "" }])}>+ Add line</button>{" "}
            {mode !== "PR" && data.dims.length > 0 && <button type="button" className="secondary" onClick={() => setShowDims(!showDims)}>{showDims ? "Hide" : "Show"} dimensions</button>}
          </td></tr>
        </tbody>
      </table></div>

      <div className="card grid" style={{ marginTop: 12 }}>
        {mode !== "PR" && <div><label>Net of VAT</label>{money(t.net)}</div>}
        {mode !== "PR" && <div><label>VAT</label>{money(t.tax)}</div>}
        <div><label>{mode === "PR" ? "Estimated total" : "Total"}</label><strong>{h.currencyCode && mode !== "PR" ? h.currencyCode + " " : ""}{money(t.total)}</strong></div>
        {mode === "BILL" && <div><label>Less EWT</label>({money(t.ewt)})</div>}
        {mode === "BILL" && <div><label>Net payable to supplier</label><strong>{money(t.total - t.ewt)}</strong></div>}
      </div>
      {mode === "BILL" && <p className="muted">Approximate; the server recomputes VAT and EWT to the centavo. Lines matched to a PO clear the &quot;goods received not yet invoiced&quot; account; any price difference goes to the line&apos;s account.</p>}

      <div className="row" style={{ gap: 8 }}>
        <button name="payload" value={body("draft")} disabled={pending} className="secondary">Save draft</button>
        <button name="payload" value={body("submit")} disabled={pending}>{requireApproval ? "Save and submit for approval" : "Save and submit"}</button>
      </div>
    </form>
  );
}
