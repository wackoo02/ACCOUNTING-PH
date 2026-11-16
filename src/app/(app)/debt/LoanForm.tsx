import type { Account, BankAccount, Loan, Vendor } from "@prisma/client";
import { ActionForm } from "@/components/ActionForm";
import { saveLoanAction } from "../debt-actions";
import { LOAN_TYPES } from "@/lib/debt/service";
import { DAY_COUNT_LABELS, FREQUENCY_LABELS, REPAYMENT_LABELS } from "@/lib/debt/schedule";
import { fmtDate } from "@/lib/format";

export function AccountSelect({ name, accounts, value, types, blank }: { name: string; accounts: Account[]; value?: string | null; types: string[]; blank?: string }) {
  return (
    <select name={name} defaultValue={value ?? ""} required={!blank}>
      <option value="">{blank ?? "Choose…"}</option>
      {accounts.filter((a) => types.includes(a.type) && a.isPostable && a.isActive).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
    </select>
  );
}

const byCode = (accounts: Account[], code: string) => accounts.find((a) => a.code === code)?.id;

export function LoanForm({ loan, accounts, banks, vendors, locked }: { loan?: Loan | null; accounts: Account[]; banks: BankAccount[]; vendors: Vendor[]; locked: boolean }) {
  const v = (d?: Date | null) => (d ? fmtDate(d) : "");
  return (
    <ActionForm action={saveLoanAction}>
      {loan && <input type="hidden" name="id" value={loan.id} />}
      {locked && <div className="notice">This loan has transactions, so its amount, rate, dates, payment terms and accounts are fixed. Use <b>Modify terms</b> on the loan page for a restructuring or rate reset.</div>}
      <h2>Loan</h2>
      <div className="card row">
        <div><label>Loan number</label><input name="number" defaultValue={loan?.number} required placeholder="e.g. BDO-TL-2026-001" /></div>
        <div style={{ flex: 2 }}><label>Lender</label><input name="lender" defaultValue={loan?.lender} required placeholder="Bank or lender name" /></div>
        <div><label>Lender in Vendors list (optional)</label>
          <select name="lenderVendorCode" defaultValue={loan?.lenderVendorCode ?? ""}><option value="">None</option>{vendors.map((x) => <option key={x.id} value={x.code}>{x.code} · {x.name}</option>)}</select></div>
        <div><label>Loan type</label><select name="loanType" defaultValue={loan?.loanType ?? "TERM_LOAN"}>{Object.entries(LOAN_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      </div>
      <h2>Amount and interest</h2>
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="card row">
          <div><label>Original principal (credit limit for a revolving line)</label><input name="originalPrincipal" defaultValue={loan?.originalPrincipal.toString()} required inputMode="decimal" /></div>
          <div><label>Interest rate (% per year)</label><input name="interestRate" defaultValue={loan?.interestRate.toString()} required inputMode="decimal" placeholder="7.5" /></div>
          <div><label>Rate type</label><select name="rateType" defaultValue={loan?.rateType ?? "FIXED"}><option value="FIXED">Fixed</option><option value="FLOATING">Floating (repriced)</option></select></div>
          <div><label>Day count</label><select name="dayCount" defaultValue={loan?.dayCount ?? "ACT_365"}>{Object.entries(DAY_COUNT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        </div>
        <h2>Dates and payment terms</h2>
        <div className="card row">
          <div><label>Start date</label><input type="date" name="startDate" defaultValue={v(loan?.startDate)} required /></div>
          <div><label>Maturity date</label><input type="date" name="maturityDate" defaultValue={v(loan?.maturityDate)} required /></div>
          <div><label>First payment date (blank = one period after start)</label><input type="date" name="firstPaymentDate" defaultValue={v(loan?.firstPaymentDate)} /></div>
          <div><label>Payment frequency</label><select name="paymentFrequency" defaultValue={loan?.paymentFrequency ?? "MONTHLY"}>{Object.entries(FREQUENCY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div style={{ flex: 2 }}><label>Principal repayment</label><select name="repaymentType" defaultValue={loan?.repaymentType ?? "ANNUITY"}>{Object.entries(REPAYMENT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div><label>Grace period on principal (months)</label><input name="graceMonths" type="number" min={0} defaultValue={loan?.graceMonths ?? 0} /></div>
        </div>
        <h2>Accounts</h2>
        <div className="card row">
          <div><label>Current portion (ST)</label><AccountSelect name="stAccountId" accounts={accounts.filter((a) => a.isCurrent !== false)} types={["LIABILITY"]} value={loan?.stAccountId ?? byCode(accounts, "2095")} /></div>
          <div><label>Non-current portion (LT)</label><AccountSelect name="ltAccountId" accounts={accounts.filter((a) => a.isCurrent !== true)} types={["LIABILITY"]} value={loan?.ltAccountId ?? byCode(accounts, "2510")} /></div>
          <div><label>Interest expense</label><AccountSelect name="interestExpenseAccountId" accounts={accounts} types={["EXPENSE"]} value={loan?.interestExpenseAccountId ?? byCode(accounts, "7510")} /></div>
          <div><label>Accrued interest payable</label><AccountSelect name="interestPayableAccountId" accounts={accounts} types={["LIABILITY"]} value={loan?.interestPayableAccountId ?? byCode(accounts, "2020")} /></div>
          <div><label>Unamortized transaction costs</label><AccountSelect name="issueCostAccountId" accounts={accounts} types={["LIABILITY", "ASSET"]} value={loan?.issueCostAccountId} blank="Net against the non-current loan account" /></div>
        </div>
      </fieldset>
      {locked && loan && <>
        {([["originalPrincipal", loan.originalPrincipal.toString()], ["interestRate", loan.interestRate.toString()], ["rateType", loan.rateType], ["dayCount", loan.dayCount],
          ["startDate", v(loan.startDate)], ["maturityDate", v(loan.maturityDate)], ["firstPaymentDate", v(loan.firstPaymentDate)], ["paymentFrequency", loan.paymentFrequency],
          ["repaymentType", loan.repaymentType], ["graceMonths", String(loan.graceMonths)], ["stAccountId", loan.stAccountId], ["ltAccountId", loan.ltAccountId],
          ["interestExpenseAccountId", loan.interestExpenseAccountId], ["interestPayableAccountId", loan.interestPayableAccountId], ["issueCostAccountId", loan.issueCostAccountId ?? ""]] as const)
          .map(([k, val]) => <input key={k} type="hidden" name={k} value={val} />)}
      </>}
      <div className="card row">
        <div><label>Default bank account (drawdowns and payments)</label>
          <select name="bankAccountId" defaultValue={loan?.bankAccountId ?? ""}><option value="">None</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></div>
        <div style={{ flex: 3 }}><label>Notes (security, guarantees, purpose)</label><input name="notes" defaultValue={loan?.notes ?? ""} /></div>
      </div>
      <p className="muted">Transaction costs (bank fees, documentary stamp tax on the loan, legal fees) are entered at drawdown and amortized at the effective interest rate (PFRS 9).</p>
      <button>Save loan</button>
    </ActionForm>
  );
}
