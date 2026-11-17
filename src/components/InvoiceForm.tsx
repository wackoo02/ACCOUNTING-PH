"use client";
import { Fragment, useActionState, useMemo, useState } from "react";
import { saveInvoiceAction } from "@/app/(app)/ar-actions";
import type { InvoiceFormData } from "@/lib/ar/form-data";
import { Errors } from "./Errors";
import { MasterLookup } from "./MasterLookup";
import { dimAdd, idOpts } from "@/lib/lookup";

export type InvLine = { productId: string; description: string; quantity: string; unit: string; unitPrice: string; discount: string; vatType: string; accountId: string; dims: Record<string, string>; lotNo?: string };
export type InvoiceInitial = {
  id?: string; kind: "INVOICE" | "CREDIT_MEMO"; customerId: string; date: string; termsDays: string; dueDate: string; fxRate: string; pricesIncludeVat: boolean;
  reference: string; memo: string; ewtTaxCodeId: string; creditForId: string; reason: string; lines: InvLine[]; warehouseId?: string;
};
export const blankLine = (): InvLine => ({ productId: "", description: "", quantity: "1", unit: "", unitPrice: "", discount: "", vatType: "VATABLE", accountId: "", dims: {} });
const num = (s: string) => { const n = Number(String(s).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
export const money = (n: number) => n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Same rules as the server (src/lib/ar/compute.ts), in floating point for the live preview only. */
export function previewTotals(lines: InvLine[], inclusive: boolean, vatRegistered: boolean, ewtRate: number) {
  let vatGross = 0, zero = 0, exempt = 0;
  for (const l of lines) {
    const g = Math.round((num(l.quantity) * num(l.unitPrice) - num(l.discount)) * 100) / 100;
    if (vatRegistered && l.vatType === "VATABLE") vatGross += g; else if (vatRegistered && l.vatType === "ZERO_RATED") zero += g; else exempt += g;
  }
  const vatable = inclusive ? Math.round((vatGross / 1.12) * 100) / 100 : vatGross;
  const vat = inclusive ? Math.round((vatGross - vatable) * 100) / 100 : Math.round(vatGross * 12) / 100;
  const total = vatable + vat + zero + exempt;
  const ewt = Math.round((vatable + zero + exempt) * ewtRate) / 100;
  return { vatable, vat, zero, exempt, total, ewt };
}

export function LineEditor({ lines, setLines, data, showAccounts }: { lines: InvLine[]; setLines: (f: (l: InvLine[]) => InvLine[]) => void; data: InvoiceFormData; showAccounts: boolean }) {
  const { products, accounts, dims, vatRegistered } = data;
  const [showDims, setShowDims] = useState(lines.some((l) => Object.values(l.dims).some(Boolean)));
  const productOpts = useMemo(() => idOpts(products), [products]);
  const accountOpts = useMemo(() => idOpts(accounts), [accounts]);
  const set = (i: number, p: Partial<InvLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const pick = (i: number, id: string) => {
    const p = products.find((x) => x.id === id);
    set(i, p ? { productId: id, description: p.name, unit: p.unit, unitPrice: p.price, vatType: p.vatType } : { productId: "" });
  };
  return (
    <div className="table-wrap"><table>
      <thead><tr>
        <th style={{ width: 150 }}>Product / service</th><th>Description</th><th className="num" style={{ width: 70 }}>Qty</th><th style={{ width: 60 }}>Unit</th>
        <th className="num" style={{ width: 110 }}>Unit price</th><th className="num" style={{ width: 90 }}>Discount</th>{vatRegistered && <th style={{ width: 120 }}>VAT</th>}
        {showAccounts && <th style={{ width: 170 }}>Revenue account</th>}<th className="num" style={{ width: 110 }}>Amount</th><th style={{ width: 30 }} />
      </tr></thead>
      <tbody>
        {lines.map((l, i) => (
          <Fragment key={i}>
            <tr>
              <td><MasterLookup ariaLabel={`Product line ${i + 1}`} placeholder="Type item code or name…" emptyLabel="— None" value={l.productId} options={productOpts} add={{ kind: "products" }}
                onChange={(v, rec) => (rec ? set(i, { productId: v, description: rec.label }) : pick(i, v))} /></td>
              <td><input value={l.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={`Description line ${i + 1}`} />
                {products.find((p) => p.id === l.productId)?.specific && <input value={l.lotNo ?? ""} onChange={(e) => set(i, { lotNo: e.target.value })} placeholder="Lot / serial no." aria-label={`Lot line ${i + 1}`} style={{ marginTop: 4 }} />}</td>
              <td><input className="num" inputMode="decimal" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} /></td>
              <td><input value={l.unit} onChange={(e) => set(i, { unit: e.target.value })} /></td>
              <td><input className="num" inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} aria-label={`Unit price line ${i + 1}`} /></td>
              <td><input className="num" inputMode="decimal" value={l.discount} onChange={(e) => set(i, { discount: e.target.value })} /></td>
              {vatRegistered && <td><select value={l.vatType} onChange={(e) => set(i, { vatType: e.target.value })}><option value="VATABLE">VATable 12%</option><option value="ZERO_RATED">Zero-rated</option><option value="EXEMPT">VAT-exempt</option></select></td>}
              {showAccounts && <td><MasterLookup ariaLabel={`Revenue account line ${i + 1}`} placeholder="Default" emptyLabel="Default" value={l.accountId} options={accountOpts} add={{ kind: "accounts" }} onChange={(v) => set(i, { accountId: v })} /></td>}
              <td className="num">{money(Math.round((num(l.quantity) * num(l.unitPrice) - num(l.discount)) * 100) / 100)}</td>
              <td>{lines.length > 1 && <button type="button" className="link" style={{ color: "var(--danger)" }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>}</td>
            </tr>
            {showDims && <tr><td colSpan={10} style={{ background: "#fafbfc" }}><div className="row" style={{ gap: 6 }}>
              {dims.map((d) => <div key={d.key} style={{ minWidth: 130 }}><label>{d.label}</label>
                <MasterLookup ariaLabel={`${d.label} line ${i + 1}`} placeholder="—" emptyLabel="— None" value={l.dims[d.key] ?? ""} options={idOpts(d.values)} add={dimAdd(d.key)}
                  onChange={(v) => set(i, { dims: { ...l.dims, [d.key]: v } })} /></div>)}
            </div></td></tr>}
          </Fragment>
        ))}
        <tr><td colSpan={10}>
          <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, blankLine()])}>+ Add line</button>{" "}
          {dims.length > 0 && <button type="button" className="secondary" onClick={() => setShowDims(!showDims)}>{showDims ? "Hide" : "Show"} dimensions</button>}
        </td></tr>
      </tbody>
    </table></div>
  );
}

