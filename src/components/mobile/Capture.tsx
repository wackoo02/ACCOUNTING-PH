"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/lib/icons";
import type { VoucherOut } from "@/lib/pettycash/service";
import { ApiFail, api, fetchImage, peso, photoToBase64 } from "./api";
import { Burst, Chips, Errors, Field, Header, Spinner, Warnings, toast } from "./ui";
import type { Me, ModuleKey, Nav, Setup } from "./App";

const MOD: Record<ModuleKey, { icon: IconName; title: string; verb: string }> = {
  PETTY_CASH: { icon: "petty-cash", title: "Petty Cash", verb: "receipt" },
  TRAVEL: { icon: "travel", title: "Travel", verb: "travel receipt" },
  TRANSPORT: { icon: "transport", title: "Transport", verb: "ride receipt" },
  DELIVERY: { icon: "sent-package", title: "Sent Package", verb: "delivery receipt" },
};

type Line = { description: string; quantity: string; unitPrice: string; accountId: string; suggestedAccountId?: string | null };
type Form = {
  module: ModuleKey; paymentMethod: string; paymentAccountId: string; fundId: string; employeeId: string;
  transactionType: string; provider: string; bookingNumber: string; tripAt: string; purpose: string;
  details: Record<string, string>; amounts: Record<string, string>; receiptDate: string; docType: string; docNumber: string;
  vendorName: string; vendorTin: string; vendorAddress: string; vendorVatRegistered: boolean; vatAmount: string;
  tipAmount: string; tipHandwritten: boolean; currencyCode: string; fxRate: string; noReceipt: boolean; noReceiptReason: string;
  imageId: string | null; extraction: unknown; lines: Line[];
};
type Preview = { ok: boolean; errors: string[]; warnings: string[]; gross: string; vat: string; netOfVat: string; ewt: string; tip: string; totalPaid: string; vendorVatRegistered: boolean; foreignTotal: string | null; currencyCode: string };
type Extract = {
  imageId: string; extractionError?: string;
  receipt?: {
    isReceipt: boolean; docType: string; docNumber: string; date: string; vendor: { name: string; tin: string; address: string; vatRegistered: boolean };
    vatAmount: string; tip: string; tipHandwritten: boolean; currency: string; language: string; englishTranslation: string; confidence: string; notes: string;
    mobility: { provider: string; bookingNumber: string; tripDateTime: string; pickup: string; dropoff: string; distanceKm: string; passenger: string; sender: string; receiver: string; fare: string; tolls: string; parking: string; additionalCharges: string; packageType: string; weightKg: string };
  };
  items?: { description: string; quantity: string; unitPrice: string; amount: string; suggestedAccountId: string | null }[];
};

const today = () => new Date().toISOString().slice(0, 10);
const nz = (v?: string | null) => (v && Number(v) !== 0 ? v : "");

function blank(module: ModuleKey, setup: Setup): Form {
  const pay = module === "PETTY_CASH" ? "PETTY_CASH_FUND" : "EMPLOYEE";
  return {
    module, paymentMethod: pay, paymentAccountId: "", fundId: setup.funds[0]?.id ?? "", employeeId: setup.me?.id ?? "",
    transactionType: setup.transactionTypes.find((t) => t.module === module)?.key ?? "", provider: "", bookingNumber: "", tripAt: "", purpose: "",
    details: module === "TRAVEL" ? { travelType: "LOCAL" } : {}, amounts: {}, receiptDate: today(), docType: "OR", docNumber: "",
    vendorName: "", vendorTin: "", vendorAddress: "", vendorVatRegistered: true, vatAmount: "", tipAmount: "", tipHandwritten: false,
    currencyCode: "PHP", fxRate: "", noReceipt: false, noReceiptReason: "", imageId: null, extraction: undefined,
    lines: module === "PETTY_CASH" || module === "TRAVEL" ? [{ description: "", quantity: "1", unitPrice: "", accountId: "" }] : [],
  };
}

