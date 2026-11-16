"use client";
import { Fragment, useActionState, useMemo, useState } from "react";
import { saveCash } from "@/app/(app)/bank-actions";
import type { CashFormData } from "@/lib/bank/form-data";
import { Errors } from "./Errors";
import { MasterLookup, type AddTarget, type LookupOption, type SavedRecord } from "./MasterLookup";
import { DIMENSIONS } from "@/lib/ledger/dimensions";
import type { MasterKind } from "@/lib/masters/config";

export type CashMode = "RECEIPT" | "DISBURSEMENT" | "PETTY" | "TRANSFER";
type Line = { accountId: string; amount: string; description: string; dims: Record<string, string> };
export type CashInitial = {
  id?: string; bankAccountId: string; toBankAccountId: string; date: string; payee: string; party: string; method: string; checkNo: string; checkDate: string;
  reference: string; memo: string; fxRate: string; amount: string; toAmount: string; toFxRate: string; withholdingTaxCodeId: string; withholdingAmount: string; lines: Line[];
};

const blank = (): Line => ({ accountId: "", amount: "", description: "", dims: {} });
const cents = (s: string) => { const n = Number(String(s).replace(/,/g, "")); return Number.isFinite(n) ? Math.round(n * 100) : 0; };
const money = (c: number) => (c / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
const PARTY_KIND: Record<string, MasterKind> = { CUSTOMER: "customers", VENDOR: "vendors", EMPLOYEE: "employees", PARTNER: "employees" };
const dimAdd = (key: string) => {
  const type = DIMENSIONS.find((d) => d.key === key)?.type;
  return type ? { kind: "dimensions" as const, type, prefill: { type } } : undefined;
};
const METHOD_LABELS: Record<string, string> = { CASH: "Cash", CHECK: "Check", BANK_TRANSFER: "Bank transfer / InstaPay / PESONet", ONLINE: "Online / card", EWALLET: "GCash / Maya" };

export function CashForm(props: CashFormData & { mode: CashMode; initial: CashInitial; canPost: boolean }) {
  const { mode, banks, accounts, dims, taxCodes, parties, currencies, baseCurrency, initial, canPost, requireApproval } = props;
  const [state, action, pending] = useActionState(saveCash, undefined);
  const [h, setH] = useState(initial);
  const [lines, setLines] = useState<Line[]>(initial.lines.length ? initial.lines : [blank()]);
  const [showDims, setShowDims] = useState(initial.lines.some((l) => Object.values(l.dims).some(Boolean)));
  const type = mode === "PETTY" ? "DISBURSEMENT" : mode;
  const receipt = mode === "RECEIPT";
  const transfer = mode === "TRANSFER";
  const fromBanks = banks.filter((b) => (mode === "PETTY" ? b.kind === "PETTY_CASH" : mode === "DISBURSEMENT" ? b.kind !== "PETTY_CASH" : true));
  const bank = banks.find((b) => b.id === h.bankAccountId);
  const to = banks.find((b) => b.id === h.toBankAccountId);
  const foreign = !!bank && bank.currencyCode !== baseCurrency;
  const toForeign = !!to && to.currencyCode !== baseCurrency && to.currencyCode !== bank?.currencyCode;
  const ccy = bank?.currencyCode ?? baseCurrency;
  const isCheckable = bank && (bank.kind === "CURRENT" || bank.kind === "SAVINGS");
  const tc = taxCodes.find((t) => t.id === h.withholdingTaxCodeId);

  const gross = useMemo(() => lines.reduce((s, l) => s + cents(l.amount), 0), [lines]);
  const wht = tc ? (h.withholdingAmount.trim() ? cents(h.withholdingAmount) : Math.round((gross * Number(tc.rate)) / 100)) : 0;
  const net = gross - wht;

  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const setDim = (i: number, k: string, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, dims: { ...l.dims, [k]: v } } : l)));
  const rateFor = (code?: string) => currencies.find((c) => c.code === code)?.rate ?? "";
  const pickBank = (id: string) => {
    const b = banks.find((x) => x.id === id);
    setH({ ...h, bankAccountId: id, fxRate: b && b.currencyCode !== baseCurrency ? rateFor(b.currencyCode) : "1", method: mode === "PETTY" || (b && !["CURRENT", "SAVINGS"].includes(b.kind)) ? "CASH" : h.method });
  };
  const payload = (intent: "draft" | "submit" | "post") => JSON.stringify({
    ...h, id: initial.id, type, intent, fxRate: foreign ? h.fxRate : "1",
    withholdingAmount: tc ? h.withholdingAmount : "", withholdingTaxCodeId: tc ? tc.id : "",
    lines: transfer ? [] : lines.map((l) => ({ ...l, dims: Object.fromEntries(Object.entries(l.dims).map(([k, v]) => [k, v || null])) })),
    toFxRate: toForeign ? h.toFxRate : to && to.currencyCode !== baseCurrency ? h.fxRate : "1",
  });
  const bankOpt = (b: (typeof banks)[number]): LookupOption => ({ value: b.id, code: b.code, label: b.name, hint: b.currencyCode !== baseCurrency ? b.currencyCode : undefined });
  const accountOptions: LookupOption[] = TYPES.flatMap((t) => accounts.filter((a) => a.type === t && (!a.currencyCode || a.currencyCode === ccy)).map((a) => ({ value: a.id, code: a.code, label: a.name, group: t })));
  const partyOptions: LookupOption[] = parties.map((p) => {
    const [prefix, code] = p.value.split(":");
    const kind = PARTY_KIND[prefix];
    return { value: p.value, code, label: p.name, hint: prefix.charAt(0) + prefix.slice(1).toLowerCase(), kind };
  });
  const partyAdd: AddTarget[] = (receipt ? ["customers", "employees", "vendors"] : ["vendors", "employees", "customers"]).map((k) => ({
    kind: k as MasterKind, toValue: (r: SavedRecord) => `${k === "employees" ? (r.isPartner ? "PARTNER" : "EMPLOYEE") : k === "vendors" ? "VENDOR" : "CUSTOMER"}:${r.code}`,
  }));
  const ready = transfer ? cents(h.amount) > 0 && !!h.toBankAccountId : net > 0 && lines.every((l) => l.accountId && cents(l.amount) > 0);

  return (
    <form action={action}>
      <Errors errors={state?.errors} />
      <div className="card">
        <div className="row">
          <div><label>{receipt ? "Deposit to" : transfer ? "Transfer from" : mode === "PETTY" ? "Petty cash fund" : "Pay from"}</label>
            <MasterLookup ariaLabel="Bank or cash account" required value={h.bankAccountId} options={fromBanks.map(bankOpt)} add={{ kind: "banks" }} onChange={(v) => pickBank(v)} /></div>
          {transfer && <div><label>Transfer to</label>
            <MasterLookup ariaLabel="Transfer to" required value={h.toBankAccountId} options={banks.filter((b) => b.id !== h.bankAccountId).map(bankOpt)} add={{ kind: "banks" }}
              onChange={(v) => { const b = banks.find((x) => x.id === v); setH({ ...h, toBankAccountId: v, toFxRate: b && b.currencyCode !== baseCurrency ? rateFor(b.currencyCode) : "1" }); }} /></div>}
          <div><label>Date</label><input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} required /></div>
          {mode !== "PETTY" && (
            <div><label>{receipt ? "Received as" : "Payment method"}</label>
              <select value={h.method} onChange={(e) => setH({ ...h, method: e.target.value })}>
                {Object.entries(METHOD_LABELS).filter(([k]) => k !== "CHECK" || receipt || isCheckable || !bank).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
          )}
          {h.method === "CHECK" && <div><label>{receipt ? "Customer's check no." : "Check no."}</label>
            <input value={h.checkNo} onChange={(e) => setH({ ...h, checkNo: e.target.value })} placeholder={!receipt && bank?.nextCheckNo ? `Leave blank for ${String(bank.nextCheckNo).padStart(6, "0")}` : ""} /></div>}
          {h.method === "CHECK" && <div><label>Check date</label><input type="date" value={h.checkDate} onChange={(e) => setH({ ...h, checkDate: e.target.value })} /></div>}
          {foreign && <div><label>Rate (1 {ccy} = ? {baseCurrency})</label><input className="num" value={h.fxRate} onChange={(e) => setH({ ...h, fxRate: e.target.value })} /></div>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {!transfer && <div style={{ flex: 2 }}><label>{receipt ? "Received from (customer, employee, other)" : "Payee"}</label>
            <MasterLookup ariaLabel="Party" emptyLabel="— Not in master lists" value={h.party} options={partyOptions} add={partyAdd}
              onChange={(v, rec) => { const p = parties.find((x) => x.value === v); setH({ ...h, party: v, payee: p ? p.name : rec ? rec.label : h.payee }); }} /></div>}
          {!transfer && <div style={{ flex: 2 }}><label>Name as printed {receipt ? "on the receipt" : "on the check / voucher"}</label><input value={h.payee} onChange={(e) => setH({ ...h, payee: e.target.value })} /></div>}
          <div><label>Reference (OR, SI, invoice, transfer ref.)</label><input value={h.reference} onChange={(e) => setH({ ...h, reference: e.target.value })} /></div>
        </div>
        <div style={{ marginTop: 10 }}><label>Particulars / purpose</label>
          <input value={h.memo} onChange={(e) => setH({ ...h, memo: e.target.value })} required placeholder={receipt ? "e.g. Collection of SI 0012" : transfer ? "e.g. Fund payroll account" : "e.g. Payment of November office rent"} /></div>
      </div>

      {transfer ? (
        <div className="card row">
          <div><label>Amount sent ({ccy})</label><input className="num" inputMode="decimal" value={h.amount} onChange={(e) => setH({ ...h, amount: e.target.value })} /></div>
          {to && to.currencyCode !== ccy && <>
            <div><label>Amount received ({to.currencyCode})</label><input className="num" inputMode="decimal" value={h.toAmount} onChange={(e) => setH({ ...h, toAmount: e.target.value })} /></div>
            {toForeign && <div><label>Rate (1 {to.currencyCode} = ? {baseCurrency})</label><input className="num" value={h.toFxRate} onChange={(e) => setH({ ...h, toFxRate: e.target.value })} /></div>}
          </>}
          {to && to.currencyCode !== ccy && <p className="muted" style={{ flexBasis: "100%" }}>Any peso difference between the amount sent and received is posted as a realized foreign exchange gain or loss.</p>}
        </div>
      ) : (
        <>
          <div className="table-wrap"><table>
            <thead><tr><th style={{ width: "38%" }}>{receipt ? "Credit account (what the money is for)" : "Debit account (what was paid)"}</th><th>Line description</th><th className="num" style={{ width: 150 }}>Amount ({ccy})</th><th style={{ width: 40 }} /></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <Fragment key={i}>
                  <tr>
                    <td><MasterLookup ariaLabel={`Account line ${i + 1}`} placeholder="Type account code or name…" value={l.accountId} options={accountOptions} add={{ kind: "accounts" }} onChange={(v) => set(i, { accountId: v })} /></td>
                    <td><input value={l.description} onChange={(e) => set(i, { description: e.target.value })} /></td>
                    <td><input className="num" inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} aria-label={`Amount line ${i + 1}`} /></td>
                    <td>{lines.length > 1 && <button type="button" className="link" style={{ color: "var(--danger)" }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">✕</button>}</td>
                  </tr>
                  {showDims && (
                    <tr><td colSpan={4} style={{ background: "#fafbfc" }}><div className="row" style={{ gap: 6 }}>
                      {dims.map((d) => <div key={d.key} style={{ minWidth: 130 }}><label>{d.label}</label>
                        <MasterLookup ariaLabel={`${d.label} line ${i + 1}`} placeholder="—" emptyLabel="— None" value={l.dims[d.key] ?? ""} options={d.values.map((v) => ({ value: v.id, code: v.code, label: v.name }))} add={dimAdd(d.key)} onChange={(v) => setDim(i, d.key, v)} /></div>)}
                    </div></td></tr>
                  )}
                </Fragment>
              ))}
              <tr>
                <td colSpan={2}>
                  <button type="button" className="secondary" onClick={() => setLines((ls) => [...ls, blank()])}>+ Add line</button>{" "}
                  {dims.length > 0 && <button type="button" className="secondary" onClick={() => setShowDims(!showDims)}>{showDims ? "Hide" : "Show"} dimensions</button>}
                </td>
                <td className="num"><strong>{money(gross)}</strong></td><td />
              </tr>
            </tbody>
          </table></div>
          <div className="card row">
            <div style={{ flex: 2 }}><label>{receipt ? "Tax withheld by the customer (BIR 2307 received)" : "Expanded withholding tax to deduct"}</label>
              <MasterLookup ariaLabel="Withholding tax" emptyLabel="None" placeholder="None" value={h.withholdingTaxCodeId}
                options={taxCodes.map((t) => ({ value: t.id, code: t.code, label: t.name, hint: `${t.rate}%` }))} add={{ kind: "taxes" }}
                onChange={(v) => setH({ ...h, withholdingTaxCodeId: v, withholdingAmount: "" })} /></div>
            {tc && <div><label>Tax amount (blank = {tc.rate}% of {money(gross)})</label><input className="num" inputMode="decimal" value={h.withholdingAmount} placeholder={money(wht)} onChange={(e) => setH({ ...h, withholdingAmount: e.target.value })} /></div>}
            <div className="stat"><div className="l">Total</div><div className="n">{money(gross)}</div></div>
            {tc && <div className="stat"><div className="l">Less withholding</div><div className="n">({money(wht)})</div></div>}
            <div className="stat"><div className="l">{receipt ? "Net cash received" : "Net cash paid"}</div><div className="n">{ccy} {money(net)}</div></div>
          </div>
          {tc && <p className="muted">Withholding is usually computed on the amount before VAT. If a line includes VAT, type the tax amount.</p>}
        </>
      )}

      <div className="row" style={{ gap: 8 }}>
        <button name="payload" value={payload("draft")} className="secondary" disabled={pending}>Save as draft</button>
        <button name="payload" value={payload("submit")} className={requireApproval ? "" : "secondary"} disabled={pending || !ready}>Submit for approval</button>
        {canPost && !requireApproval && <button name="payload" value={payload("post")} disabled={pending || !ready}>Save and post</button>}
      </div>
    </form>
  );
}
