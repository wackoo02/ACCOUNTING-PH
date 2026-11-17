"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { MasterLookup } from "@/components/MasterLookup";
import { idOpts } from "@/lib/lookup";
import { ApiFail, api, peso, photoToBase64 } from "./api";
import { Burst, Chips, Errors, Field, Header, toast } from "./ui";
import type { Nav, Setup } from "./App";

type Form = { invoiceNumber: string; date: string; terms: "CASH" | "CHARGE"; customerId: string; customerName: string; customerTin: string; vatableSales: string; vatAmount: string; vatExemptSales: string; zeroRatedSales: string; total: string; withholdingTax: string; isService: boolean; imageId: string | null; memo: string };
type Preview = { ok: boolean; errors: string[]; totals: { total: string; vat: string; net: string; cwt: string; receivable: string }; lines: { accountId: string; debit?: string; credit?: string; description: string }[] };
type Scan = { imageId: string; extractionError?: string; invoice?: { invoiceNumber: string; date: string; terms: "CASH" | "CHARGE"; customer: { name: string; tin: string }; vatableSales: string; vatAmount: string; vatExemptSales: string; zeroRatedSales: string; totalAmountDue: string; withholdingTax: string; items: { isService: boolean }[]; confidence: string }; customerMatch?: { id: string } | null };

const nz = (v?: string) => (v && Number(v) !== 0 ? v : "");

