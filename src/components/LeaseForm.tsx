"use client";
import { useState } from "react";
import { ActionForm } from "./ActionForm";
import { saveLeaseAction } from "@/app/(app)/lease-actions";
import type { LeaseFormData } from "@/lib/leases/form-data";

export type LeaseFormValues = Record<string, string | boolean | null | undefined> & { dims?: Record<string, string | null> };

const TYPES: [string, string][] = [["PROPERTY", "Office / store / warehouse space"], ["LAND", "Land"], ["VEHICLE", "Vehicle"], ["EQUIPMENT", "Machinery and equipment"], ["IT_EQUIPMENT", "IT and office equipment"], ["OTHER", "Other"]];

export function LeaseForm({ data, initial }: { data: LeaseFormData; initial: LeaseFormValues }) {
  const v = (k: string) => (initial[k] ?? "") as string;
  const [exemption, setExemption] = useState(v("exemption") || "NONE");
  const [currency, setCurrency] = useState(v("currencyCode") || data.baseCurrency);
  const [owns, setOwns] = useState(!!initial.transfersOwnership);
  const [vendor, setVendor] = useState(v("lessorVendorCode"));
  const exempt = exemption !== "NONE";
  const acct = (name: string, label: string, opts: { optional?: boolean; hint?: string; types?: string[] } = {}) => (
    <div>
      <label>{label}</label>
      <select name={name} defaultValue={initial[name] !== undefined && initial[name] !== null ? v(name) : (data.defaults[name] ?? "")}>
        {opts.optional && <option value="">(none)</option>}
        {data.accounts.filter((a) => !opts.types || opts.types.includes(a.type)).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
      </select>
      {opts.hint && <div className="muted">{opts.hint}</div>}
    </div>
  );
  return (
    <ActionForm action={saveLeaseAction}>
      {initial.id && <input type="hidden" name="id" value={String(initial.id)} />}
      <h2>Lease details</h2>
      <div className="card grid">
        <div><label>Lease number</label><input name="number" defaultValue={v("number")} placeholder="Blank = automatic (LSE-YYYY-000001)" /></div>
        <div><label>Lessor (from vendor list)</label>
          <select name="lessorVendorCode" value={vendor} onChange={(e) => setVendor(e.target.value)}>
            <option value="">(not in the vendor list)</option>
            {data.vendors.map((x) => <option key={x.code} value={x.code}>{x.name} ({x.code})</option>)}
          </select>
          <div className="muted">Pick the vendor so payables show in its aging and BIR 2307.</div>
        </div>
        <div><label>Lessor name</label><input name="lessorName" defaultValue={v("lessorName")} placeholder={vendor ? "Blank = vendor name" : "Lessor's registered name"} /></div>
        <div><label>Lease type</label><select name="leaseType" defaultValue={v("leaseType") || "PROPERTY"}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div style={{ gridColumn: "span 2" }}><label>Asset description</label><input name="assetDescription" defaultValue={v("assetDescription")} placeholder="e.g. Makati office, 12th floor, 250 sqm" required /></div>
        <div><label>Location</label><input name="location" defaultValue={v("location")} /></div>
        <div><label>Exemption (PFRS 16.5)</label>
          <select name="exemption" value={exemption} onChange={(e) => setExemption(e.target.value)}>
            <option value="NONE">None: on the balance sheet</option><option value="SHORT_TERM">Short-term (12 months or less)</option><option value="LOW_VALUE">Low-value asset</option>
          </select>
          {exempt && <div className="muted">Rent is expensed straight line; no ROU asset or lease liability.</div>}
        </div>
      </div>

      <h2>Term and payments</h2>
      <div className="card grid">
        <div><label>Lease start (commencement) date</label><input type="date" name="commencementDate" defaultValue={v("commencementDate")} required /></div>
        <div><label>Lease end date (last day)</label><input type="date" name="endDate" defaultValue={v("endDate")} required /></div>
        <div><label>Payment per period ({currency}, excluding VAT)</label><input name="paymentAmount" defaultValue={v("paymentAmount")} inputMode="decimal" required /></div>
        <div><label>Payment frequency</label><select name="paymentFrequency" defaultValue={v("paymentFrequency") || "MONTHLY"}><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="SEMI_ANNUAL">Semi-annual</option><option value="ANNUAL">Annual</option></select></div>
        <div><label>Paid</label><select name="paymentTiming" defaultValue={v("paymentTiming") || "ADVANCE"}><option value="ADVANCE">In advance (start of each period)</option><option value="ARREARS">In arrears (end of each period)</option></select></div>
        <div><label>Escalation %</label><input name="escalationPct" defaultValue={v("escalationPct") || "0"} inputMode="decimal" /><div className="muted">e.g. 5 = rent goes up 5% each interval</div></div>
        <div><label>Escalation every (months)</label><input name="escalationEveryMonths" defaultValue={v("escalationEveryMonths") || "12"} inputMode="numeric" /></div>
        <div><label>Currency</label>
          <select name="currencyCode" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value={data.baseCurrency}>{data.baseCurrency}</option>
            {data.currencies.filter((c) => c.code !== data.baseCurrency).map((c) => <option key={c.code}>{c.code}</option>)}
          </select>
        </div>
        {currency !== data.baseCurrency && <div><label>Rate at start date</label><input name="fxRate" defaultValue={v("fxRate") || data.currencies.find((c) => c.code === currency)?.rate} /></div>}
        <div><label>&nbsp;</label><label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--ink)" }}><input type="checkbox" name="vatable" defaultChecked={!!initial.vatable} style={{ width: "auto" }} /> 12% VAT on payments</label></div>
        <div><label>Expanded withholding tax</label>
          <select name="ewtTaxCodeId" defaultValue={v("ewtTaxCodeId")}><option value="">(none)</option>{data.taxCodes.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name} ({t.rate}%)</option>)}</select>
          <div className="muted">Rent of real or personal property is usually 5%.</div>
        </div>
      </div>

      {!exempt && <>
        <h2>Measurement</h2>
        <div className="card grid">
          <div><label>Incremental borrowing rate (annual %)</label><input name="incrementalBorrowingRate" defaultValue={v("incrementalBorrowingRate")} inputMode="decimal" placeholder="e.g. 7.5" /></div>
          <div><label>Discount rate used (annual %)</label><input name="discountRate" defaultValue={v("discountRate")} inputMode="decimal" placeholder="Blank = incremental borrowing rate" /><div className="muted">Use the rate implicit in the lease if you know it.</div></div>
          <div><label>Payments made before the start date</label><input name="prepaidLeasePayments" defaultValue={v("prepaidLeasePayments")} inputMode="decimal" placeholder="0.00" /><div className="muted">e.g. advance rent already recorded as prepaid</div></div>
          <div><label>Initial direct costs</label><input name="initialDirectCosts" defaultValue={v("initialDirectCosts")} inputMode="decimal" placeholder="0.00" /><div className="muted">e.g. broker&apos;s commission</div></div>
          <div><label>Lease incentives received</label><input name="leaseIncentives" defaultValue={v("leaseIncentives")} inputMode="decimal" placeholder="0.00" /></div>
          <div><label>Estimated restoration cost</label><input name="restorationCost" defaultValue={v("restorationCost")} inputMode="decimal" placeholder="0.00" /></div>
          <div><label>&nbsp;</label><label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--ink)" }}><input type="checkbox" name="transfersOwnership" checked={owns} onChange={(e) => setOwns(e.target.checked)} style={{ width: "auto" }} /> Ownership transfers or purchase option reasonably certain</label></div>
          {owns && <div><label>Useful life of the asset (months)</label><input name="usefulLifeMonths" defaultValue={v("usefulLifeMonths")} inputMode="numeric" /></div>}
        </div>
      </>}

      <h2>GL accounts</h2>
      <div className="card grid">
        {!exempt && acct("rouAccountId", "Right-of-use asset")}
        {!exempt && acct("accumDepAccountId", "Accumulated depreciation - ROU")}
        {acct("liabilityAccountId", exempt ? "Accrued / prepaid rent" : "Lease liability - non-current")}
        {!exempt && acct("currentLiabilityAccountId", "Lease liability - current portion", { optional: true, hint: "Blank = no current/non-current split" })}
        {!exempt && acct("interestAccountId", "Interest expense")}
        {!exempt && acct("depreciationAccountId", "Depreciation expense")}
        {exempt && acct("rentExpenseAccountId", "Rent expense")}
        {acct("paymentAccountId", "Payments due credited to", { hint: "Usually Accounts Payable; pay the lessor from Cash and Bank" })}
        {acct("gainLossAccountId", "Gain or loss on modification / termination")}
        {!exempt && acct("initialCostsAccountId", "Offset for advance rent, direct costs and incentives", { optional: true })}
        {!exempt && acct("restorationAccountId", "Provision for restoration", { optional: true })}
      </div>

      {data.dims.length > 0 && <>
        <h2>Dimensions (for interest, depreciation and rent)</h2>
        <div className="card grid">
          {data.dims.map((d) => <div key={d.key}><label>{d.label}</label><select name={`dim_${d.key}`} defaultValue={initial.dims?.[d.key] ?? ""}><option value="">(none)</option>{d.values.map((x) => <option key={x.id} value={x.id}>{x.code} · {x.name}</option>)}</select></div>)}
        </div>
      </>}

      <h2>Existing lease at go-live (optional)</h2>
      <div className="card grid">
        <div><label>Go-live date (first day of a month)</label><input type="date" name="takeUpDate" defaultValue={v("takeUpDate")} /><div className="muted">For a lease that started before you moved to Veritus: its balances are posted as at this date; earlier months are not posted.</div></div>
        {acct("takeUpOffsetAccountId", "Offset account for the take-up", { hint: "Retained earnings, or the suspense account your opening balances used" })}
      </div>

      <div><label>Notes</label><textarea name="notes" defaultValue={v("notes")} rows={2} style={{ width: "100%" }} /></div>
      <div className="row" style={{ gap: 8, marginTop: 12 }}><button>Save draft and calculate</button></div>
      <p className="muted">Saving calculates the lease liability, ROU asset and the full schedule. Nothing posts to the GL until someone approves the lease.</p>
    </ActionForm>
  );
}
