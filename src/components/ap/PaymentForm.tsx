"use client";
import { useActionState, useState } from "react";
import { savePaymentAction } from "@/app/(app)/ap-actions";
import { Errors } from "../Errors";
import { MasterLookup } from "../MasterLookup";
import { idOpts } from "@/lib/lookup";

export type OpenBill = { id: string; number: string; vendorId: string; invoiceNo: string; dueDate: string; currency: string; open: string; total: string; ewt: string; onHold: boolean };
type Bank = { id: string; code: string; name: string; kind: string; currencyCode: string; nextCheckNo: number | null };
export type PayInitial = { id?: string; vendorId: string; bankAccountId: string; date: string; method: string; checkNo: string; checkDate: string; reference: string; memo: string; fxRate: string; amounts: Record<string, string> };

const num = (v: string) => { const n = Number(String(v).replace(/,/g, "")); return Number.isFinite(n) ? n : 0; };
const money = (n: number) => n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function PaymentForm({ vendors, banks, bills, initial, baseCurrency, rates }: { vendors: { id: string; name: string; code: string }[]; banks: Bank[]; bills: OpenBill[]; initial: PayInitial; baseCurrency: string; rates: Record<string, string> }) {
  const [state, run, pending] = useActionState(savePaymentAction, undefined);
  const [h, setH] = useState(initial);
  const bank = banks.find((b) => b.id === h.bankAccountId);
  const mine = bills.filter((b) => b.vendorId === h.vendorId);
  const total = Object.entries(h.amounts).filter(([id]) => mine.some((b) => b.id === id)).reduce((s, [, v]) => s + num(v), 0);
  const check = bank && (bank.kind === "CURRENT" || bank.kind === "SAVINGS");
  const body = (intent: string) => JSON.stringify({ ...h, intent, lines: mine.filter((b) => num(h.amounts[b.id] ?? "") > 0).map((b) => ({ billId: b.id, amount: h.amounts[b.id] })) });
  return (
    <form action={run}>
      <Errors errors={state?.errors} />
      <div className="card"><div className="row">
        <div style={{ flex: 2 }}><label>Supplier</label><MasterLookup ariaLabel="Supplier" required value={h.vendorId} options={idOpts(vendors)} add={{ kind: "vendors", noun: "supplier" }} onChange={(v) => setH({ ...h, vendorId: v, amounts: {} })} /></div>
        <div style={{ flex: 2 }}><label>Pay from</label><MasterLookup ariaLabel="Pay from" required value={h.bankAccountId} options={idOpts(banks, (b) => (b.currencyCode !== baseCurrency ? b.currencyCode : undefined))} add={{ kind: "banks" }}
          onChange={(v) => { const b = banks.find((x) => x.id === v); setH({ ...h, bankAccountId: v, method: b && b.kind !== "CURRENT" && b.kind !== "SAVINGS" ? "CASH" : h.method, fxRate: b && b.currencyCode !== baseCurrency ? rates[b.currencyCode] ?? "" : "1" }); }} /></div>
        <div><label>Payment date</label><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} required /></div>
        <div><label>Method</label><select value={h.method} onChange={(e) => setH({ ...h, method: e.target.value })}>{check && <option value="CHECK">Check</option>}<option value="BANK_TRANSFER">Bank transfer / InstaPay / PESONet</option><option value="ONLINE">Online / card</option><option value="EWALLET">GCash / Maya</option><option value="CASH">Cash</option></select></div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {h.method === "CHECK" && <div><label>Check no.</label><input value={h.checkNo} onChange={(e) => setH({ ...h, checkNo: e.target.value })} placeholder={bank?.nextCheckNo ? `blank = ${String(bank.nextCheckNo).padStart(6, "0")} on release` : ""} /></div>}
        {h.method === "CHECK" && <div><label>Check date</label><input type="date" value={h.checkDate} onChange={(e) => setH({ ...h, checkDate: e.target.value })} /></div>}
        {bank && bank.currencyCode !== baseCurrency && <div><label>Rate today (1 {bank.currencyCode} = ? {baseCurrency})</label><input className="num" value={h.fxRate} onChange={(e) => setH({ ...h, fxRate: e.target.value })} /></div>}
        <div><label>Reference</label><input value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} /></div>
        <div style={{ flex: 2 }}><label>Particulars (blank = invoice numbers)</label><input value={h.memo} onChange={(e) => setH({ ...h, memo: e.target.value })} /></div>
      </div></div>
      <div className="table-wrap"><table>
        <thead><tr><th>Bill</th><th>Invoice no.</th><th>Due</th><th className="num">Total</th><th className="num">EWT withheld</th><th className="num">Unpaid</th><th className="num" style={{ width: 160 }}>Pay now</th></tr></thead>
        <tbody>
          {mine.map((b) => <tr key={b.id}><td>{b.number}{b.onHold && <span className="badge DRAFT"> HOLD</span>}</td><td>{b.invoiceNo}</td><td>{b.dueDate}</td><td className="num">{b.currency} {money(num(b.total))}</td><td className="num">{money(num(b.ewt))}</td><td className="num">{money(num(b.open))}</td>
            <td><div className="row" style={{ gap: 4, flexWrap: "nowrap" }}><input className="num" value={h.amounts[b.id] ?? ""} onChange={(e) => setH({ ...h, amounts: { ...h.amounts, [b.id]: e.target.value } })} disabled={b.onHold} aria-label={`Pay ${b.number}`} />
              <button type="button" className="link" onClick={() => setH({ ...h, amounts: { ...h.amounts, [b.id]: h.amounts[b.id] ? "" : b.open } })} disabled={b.onHold}>{h.amounts[b.id] ? "clear" : "full"}</button></div></td></tr>)}
          {h.vendorId && !mine.length && <tr><td colSpan={7} className="muted">No approved unpaid bills for this supplier.</td></tr>}
          <tr className="total"><td colSpan={6} className="num">Amount of the check / transfer</td><td className="num">{money(total)}</td></tr>
        </tbody>
      </table></div>
      <p className="muted">Withholding tax was already deducted on each bill, so the amount paid is the net payable. The BIR Form 2307 for this payment can be printed from the voucher.</p>
      <div className="row" style={{ gap: 8 }}>
        <button name="payload" value={body("draft")} className="secondary" disabled={pending}>Save draft</button>
        <button name="payload" value={body("submit")} disabled={pending || total <= 0}>Save and submit for approval</button>
      </div>
    </form>
  );
}
