"use client";
import { useActionState, useMemo, useState } from "react";
import { saveReceiptAction } from "@/app/(app)/ar-actions";
import type { ReceiptFormData } from "@/lib/ar/form-data";
import { Errors } from "./Errors";
import { money } from "./InvoiceForm";

export type ReceiptInitial = {
  id?: string; customerId: string; date: string; bankAccountId: string; method: string; checkNo: string; checkDate: string; checkBank: string;
  reference: string; memo: string; fxRate: string; cashAmount: string; withholdingTaxCodeId: string; withholdingAmount: string; applications: Record<string, string>;
};
const METHODS: Record<string, string> = { CHECK: "Check", CASH: "Cash", BANK_TRANSFER: "Bank transfer / InstaPay / PESONet", ONLINE: "Online / card", EWALLET: "GCash / Maya" };
const num = (s: string) => { const n = Number(String(s).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;

export function ReceiptForm({ data, initial, canPost }: { data: ReceiptFormData; initial: ReceiptInitial; canPost: boolean }) {
  const { customers, banks, taxCodes, invoices, baseCurrency, requireApproval } = data;
  const [state, action, pending] = useActionState(saveReceiptAction, undefined);
  const [h, setH] = useState(initial);
  const bank = banks.find((b) => b.id === h.bankAccountId);
  const ccy = bank?.currencyCode ?? baseCurrency;
  const mine = invoices.filter((i) => i.customerId === h.customerId);
  const usable = mine.filter((i) => i.currencyCode === ccy);
  const applied = useMemo(() => Object.values(h.applications).reduce((s, v) => s + num(v), 0), [h.applications]);
  const received = num(h.cashAmount) + num(h.withholdingAmount);
  const unapplied = r2(received - applied);
  const setApp = (id: string, v: string) => setH({ ...h, applications: { ...h.applications, [id]: v } });

  /** Pay the ticked invoices in full: amount received = balance less the withholding expected on them. */
  const payAll = () => {
    const apps: Record<string, string> = {};
    let wht = 0, open = 0;
    for (const i of usable) { apps[i.id] = i.open.toFixed(2); open += i.open; wht += i.total ? (i.ewt * i.open) / i.total : 0; }
    wht = r2(wht);
    setH({ ...h, applications: apps, withholdingAmount: wht ? wht.toFixed(2) : "", withholdingTaxCodeId: wht ? h.withholdingTaxCodeId || usable.find((i) => i.ewtTaxCodeId)?.ewtTaxCodeId || "" : h.withholdingTaxCodeId, cashAmount: r2(open - wht).toFixed(2) });
  };
  /** Spread the amount received over the oldest invoices first. */
  const autoApply = () => {
    let left = received;
    const apps: Record<string, string> = {};
    for (const i of usable) { if (left <= 0) break; const a = Math.min(left, i.open); apps[i.id] = a.toFixed(2); left = r2(left - a); }
    setH({ ...h, applications: apps });
  };
  const payload = (intent: string) => JSON.stringify({
    ...h, intent, fxRate: ccy !== baseCurrency ? h.fxRate : "1",
    applications: Object.entries(h.applications).filter(([, v]) => num(v) !== 0).map(([invoiceId, amount]) => ({ invoiceId, amount: String(amount).replace(/,/g, "") })),
  });
  const ready = !!h.customerId && !!h.bankAccountId && received > 0 && unapplied >= 0;
  return (
    <form action={action}>
      <Errors errors={state?.errors} />
      <div className="card">
        <div className="row">
          <div style={{ flex: 2 }}><label>Received from (customer)</label>
            <select value={h.customerId} onChange={(e) => setH({ ...h, customerId: e.target.value, applications: {} })} required>
              <option value="">Choose…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
            </select></div>
          <div><label>Date received</label><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} required /></div>
          <div style={{ flex: 2 }}><label>Deposited to</label>
            <select value={h.bankAccountId} onChange={(e) => setH({ ...h, bankAccountId: e.target.value, applications: {} })} required>
              <option value="">Choose…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}{b.currencyCode !== baseCurrency ? ` (${b.currencyCode})` : ""}</option>)}
            </select></div>
          {ccy !== baseCurrency && <div><label>Rate (1 {ccy} = ? {baseCurrency})</label><input className="num" value={h.fxRate} onChange={(e) => setH({ ...h, fxRate: e.target.value })} /></div>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div><label>Paid by</label><select value={h.method} onChange={(e) => setH({ ...h, method: e.target.value })}>{Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          {h.method === "CHECK" && <>
            <div><label>Check no.</label><input value={h.checkNo} onChange={(e) => setH({ ...h, checkNo: e.target.value })} required /></div>
            <div><label>Check date</label><input type="date" value={h.checkDate} onChange={(e) => setH({ ...h, checkDate: e.target.value })} /></div>
            <div><label>Drawee bank</label><input value={h.checkBank} onChange={(e) => setH({ ...h, checkBank: e.target.value })} placeholder="e.g. BPI Makati" /></div>
          </>}
          <div><label>Reference (deposit slip, transfer ref.)</label><input value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} /></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <div><label>Cash / check amount received ({ccy})</label><input className="num" inputMode="decimal" value={h.cashAmount} onChange={(e) => setH({ ...h, cashAmount: e.target.value })} required /></div>
          <div style={{ flex: 2 }}><label>Tax withheld by the customer (BIR 2307)</label>
            <select value={h.withholdingTaxCodeId} onChange={(e) => setH({ ...h, withholdingTaxCodeId: e.target.value })}><option value="">None</option>{taxCodes.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</select></div>
          <div><label>Amount withheld</label><input className="num" inputMode="decimal" value={h.withholdingAmount} onChange={(e) => setH({ ...h, withholdingAmount: e.target.value })} /></div>
        </div>
        <div style={{ marginTop: 10 }}><label>Notes</label><input value={h.memo} onChange={(e) => setH({ ...h, memo: e.target.value })} /></div>
      </div>

      <h2>Apply to invoices</h2>
      {h.customerId && !usable.length && <p className="muted">No open {ccy} invoices for this customer. The whole amount will be recorded as an advance (Advances from Customers) that you can apply later.</p>}
      {mine.length > usable.length && <p className="muted">Invoices in another currency are hidden: deposit to a {mine.find((i) => i.currencyCode !== ccy)?.currencyCode} account to apply to them.</p>}
      {usable.length > 0 && <>
        <div className="row" style={{ gap: 8, marginBottom: 8 }}>
          <button type="button" className="secondary" onClick={payAll}>Pay all in full (less expected withholding)</button>
          <button type="button" className="secondary" onClick={autoApply}>Apply amount to oldest first</button>
          <button type="button" className="secondary" onClick={() => setH({ ...h, applications: {} })}>Clear</button>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th className="num">Total</th><th className="num">Open</th><th className="num" style={{ width: 150 }}>Apply</th></tr></thead>
          <tbody>{usable.map((i) => <tr key={i.id}>
            <td>SI {i.number}</td><td>{i.date}</td><td>{i.dueDate}</td><td className="num">{money(i.total)}</td><td className="num">{money(i.open)}</td>
            <td><input className="num" inputMode="decimal" value={h.applications[i.id] ?? ""} onChange={(e) => setApp(i.id, e.target.value)} aria-label={`Apply to ${i.number}`} /></td>
          </tr>)}</tbody>
        </table></div>
      </>}
      <div className="card row">
        <div className="stat"><div className="l">Cash + tax withheld</div><div className="n">{ccy} {money(received)}</div></div>
        <div className="stat"><div className="l">Applied to invoices</div><div className="n">{money(applied)}</div></div>
        <div className="stat"><div className="l">{unapplied < 0 ? "Over-applied" : "Advance (unapplied)"}</div><div className="n" style={unapplied < 0 ? { color: "var(--danger)" } : undefined}>{money(unapplied)}</div></div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button name="payload" value={payload("draft")} className="secondary" disabled={pending || !h.customerId || !h.bankAccountId}>Save as draft</button>
        <button name="payload" value={payload("submit")} className={requireApproval ? "" : "secondary"} disabled={pending || !ready}>Submit for approval</button>
        {canPost && !requireApproval && <button name="payload" value={payload("post")} disabled={pending || !ready}>Save and post</button>}
      </div>
      <p className="muted">The receipt number comes from your collection receipt series when it is approved. The deposit appears in bank reconciliation for matching.</p>
    </form>
  );
}