export function SalesScan({ setup, nav }: { setup: Setup | null; nav: Nav }) {
  const [f, setF] = useState<Form>({ invoiceNumber: "", date: new Date().toISOString().slice(0, 10), terms: "CHARGE", customerId: "", customerName: "", customerTin: "", vatableSales: "", vatAmount: "", vatExemptSales: "", zeroRatedSales: "", total: "", withholdingTax: "", isService: false, imageId: null, memo: "" });
  const [photo, setPhoto] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const customerOpts = useMemo(() => idOpts(setup?.customers ?? []), [setup?.customers]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState<{ journal: { number: string }; totals: { total: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const body = { ...f, customerId: f.customerId || null };

  useEffect(() => {
    if (!f.total) { setPreview(null); return; }
    const h = setTimeout(() => api<Preview>("POST", "sales-invoices/preview", body).then(setPreview).catch(() => {}), 450);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(f)]);

  const onPhoto = async (fl?: File) => {
    if (!fl) return;
    setReading(true); setErrors([]);
    try {
      const p = await photoToBase64(fl);
      setPhoto(p.preview);
      const r = await api<Scan>("POST", "sales-invoices/scan", { imageBase64: p.base64, mediaType: p.mediaType });
      const i = r.invoice;
      setF((x) => i ? {
        ...x, imageId: r.imageId, invoiceNumber: i.invoiceNumber, date: i.date || x.date, terms: i.terms, customerId: r.customerMatch?.id ?? "", customerName: i.customer.name, customerTin: i.customer.tin,
        vatableSales: nz(i.vatableSales), vatAmount: nz(i.vatAmount), vatExemptSales: nz(i.vatExemptSales), zeroRatedSales: nz(i.zeroRatedSales), total: nz(i.totalAmountDue), withholdingTax: nz(i.withholdingTax),
        isService: i.items.length > 0 && i.items.every((it) => it.isService),
      } : { ...x, imageId: r.imageId });
      toast(r.extractionError ?? "Invoice read. Check the details.", r.extractionError ? "info" : "ok");
    } catch (e) { setErrors(e instanceof ApiFail ? e.errors : ["Upload failed"]); }
    setReading(false);
  };

  const submit = async () => {
    setBusy(true); setErrors([]);
    try { setDone(await api("POST", "sales-invoices", body)); } catch (e) { setErrors(e instanceof ApiFail ? e.errors : ["Failed"]); } finally { setBusy(false); }
  };

  if (done) return <div className="vm-page"><Burst title="Sent to the books" sub={`${done.journal.number} · ${peso(done.totals.total)} · waiting for accountant approval`}><div className="vm-actions"><button className="vm-btn primary" onClick={() => { setDone(null); setPhoto(null); setF({ ...f, invoiceNumber: "", total: "", vatableSales: "", vatAmount: "", withholdingTax: "", imageId: null }); }}>Scan another</button><button className="vm-btn ghost" onClick={nav.back}>Done</button></div></Burst></div>;

  return (
    <div className="vm-page">
      <Header title="Sales Invoice" sub="Scan an issued invoice and post the sale" icon="receipt" onBack={nav.back} />
      <Errors errors={errors} />
      {!photo && !reading && (
        <button className="vm-capture" onClick={() => file.current?.click()}><span className="lens"><Icon name="camera" size={38} /></span><b>Scan sales invoice</b><small>AI reads the invoice no., customer, VAT and total</small></button>
      )}
      <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
      {reading && <div className="vm-reading">{photo && <div className="scan"><img src={photo} alt="Invoice" /><span className="laser" /></div>}<div className="t">Reading the invoice…</div><div className="dots"><i /><i /><i /></div></div>}
      {!reading && (
        <div className="vm-form">
          {photo && <div className="vm-thumb"><img src={photo} alt="Invoice" /></div>}
          <section className="vm-card">
            <div className="two">
              <Field label="Invoice no."><input value={f.invoiceNumber} onChange={(e) => set("invoiceNumber", e.target.value)} /></Field>
              <Field label="Date"><input type="date" value={f.date} onChange={(e) => set("date", e.target.value)} /></Field>
            </div>
            <Field label="Terms"><Chips options={[{ value: "CHARGE", label: "Charge (on account)" }, { value: "CASH", label: "Cash sale" }]} value={f.terms} onChange={(v) => set("terms", v)} /></Field>
            <Field label="Customer"><MasterLookup ariaLabel="Customer" placeholder={f.customerName ? `${f.customerName} (not in list)` : "Walk-in / type to search…"} emptyLabel={f.customerName ? `${f.customerName} (not in list)` : "Walk-in"}
              value={f.customerId} options={customerOpts} onChange={(v) => set("customerId", v)} /></Field>
            <label className="vm-switch"><input type="checkbox" checked={f.isService} onChange={(e) => set("isService", e.target.checked)} /><span />Services (service income)</label>
          </section>
          <section className="vm-card">
            <div className="two">
              <Field label="VATable sales"><input inputMode="decimal" className="num" value={f.vatableSales} onChange={(e) => set("vatableSales", e.target.value)} /></Field>
              <Field label="VAT" hint="Blank = 12%"><input inputMode="decimal" className="num" value={f.vatAmount} onChange={(e) => set("vatAmount", e.target.value)} /></Field>
              <Field label="VAT-exempt"><input inputMode="decimal" className="num" value={f.vatExemptSales} onChange={(e) => set("vatExemptSales", e.target.value)} /></Field>
              <Field label="Zero-rated"><input inputMode="decimal" className="num" value={f.zeroRatedSales} onChange={(e) => set("zeroRatedSales", e.target.value)} /></Field>
              <Field label="Total amount due"><input inputMode="decimal" className="num" value={f.total} onChange={(e) => set("total", e.target.value)} /></Field>
              <Field label="CWT (BIR 2307)"><input inputMode="decimal" className="num" value={f.withholdingTax} onChange={(e) => set("withholdingTax", e.target.value)} /></Field>
            </div>
          </section>
          {preview && (
            <section className={`vm-total ${preview.ok ? "ok" : ""}`}>
              <div className="r"><span>Net sales</span><b>{peso(preview.totals.net)}</b></div>
              <div className="r"><span>Output VAT</span><b>{peso(preview.totals.vat)}</b></div>
              {Number(preview.totals.cwt) > 0 && <div className="r"><span>CWT</span><b>{peso(preview.totals.cwt)}</b></div>}
              <div className="r big"><span>{f.terms === "CHARGE" ? "Receivable" : "Cash"}</span><b>{peso(preview.totals.receivable)}</b></div>
              {!preview.ok && <div className="todo">{preview.errors.map((e, i) => <div key={i}>• {e}</div>)}</div>}
            </section>
          )}
          <div className="vm-sticky"><button className="vm-btn primary block" disabled={busy || !preview?.ok} onClick={submit}>{busy ? "Sending…" : "Send to books for approval"}</button></div>
        </div>
      )}
    </div>
  );
}