export function InvoiceForm(props: { data: InvoiceFormData; initial: InvoiceInitial; canPost: boolean; creditable: { id: string; label: string; customerId: string }[] }) {
  const { data, initial, canPost, creditable } = props;
  const { customers, taxCodes, currencies, baseCurrency, vatRegistered, requireApproval } = data;
  const [state, action, pending] = useActionState(saveInvoiceAction, undefined);
  const [h, setH] = useState(initial);
  const [lines, setLinesState] = useState<InvLine[]>(initial.lines.length ? initial.lines : [blankLine()]);
  const [showAccounts, setShowAccounts] = useState(initial.lines.some((l) => l.accountId));
  const setLines = (f: (l: InvLine[]) => InvLine[]) => setLinesState(f);
  const cm = h.kind === "CREDIT_MEMO";
  const cust = customers.find((c) => c.id === h.customerId);
  const ccy = cust?.currencyCode ?? baseCurrency;
  const foreign = ccy !== baseCurrency;
  const tc = taxCodes.find((t) => t.id === h.ewtTaxCodeId);
  const t = useMemo(() => previewTotals(lines, h.pricesIncludeVat, vatRegistered, tc ? Number(tc.rate) : 0), [lines, h.pricesIncludeVat, vatRegistered, tc]);
  const pickCustomer = (id: string) => {
    const c = customers.find((x) => x.id === id);
    setH({ ...h, customerId: id, termsDays: c ? String(c.termsDays) : h.termsDays, creditForId: "", fxRate: c && c.currencyCode !== baseCurrency ? currencies.find((x) => x.code === c.currencyCode)?.rate ?? "" : "1",
      ewtTaxCodeId: c && !c.withholdsTax ? "" : h.ewtTaxCodeId });
  };
  const payload = (intent: string) => JSON.stringify({ ...h, intent, fxRate: foreign ? h.fxRate : "1", lines: lines.map((l) => ({ ...l, dims: Object.fromEntries(Object.entries(l.dims).map(([k, v]) => [k, v || null])) })) });
  const ready = !!h.customerId && t.total > 0;
  return (
    <form action={action}>
      <Errors errors={state?.errors} />
      <div className="card">
        <div className="row">
          <div style={{ flex: 2 }}><label>Customer</label>
            <MasterLookup ariaLabel="Customer" required value={h.customerId} add={{ kind: "customers" }} onChange={(v) => pickCustomer(v)}
              options={idOpts(customers, (c) => (c.currencyCode !== baseCurrency ? c.currencyCode : undefined))} /></div>
          <div><label>{cm ? "Credit memo date" : "Invoice date"}</label><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} required /></div>
          {!cm && <div><label>Terms (days)</label><input className="num" inputMode="numeric" value={h.termsDays} onChange={(e) => setH({ ...h, termsDays: e.target.value, dueDate: "" })} /></div>}
          {!cm && <div><label>Due date (blank = date + terms)</label><input type="date" value={h.dueDate} onChange={(e) => setH({ ...h, dueDate: e.target.value })} /></div>}
          {foreign && <div><label>Rate (1 {ccy} = ? {baseCurrency})</label><input className="num" value={h.fxRate} onChange={(e) => setH({ ...h, fxRate: e.target.value })} /></div>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {cm && <div style={{ flex: 2 }}><label>Invoice being credited</label>
            <select value={h.creditForId} onChange={(e) => setH({ ...h, creditForId: e.target.value })}><option value="">— None (unapplied credit) —</option>
              {creditable.filter((c) => c.customerId === h.customerId).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>}
          {cm && <div style={{ flex: 2 }}><label>Reason</label><input value={h.reason} onChange={(e) => setH({ ...h, reason: e.target.value })} placeholder="e.g. Returned 2 units, price adjustment" required /></div>}
          <div><label>Reference (customer PO, DR no.)</label><input value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} /></div>
          {!cm && data.warehouses.length > 0 && lines.some((l) => data.products.find((p) => p.id === l.productId)?.isStocked) && <div><label>Ship from warehouse</label>
            <MasterLookup ariaLabel="Ship from warehouse" placeholder="Item default" emptyLabel="Item default" value={h.warehouseId ?? ""} options={idOpts(data.warehouses)} add={{ kind: "warehouses" }} onChange={(v) => setH({ ...h, warehouseId: v })} /></div>}
          {!cm && <div style={{ flex: 2 }}><label>Tax the customer will withhold (BIR 2307)</label>
            <MasterLookup ariaLabel="Withholding tax" placeholder="None" emptyLabel="None" value={h.ewtTaxCodeId} options={idOpts(taxCodes, (x) => `${x.rate}%`)} add={{ kind: "taxes" }} onChange={(v) => setH({ ...h, ewtTaxCodeId: v })} /></div>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ flex: 3 }}><label>Notes printed on the {cm ? "credit memo" : "invoice"}</label><input value={h.memo} onChange={(e) => setH({ ...h, memo: e.target.value })} /></div>
          {vatRegistered && <div><label><input type="checkbox" checked={h.pricesIncludeVat} onChange={(e) => setH({ ...h, pricesIncludeVat: e.target.checked })} style={{ width: "auto" }} /> Prices include VAT</label></div>}
          <div><label><input type="checkbox" checked={showAccounts} onChange={(e) => setShowAccounts(e.target.checked)} style={{ width: "auto" }} /> Choose revenue accounts</label></div>
        </div>
      </div>
      <LineEditor lines={lines} setLines={setLines} data={data} showAccounts={showAccounts} />
      <div className="card row">
        {vatRegistered ? <>
          <div className="stat"><div className="l">VATable sales</div><div className="n">{money(t.vatable)}</div></div>
          <div className="stat"><div className="l">VAT 12%</div><div className="n">{money(t.vat)}</div></div>
          <div className="stat"><div className="l">Zero-rated</div><div className="n">{money(t.zero)}</div></div>
          <div className="stat"><div className="l">VAT-exempt</div><div className="n">{money(t.exempt)}</div></div>
        </> : <p className="muted">Your company is set up as non-VAT: no VAT is added and the invoice says so.</p>}
        <div className="stat"><div className="l">Total {cm ? "credit" : "amount"}</div><div className="n">{ccy} {money(t.total)}</div></div>
        {tc && !cm && <div className="stat"><div className="l">Less withholding · amount due</div><div className="n">({money(t.ewt)}) · {money(t.total - t.ewt)}</div></div>}
      </div>
      {!cm && cust && !cust.withholdsTax && h.ewtTaxCodeId && <p className="muted">Note: this customer is not marked as a withholding agent in the customer list.</p>}
      <div className="row" style={{ gap: 8 }}>
        <button name="payload" value={payload("draft")} className="secondary" disabled={pending || !h.customerId}>Save as draft</button>
        <button name="payload" value={payload("submit")} className={requireApproval ? "" : "secondary"} disabled={pending || !ready}>Submit for approval</button>
        {canPost && !requireApproval && <button name="payload" value={payload("post")} disabled={pending || !ready}>Save and issue</button>}
      </div>
      <p className="muted">The {cm ? "credit memo" : "invoice"} number is taken from your BIR-registered series when it is approved, so drafts never use up a serial.</p>
    </form>
  );
}