function fromVoucher(v: VoucherOut, setup: Setup): Form {
  const det = (v.details ?? {}) as Record<string, unknown>;
  const amounts = (det.amounts ?? {}) as Record<string, string>;
  const { amounts: _a, ...rest } = det;
  void _a;
  const hasAmounts = Object.keys(amounts).length > 0 && (v.module === "TRANSPORT" || v.module === "DELIVERY");
  return {
    ...blank(v.module as ModuleKey, setup), paymentMethod: v.paymentMethod, paymentAccountId: v.paymentAccount?.id ?? "", fundId: v.fund?.id ?? "",
    employeeId: v.employee?.id ?? "", transactionType: v.transactionType ?? "", provider: v.provider ?? "", bookingNumber: v.bookingNumber ?? "",
    tripAt: v.tripAt ? new Date(v.tripAt).toISOString().slice(0, 16) : "", purpose: v.purpose ?? "", details: Object.fromEntries(Object.entries(rest).map(([k, x]) => [k, String(x ?? "")])),
    amounts: hasAmounts ? amounts : {}, receiptDate: v.receiptDate, docType: v.docType, docNumber: v.docNumber ?? "",
    vendorName: v.vendor.name, vendorTin: v.vendor.tin ?? "", vendorAddress: v.vendor.address ?? "", vendorVatRegistered: v.vendor.vatRegistered,
    vatAmount: nz(v.vatAmount), tipAmount: nz(v.tipAmount), tipHandwritten: v.tipHandwritten, noReceipt: v.noReceipt, noReceiptReason: v.noReceiptReason ?? "",
    imageId: v.imageId, lines: hasAmounts ? [] : v.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, accountId: l.accountId })),
  };
}

