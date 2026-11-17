"use client";
import { useActionState, useState } from "react";
import { saveContractAction } from "@/app/(app)/ar-actions";
import type { InvoiceFormData } from "@/lib/ar/form-data";
import { Errors } from "./Errors";
import { MasterLookup } from "./MasterLookup";
import { idOpts } from "@/lib/lookup";
import { LineEditor, blankLine, money, previewTotals, type InvLine } from "./InvoiceForm";

type Milestone = { id?: string; description: string; percent: string; amount: string; dueDate: string; vatType: string; billed?: boolean };
export type ContractInitial = {
  id?: string; kind: string; name: string; customerId: string; startDate: string; endDate: string; frequency: string; nextBillDate: string; termsDays: string;
  contractValue: string; pricesIncludeVat: boolean; ewtTaxCodeId: string; autoSubmit: boolean; status: string; memo: string; lines: InvLine[]; milestones: Milestone[];
};
const KINDS: Record<string, string> = { SUBSCRIPTION: "Subscription (same amount every period)", CONTRACT: "Service / retainer contract (fixed term)", PROJECT: "Project (bill by milestone)" };
const FREQ: Record<string, string> = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", SEMI_ANNUAL: "Semi-annual", ANNUAL: "Annual" };

export function ContractForm({ data, initial }: { data: InvoiceFormData; initial: ContractInitial }) {
  const [state, action, pending] = useActionState(saveContractAction, undefined);
  const [h, setH] = useState(initial);
  const [lines, setLinesState] = useState<InvLine[]>(initial.lines.length ? initial.lines : [blankLine()]);
  const [ms, setMs] = useState<Milestone[]>(initial.milestones.length ? initial.milestones : [{ description: "", percent: "", amount: "", dueDate: "", vatType: "VATABLE" }]);
  const project = h.kind === "PROJECT";
  const tc = data.taxCodes.find((t) => t.id === h.ewtTaxCodeId);
  const t = previewTotals(lines, h.pricesIncludeVat, data.vatRegistered, tc ? Number(tc.rate) : 0);
  const value = Number(h.contractValue.replace(/,/g, "")) || 0;
  const msTotal = ms.reduce((s, m) => s + (m.amount.trim() ? Number(m.amount.replace(/,/g, "")) || 0 : (value * (Number(m.percent) || 0)) / 100), 0);
  const setM = (i: number, p: Partial<Milestone>) => setMs((xs) => xs.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const payload = JSON.stringify({
    ...h, endDate: h.endDate || undefined, nextBillDate: h.nextBillDate || undefined,
    lines: project ? [] : lines.map((l) => ({ ...l, dims: Object.fromEntries(Object.entries(l.dims).map(([k, v]) => [k, v || null])) })),
    milestones: project ? ms.filter((m) => !m.billed).map((m) => ({ id: m.id, description: m.description, percent: m.percent, amount: m.amount, dueDate: m.dueDate || undefined, vatType: m.vatType })) : [],
  });
  return (
    <form action={action}>
      <Errors errors={state?.errors} />
      <div className="card">
        <div className="row">
          <div style={{ flex: 2 }}><label>Billing type</label><select value={h.kind} onChange={(e) => setH({ ...h, kind: e.target.value })} disabled={!!initial.id}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div style={{ flex: 2 }}><label>Name</label><input value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} placeholder="e.g. Monthly IT support retainer" required /></div>
          <div style={{ flex: 2 }}><label>Customer</label><MasterLookup ariaLabel="Customer" required value={h.customerId} options={idOpts(data.customers)} add={{ kind: "customers" }} onChange={(v) => setH({ ...h, customerId: v })} /></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div><label>Start date</label><input type="date" value={h.startDate} onChange={(e) => setH({ ...h, startDate: e.target.value })} required /></div>
          <div><label>End date (blank = until stopped)</label><input type="date" value={h.endDate} onChange={(e) => setH({ ...h, endDate: e.target.value })} /></div>
          {!project && <div><label>Bill every</label><select value={h.frequency} onChange={(e) => setH({ ...h, frequency: e.target.value })}>{Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>}
          {!project && <div><label>Next billing date (blank = start date)</label><input type="date" value={h.nextBillDate} onChange={(e) => setH({ ...h, nextBillDate: e.target.value })} /></div>}
          <div><label>Terms (days, blank = customer&apos;s)</label><input className="num" value={h.termsDays} onChange={(e) => setH({ ...h, termsDays: e.target.value })} /></div>
          <div><label>{project ? "Contract value" : "Total contract value (optional)"}</label><input className="num" value={h.contractValue} onChange={(e) => setH({ ...h, contractValue: e.target.value })} /></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ flex: 2 }}><label>Tax the customer withholds (BIR 2307)</label><MasterLookup ariaLabel="Withholding tax" placeholder="None" emptyLabel="None" value={h.ewtTaxCodeId} options={idOpts(data.taxCodes, (x) => `${x.rate}%`)} add={{ kind: "taxes" }} onChange={(v) => setH({ ...h, ewtTaxCodeId: v })} /></div>
          {data.vatRegistered && <div><label><input type="checkbox" checked={h.pricesIncludeVat} onChange={(e) => setH({ ...h, pricesIncludeVat: e.target.checked })} style={{ width: "auto" }} /> Prices include VAT</label></div>}
          <div><label><input type="checkbox" checked={h.autoSubmit} onChange={(e) => setH({ ...h, autoSubmit: e.target.checked })} style={{ width: "auto" }} /> Send new invoices straight to approval</label></div>
          {initial.id && <div><label>Status</label><select value={h.status} onChange={(e) => setH({ ...h, status: e.target.value })}><option value="ACTIVE">Active</option><option value="PAUSED">Paused</option><option value="ENDED">Ended</option></select></div>}
        </div>
        <div style={{ marginTop: 10 }}><label>Notes</label><input value={h.memo} onChange={(e) => setH({ ...h, memo: e.target.value })} /></div>
      </div>
      {!project ? <>
        <h2>Billed every period</h2>
        <LineEditor lines={lines} setLines={(f) => setLinesState(f)} data={data} showAccounts={lines.some((l) => l.accountId)} />
        <p className="muted">Each invoice: {money(t.total)} incl. VAT{tc ? `, less ${money(t.ewt)} withholding` : ""}.</p>
      </> : <>
        <h2>Milestones</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Description</th><th className="num" style={{ width: 90 }}>% of value</th><th className="num" style={{ width: 130 }}>or amount</th><th style={{ width: 150 }}>Target date</th>{data.vatRegistered && <th style={{ width: 130 }}>VAT</th>}<th style={{ width: 30 }} /></tr></thead>
          <tbody>
            {ms.map((m, i) => <tr key={i}>
              <td><input value={m.description} onChange={(e) => setM(i, { description: e.target.value })} disabled={m.billed} placeholder="e.g. 30% downpayment" /></td>
              <td><input className="num" value={m.percent} onChange={(e) => setM(i, { percent: e.target.value })} disabled={m.billed} /></td>
              <td><input className="num" value={m.amount} onChange={(e) => setM(i, { amount: e.target.value })} disabled={m.billed} /></td>
              <td><input type="date" value={m.dueDate} onChange={(e) => setM(i, { dueDate: e.target.value })} disabled={m.billed} /></td>
              {data.vatRegistered && <td><select value={m.vatType} onChange={(e) => setM(i, { vatType: e.target.value })} disabled={m.billed}><option value="VATABLE">VATable</option><option value="ZERO_RATED">Zero-rated</option><option value="EXEMPT">Exempt</option></select></td>}
              <td>{!m.billed && ms.length > 1 && <button type="button" className="link" style={{ color: "var(--danger)" }} onClick={() => setMs((xs) => xs.filter((_, j) => j !== i))}>✕</button>}{m.billed && "billed"}</td>
            </tr>)}
            <tr><td colSpan={6}><button type="button" className="secondary" onClick={() => setMs((xs) => [...xs, { description: "", percent: "", amount: "", dueDate: "", vatType: "VATABLE" }])}>+ Add milestone</button> <span className="muted">Milestones total {money(msTotal)} of {money(value)} (before VAT unless prices include VAT).</span></td></tr>
          </tbody>
        </table></div>
      </>}
      <button name="payload" value={payload} disabled={pending || !h.customerId || !h.name}>Save contract</button>
    </form>
  );
}