export function Capture({ module, id, setup, me, nav }: { module: ModuleKey; id?: string; setup: Setup; me: Me; nav: Nav }) {
  const m = MOD[module];
  const [step, setStep] = useState<"start" | "reading" | "form" | "done">(id ? "form" : "start");
  const [f, setF] = useState<Form>(() => blank(module, setup));
  const [photo, setPhoto] = useState<string | null>(null);
  const [ai, setAi] = useState<Extract | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<VoucherOut | null>(null);
  const [loaded, setLoaded] = useState(!id);
  const file = useRef<HTMLInputElement>(null);
  const modDef = setup.modules.find((x) => x.key === module)!;

  useEffect(() => {
    if (!id) return;
    api<VoucherOut>("GET", `vouchers/${id}`).then(async (v) => {
      setF(fromVoucher(v, setup)); setLoaded(true);
      if (v.imageId) setPhoto(await fetchImage(v.imageId));
    }).catch((e) => setErrors(e instanceof ApiFail ? e.errors : ["Could not load the claim"]));
  }, [id, setup]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const body = useMemo(() => ({
    ...f, fundId: f.paymentMethod === "PETTY_CASH_FUND" ? f.fundId : null, paymentAccountId: f.paymentAccountId || null, employeeId: f.employeeId || null,
    transactionType: module === "PETTY_CASH" ? null : f.transactionType || null, provider: f.provider || null, tripAt: f.tripAt || null,
    vatAmount: f.vatAmount || null, tipAmount: f.tipAmount || null, fxRate: f.currencyCode !== "PHP" ? f.fxRate : null,
    amounts: f.lines.length ? null : f.amounts, lines: f.lines.filter((l) => l.description || l.unitPrice),
    vendorName: f.vendorName || null, docType: f.noReceipt ? "OTHER" : f.docType,
  }), [f, module]);

  // Live preview: totals, VAT / non-VAT and what is still missing.
  useEffect(() => {
    if (step !== "form" || !loaded) return;
    const h = setTimeout(() => { api<Preview>("POST", "vouchers/preview", body).then(setPreview).catch(() => {}); }, 450);
    return () => clearTimeout(h);
  }, [body, step, loaded]);

  const onPhoto = async (fl: File | undefined) => {
    if (!fl) return;
    setStep("reading"); setErrors([]);
    try {
      const p = await photoToBase64(fl);
      setPhoto(p.preview);
      const r = await api<Extract>("POST", "receipts", { imageBase64: p.base64, mediaType: p.mediaType, module });
      setAi(r);
      setF((x) => applyExtraction({ ...x, imageId: r.imageId, noReceipt: false }, r, module, setup));
      if (r.extractionError) toast(r.extractionError, "info");
      else toast("Receipt read. Check the details.", "ok");
    } catch (e) {
      setErrors(e instanceof ApiFail ? e.errors : ["Upload failed. Check your connection."]);
    }
    setStep("form");
  };

  const save = async (submit: boolean) => {
    setBusy(true); setErrors([]);
    try {
      let v: VoucherOut;
      if (id) {
        v = await api<VoucherOut>("PUT", `vouchers/${id}`, body);
        if (submit) v = await api<VoucherOut>("POST", `vouchers/${id}/submit`);
      } else v = await api<VoucherOut>("POST", `vouchers${submit ? "?submit=1" : ""}`, body);
      setDone(v); setStep("done");
    } catch (e) {
      setErrors(e instanceof ApiFail ? e.errors : ["Could not save. Try again."]);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally { setBusy(false); }
  };

  if (step === "done" && done) {
    return (
      <div className="vm-page">
        <Burst title={done.status === "SUBMITTED" ? "Sent for approval" : "Saved as draft"} sub={`${done.number} · ${peso(Number(done.grossAmount) + Number(done.tipAmount))}`}>
          <div className="vm-actions">
            <button className="vm-btn primary" onClick={() => { setF(blank(module, setup)); setPhoto(null); setAi(null); setPreview(null); setDone(null); setStep("start"); }}>Capture another</button>
            <button className="vm-btn ghost" onClick={() => nav.go({ name: "claim", id: done.id })}>View claim</button>
          </div>
        </Burst>
      </div>
    );
  }

  return (
    <div className="vm-page">
      <Header title={id ? "Fix and resubmit" : m.title} sub={modDef.blurb} icon={m.icon} onBack={nav.back} />
      <Errors errors={errors} />
      {step === "start" && (
        <div className="vm-start">
          <button className="vm-capture" onClick={() => file.current?.click()}>
            <span className="lens"><Icon name="camera" size={38} /></span>
            <b>Scan {m.verb}</b>
            <small>AI reads the supplier, TIN, items, VAT{module === "TRAVEL" ? " and translates to English" : module === "PETTY_CASH" ? "" : ", booking and trip details"}</small>
          </button>
          <button className="vm-btn ghost block" onClick={() => setStep("form")}>Enter manually</button>
          <button className="vm-btn ghost block" onClick={() => { setF((x) => ({ ...x, noReceipt: true, docType: "OTHER", vendorVatRegistered: false })); setStep("form"); }}>No receipt</button>
          <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
        </div>
      )}
      {step === "reading" && (
        <div className="vm-reading">
          {photo ? <div className="scan"><img src={photo} alt="Receipt" /><span className="laser" /></div> : <Spinner />}
          <div className="t">Reading your receipt…</div>
          <div className="dots"><i /><i /><i /></div>
        </div>
      )}
      {step === "form" && !loaded && <Spinner label="Loading" />}
      {step === "form" && loaded && (
        <form className="vm-form" onSubmit={(e) => { e.preventDefault(); save(true); }}>
          {photo && <div className="vm-thumb"><img src={photo} alt="Receipt" />{ai?.receipt && <span className={`conf ${ai.receipt.confidence}`}>AI · {ai.receipt.confidence}</span>}</div>}
          {ai?.receipt?.englishTranslation && <div className="vm-note"><b>English translation ({ai.receipt.language})</b><br />{ai.receipt.englishTranslation}</div>}
          {ai?.receipt?.notes && <div className="vm-note subtle">{ai.receipt.notes}</div>}

          {module !== "PETTY_CASH" && (
            <section className="vm-card">
              <div className="vm-section-t">{module === "TRAVEL" ? "Trip" : module === "TRANSPORT" ? "Ride" : "Delivery"}</div>
              {modDef.providers.length > 0 && <Field label="Provider"><Chips options={modDef.providers.map((p) => ({ value: p.key, label: p.name }))} value={f.provider} onChange={(v) => set("provider", v)} /></Field>}
              <Field label="Type"><Chips options={setup.transactionTypes.filter((t) => t.module === module).map((t) => ({ value: t.key, label: t.label }))} value={f.transactionType} onChange={(v) => {
                set("transactionType", v);
                if (v === "TRAVEL_INTERNATIONAL") setF((x) => ({ ...x, transactionType: v, details: { ...x.details, travelType: "INTERNATIONAL" } }));
                if (v === "TRAVEL_LOCAL") setF((x) => ({ ...x, transactionType: v, details: { ...x.details, travelType: "LOCAL" }, currencyCode: "PHP" }));
              }} /></Field>
              {module !== "TRAVEL" && <div className="two">
                <Field label={module === "DELIVERY" ? "Delivery / order no." : "Booking no."}><input value={f.bookingNumber} onChange={(e) => set("bookingNumber", e.target.value)} /></Field>
                <Field label="Date and time"><input type="datetime-local" value={f.tripAt} onChange={(e) => { set("tripAt", e.target.value); if (e.target.value) set("receiptDate", e.target.value.slice(0, 10)); }} /></Field>
              </div>}
              {modDef.detailFields.filter((d) => d.key !== "travelType").map((d) => (
                <Field key={d.key} label={d.label + (d.required ? "" : " (optional)")}>
                  {d.type === "select" ? (
                    <select value={f.details[d.key] ?? ""} onChange={(e) => set("details", { ...f.details, [d.key]: e.target.value })}><option value="">Choose…</option>{d.options!.map((o) => <option key={o}>{o}</option>)}</select>
                  ) : (
                    <input inputMode={d.type === "number" ? "decimal" : undefined} type={d.key.endsWith("Date") ? "date" : "text"} value={f.details[d.key] ?? ""} onChange={(e) => set("details", { ...f.details, [d.key]: e.target.value })} />
                  )}
                </Field>
              ))}
              <Field label="Business purpose"><textarea rows={2} value={f.purpose} onChange={(e) => set("purpose", e.target.value)} placeholder={module === "TRANSPORT" ? "e.g. Client meeting with ABC Corp" : module === "DELIVERY" ? "e.g. Documents to BIR RDO 47" : "e.g. Supplier visit, Tokyo"} /></Field>
            </section>
          )}

          <section className="vm-card">
            <div className="vm-section-t">Amount</div>
            {modDef.amountFields.length > 0 && f.lines.length === 0 ? (
              <div className="two">
                {modDef.amountFields.map((a) => <Field key={a.key} label={a.label}><input inputMode="decimal" className="num" value={f.amounts[a.key] ?? ""} onChange={(e) => set("amounts", { ...f.amounts, [a.key]: e.target.value })} placeholder="0.00" /></Field>)}
                <Field label="Tip"><input inputMode="decimal" className="num" value={f.tipAmount} onChange={(e) => set("tipAmount", e.target.value)} placeholder="0.00" /></Field>
              </div>
            ) : (
              <>
                {module === "TRAVEL" && (
                  <div className="two">
                    <Field label="Currency"><select value={f.currencyCode} onChange={(e) => { const c = e.target.value; const r = setup.currencies.find((x) => x.code === c)?.rate; setF((x) => ({ ...x, currencyCode: c, fxRate: c === "PHP" ? "" : x.fxRate || r || "" })); }}>
                      <option value="PHP">PHP</option>{setup.currencies.filter((c) => c.code !== "PHP").map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select></Field>
                    {f.currencyCode !== "PHP" && <Field label={`PHP per 1 ${f.currencyCode}`}><input inputMode="decimal" value={f.fxRate} onChange={(e) => set("fxRate", e.target.value)} /></Field>}
                  </div>
                )}
                {f.lines.map((l, i) => (
                  <div className="vm-line" key={i}>
                    <input className="d" placeholder="Item" value={l.description} onChange={(e) => set("lines", f.lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                    <input className="q" inputMode="decimal" value={l.quantity} onChange={(e) => set("lines", f.lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                    <input className="p num" inputMode="decimal" placeholder="Price" value={l.unitPrice} onChange={(e) => set("lines", f.lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))} />
                    {(module === "PETTY_CASH" || module === "TRAVEL") && (
                      <select className="a" value={l.accountId} onChange={(e) => set("lines", f.lines.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}>
                        <option value="">{module === "TRAVEL" ? "Mapped travel account" : "Expense account…"}</option>
                        {setup.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                      </select>
                    )}
                    {f.lines.length > 1 && <button type="button" className="x" onClick={() => set("lines", f.lines.filter((_, j) => j !== i))} aria-label="Remove">×</button>}
                  </div>
                ))}
                <button type="button" className="vm-btn ghost small" onClick={() => set("lines", [...f.lines, { description: "", quantity: "1", unitPrice: "", accountId: "" }])}>+ Add item</button>
                <div className="two">
                  <Field label="Tip / service charge"><input inputMode="decimal" className="num" value={f.tipAmount} onChange={(e) => set("tipAmount", e.target.value)} placeholder="0.00" /></Field>
                  {f.vendorVatRegistered && !f.noReceipt && f.currencyCode === "PHP" && <Field label="VAT as printed" hint="Blank = 12/112"><input inputMode="decimal" className="num" value={f.vatAmount} onChange={(e) => set("vatAmount", e.target.value)} /></Field>}
                </div>
                {module !== "PETTY_CASH" && modDef.amountFields.length > 0 && <button type="button" className="vm-link" onClick={() => set("lines", [])}>Enter fare / fees instead</button>}
              </>
            )}
            {modDef.amountFields.length > 0 && f.lines.length === 0 && <button type="button" className="vm-link" onClick={() => set("lines", [{ description: "", quantity: "1", unitPrice: "", accountId: "" }])}>Itemize instead</button>}
          </section>

          <section className="vm-card">
            <div className="vm-section-t">Paid by</div>
            <Chips options={setup.payments.filter((p) => module === "PETTY_CASH" ? ["PETTY_CASH_FUND", "EMPLOYEE"].includes(p.key) : true).filter((p) => p.key !== "COMPANY_ACCOUNT").map((p) => ({ value: p.key, label: p.label }))} value={f.paymentMethod} onChange={(v) => {
              const p = setup.payments.find((x) => x.key === v)!;
              setF((x) => ({ ...x, paymentMethod: v, paymentAccountId: p.accounts.length === 1 ? p.accounts[0].id : "" }));
            }} />
            {f.paymentMethod === "PETTY_CASH_FUND" && <Field label="Fund"><select value={f.fundId} onChange={(e) => set("fundId", e.target.value)}><option value="">Choose…</option>{setup.funds.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></Field>}
            {(setup.payments.find((p) => p.key === f.paymentMethod)?.accounts.length ?? 0) > 0 && (
              <Field label="Account used"><select value={f.paymentAccountId} onChange={(e) => set("paymentAccountId", e.target.value)}><option value="">Choose…</option>{setup.payments.find((p) => p.key === f.paymentMethod)!.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
            )}
            {["GCASH", "MAYA", "CREDIT_CARD", "DEBIT_CARD", "CORPORATE_WALLET"].includes(f.paymentMethod) && setup.payments.find((p) => p.key === f.paymentMethod)?.accounts.length === 0 && (
              <div className="vm-note subtle">No {setup.payments.find((p) => p.key === f.paymentMethod)?.label} account is set up yet. Ask finance to add it under Bank and Cash Accounts.</div>
            )}
            {f.paymentMethod === "EMPLOYEE" && <div className="vm-note subtle">You will be reimbursed after finance clears this claim.</div>}
            {(me.can.approve || me.can.finance) && (
              <Field label="Employee / partner"><select value={f.employeeId} onChange={(e) => set("employeeId", e.target.value)}><option value="">Me</option>{setup.employees.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</select></Field>
            )}
          </section>

          <section className="vm-card">
            <div className="vm-section-t">Receipt</div>
            {f.noReceipt ? (
              <>
                <div className="vm-note">No receipt: recorded as non-VAT. Finance may treat it as non-deductible.</div>
                <Field label="Why is there no receipt?"><input value={f.noReceiptReason} onChange={(e) => set("noReceiptReason", e.target.value)} placeholder="e.g. App did not issue an e-receipt" /></Field>
                <Field label="Paid to"><input value={f.vendorName} onChange={(e) => set("vendorName", e.target.value)} placeholder={module === "PETTY_CASH" ? "Store or person" : "Provider (optional)"} /></Field>
                <Field label="Date"><input type="date" value={f.receiptDate} onChange={(e) => set("receiptDate", e.target.value)} /></Field>
                <button type="button" className="vm-link" onClick={() => setF((x) => ({ ...x, noReceipt: false, docType: "OR" }))}>I have a receipt</button>
              </>
            ) : (
              <>
                <Field label={module === "PETTY_CASH" || module === "TRAVEL" ? "Supplier" : "Supplier (blank = provider)"}><input value={f.vendorName} onChange={(e) => set("vendorName", e.target.value)} /></Field>
                <div className="two">
                  <Field label="Supplier TIN" hint="No VAT TIN = non-VAT"><input value={f.vendorTin} onChange={(e) => set("vendorTin", e.target.value)} placeholder="000-000-000-000" /></Field>
                  <Field label="Date"><input type="date" value={f.receiptDate} onChange={(e) => set("receiptDate", e.target.value)} /></Field>
                </div>
                <div className="two">
                  <Field label="Document"><select value={f.docType} onChange={(e) => set("docType", e.target.value)}><option value="OR">Official receipt</option><option value="SI">Sales invoice</option><option value="CASH_INVOICE">Cash invoice</option><option value="AR">Acknowledgment</option><option value="OTHER">E-receipt / other</option></select></Field>
                  <Field label="Receipt no."><input value={f.docNumber} onChange={(e) => set("docNumber", e.target.value)} /></Field>
                </div>
                <label className="vm-switch"><input type="checkbox" checked={f.vendorVatRegistered} onChange={(e) => set("vendorVatRegistered", e.target.checked)} /><span />VAT-registered supplier</label>
                {!photo && <button type="button" className="vm-btn ghost small" onClick={() => file.current?.click()}><Icon name="camera" size={16} /> Attach photo</button>}
                <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
              </>
            )}
          </section>

          {preview && (
            <section className={`vm-total ${preview.ok ? "ok" : ""}`}>
              <div className="r"><span>Amount</span><b>{peso(preview.gross)}</b></div>
              {Number(preview.tip) > 0 && <div className="r"><span>Tip</span><b>{peso(preview.tip)}</b></div>}
              <div className="r"><span>{preview.vendorVatRegistered ? "Input VAT" : "VAT"}</span>{preview.vendorVatRegistered ? <b>{peso(preview.vat)}</b> : <span className="vm-pill grey">Non-VAT</span>}</div>
              {Number(preview.ewt) > 0 && <div className="r"><span>EWT withheld</span><b>-{peso(preview.ewt)}</b></div>}
              {preview.foreignTotal && <div className="r"><span>On receipt</span><b>{preview.currencyCode} {Number(preview.foreignTotal).toLocaleString()}</b></div>}
              <div className="r big"><span>Total</span><b>{peso(preview.totalPaid)}</b></div>
              <Warnings items={preview.warnings} />
              {!preview.ok && <div className="todo">{preview.errors.map((e, i) => <div key={i}>• {e}</div>)}</div>}
            </section>
          )}
          <div className="vm-sticky">
            <button type="button" className="vm-btn ghost" disabled={busy} onClick={() => save(false)}>Save draft</button>
            <button className="vm-btn primary" disabled={busy}>{busy ? "Sending…" : "Submit"}</button>
          </div>
        </form>
      )}
    </div>
  );
}

function applyExtraction(f: Form, r: Extract, module: ModuleKey, setup: Setup): Form {
  const x = r.receipt;
  if (!x) return f;
  const mob = x.mobility;
  const providers = setup.modules.find((m) => m.key === module)?.providers ?? [];
  const provider = mob?.provider && providers.some((p) => p.key === mob.provider.toUpperCase()) ? mob.provider.toUpperCase() : f.provider;
  const out: Form = {
    ...f, extraction: { receipt: x, items: r.items }, receiptDate: x.date || f.receiptDate, docType: x.docType || f.docType, docNumber: x.docNumber || f.docNumber,
    vendorName: x.vendor.name || f.vendorName, vendorTin: x.vendor.tin || "", vendorAddress: x.vendor.address || "", vendorVatRegistered: x.vendor.vatRegistered && !!x.vendor.tin,
    vatAmount: nz(x.vatAmount), tipAmount: nz(x.tip), tipHandwritten: x.tipHandwritten, provider,
  };
  if (module === "TRAVEL" && x.currency && x.currency !== "PHP") {
    out.currencyCode = x.currency;
    out.fxRate = setup.currencies.find((c) => c.code === x.currency)?.rate ?? "";
    out.transactionType = "TRAVEL_INTERNATIONAL";
    out.details = { ...out.details, travelType: "INTERNATIONAL" };
  }
  if ((module === "TRANSPORT" || module === "DELIVERY") && mob) {
    out.bookingNumber = mob.bookingNumber || f.bookingNumber;
    if (mob.tripDateTime) out.tripAt = mob.tripDateTime.slice(0, 16);
    const det: Record<string, string> = { ...f.details };
    for (const k of ["pickup", "dropoff", "distanceKm", "passenger", "sender", "receiver", "packageType", "weightKg"] as const) if (mob[k]) det[k] = mob[k];
    if (module === "DELIVERY") { if (mob.pickup) det.pickupAddress = mob.pickup; if (mob.dropoff) det.deliveryAddress = mob.dropoff; }
    out.details = det;
    const fare = Number(mob.fare) > 0;
    if (fare) {
      out.lines = [];
      out.amounts = module === "TRANSPORT" ? { fare: nz(mob.fare), tolls: nz(mob.tolls), parking: nz(mob.parking) } : { deliveryFee: nz(mob.fare), additionalCharges: nz(mob.additionalCharges) };
      return out;
    }
  }
  if (r.items?.length) out.lines = r.items.map((i) => ({ description: i.description, quantity: i.quantity || "1", unitPrice: i.unitPrice, accountId: module === "PETTY_CASH" ? i.suggestedAccountId ?? "" : "", suggestedAccountId: i.suggestedAccountId }));
  return out;
}
