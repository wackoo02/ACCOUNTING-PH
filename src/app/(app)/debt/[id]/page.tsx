import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, fromCentavos, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { loanAction, modifyAction } from "../../debt-actions";
import { LOAN_TYPES, METRICS, TXN_LABELS, amortizationTable, evaluateCovenants, loanBalances, paymentDue } from "@/lib/debt/service";
import { DAY_COUNT_LABELS, FREQUENCY_LABELS, REPAYMENT_LABELS } from "@/lib/debt/schedule";
import { AccountSelect } from "../LoanForm";

const p = (v: { toString(): string } | null | undefined) => formatPeso(toCentavos(v?.toString() ?? "0"), { blankZero: true });
const input = (c: bigint) => fromCentavos(c);

export default async function LoanView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const loan = await prisma.loan.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!loan) notFound();
  const t = today();
  const asOf = new Date(`${t}T00:00:00.000Z`);
  const [{ balances }, txns, covenants, banks, accounts, table, covEval] = await Promise.all([
    loanBalances(ctx.org.id),
    prisma.loanTransaction.findMany({ where: { loanId: id }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] }),
    prisma.loanCovenant.findMany({ where: { loanId: id, isActive: true }, orderBy: { name: "asc" } }),
    prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id, isActive: true, kind: { in: ["CURRENT", "SAVINGS"] } }, orderBy: { code: "asc" } }),
    prisma.account.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } }),
    amortizationTable(ctx.org.id, id, asOf),
    evaluateCovenants(ctx.org.id, asOf),
  ]);
  const bal = balances.get(id)!;
  const drawn = !!loan.lastAccrualDate;
  const active = loan.status === "ACTIVE";
  const overdue = table.rows.some((r) => r.unpaid > 0n && r.dueDate < asOf);
  const next = table.rows.find((r) => r.unpaid > 0n && r.dueDate >= asOf);
  const payDate = overdue || !next ? t : fmtDate(next.dueDate); // past-due installments: pay today
  const due = drawn && active ? await paymentDue(ctx.org.id, id, new Date(`${payDate}T00:00:00.000Z`)) : null;
  const [journals, vouchers] = await Promise.all([
    prisma.journalEntry.findMany({ where: { id: { in: txns.map((x) => x.journalEntryId).filter(Boolean) as string[] } }, select: { id: true, number: true } }),
    prisma.cashTransaction.findMany({ where: { id: { in: txns.map((x) => x.cashTransactionId).filter(Boolean) as string[] } }, select: { id: true, number: true, status: true } }),
  ]);
  const jn = new Map(journals.map((j) => [j.id, j])), vn = new Map(vouchers.map((v) => [v.id, v]));
  const live = txns.filter((x) => x.status !== "VOID");
  const latest = [...live].sort((a, b) => b.date.getTime() - a.date.getTime() || b.createdAt.getTime() - a.createdAt.getTime())[0];
  const post = can(ctx.role, "journal.post"), create = can(ctx.role, "journal.create"), voidOk = can(ctx.role, "journal.void");
  const acct = new Map(accounts.map((a) => [a.id, a]));
  const name = (aid: string | null) => (aid ? `${acct.get(aid)?.code} · ${acct.get(aid)?.name}` : "—");
  const hidden = <input type="hidden" name="loanId" value={id} />;
  const bankSel = (
    <select name="bankAccountId" defaultValue={loan.bankAccountId ?? ""} required>
      <option value="">Choose…</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
    </select>
  );

  return (
    <>
      <div className="top">
        <h1>Loan {loan.number} <span className={`badge ${active ? "POSTED" : "VOID"}`}>{active ? (drawn ? "ACTIVE" : "NOT DRAWN") : "SETTLED"}</span></h1>
        <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}>
          {post && <Link className="btn secondary" href={`/debt/${id}/edit`}>Edit</Link>}
          <Link className="btn secondary" href={`/debt/${id}/amortization`}>Amortization table</Link>
        </div>
      </div>
      <div className="card grid">
        <div><label>Lender</label>{loan.lender}{loan.lenderVendorCode && <div className="muted">vendor {loan.lenderVendorCode}</div>}</div>
        <div><label>Type</label>{LOAN_TYPES[loan.loanType] ?? loan.loanType}</div>
        <div><label>{loan.loanType === "REVOLVING" ? "Credit limit" : "Original principal"}</label>{p(loan.originalPrincipal)}</div>
        <div><label>Interest rate</label>{Number(loan.interestRate)}% p.a. {loan.rateType === "FLOATING" ? "floating" : "fixed"}, {DAY_COUNT_LABELS[loan.dayCount as keyof typeof DAY_COUNT_LABELS]}
          {loan.effectiveRate && <div className="muted">effective rate {Number(loan.effectiveRate).toFixed(4)}%</div>}</div>
        <div><label>Term</label>{fmtDate(loan.startDate)} to {fmtDate(loan.maturityDate)}</div>
        <div><label>Payments</label>{FREQUENCY_LABELS[loan.paymentFrequency as keyof typeof FREQUENCY_LABELS]}; {REPAYMENT_LABELS[loan.repaymentType as keyof typeof REPAYMENT_LABELS]}{loan.graceMonths ? `; ${loan.graceMonths} months grace` : ""}</div>
        <div><label>Interest accrued up to</label>{loan.lastAccrualDate ? fmtDate(loan.lastAccrualDate) : "—"}</div>
      </div>
      <div className="grid">
        <div className="card stat"><div className="l">Principal outstanding</div><div className="n">{formatPeso(bal.principal)}</div></div>
        <div className="card stat"><div className="l">Current portion</div><div className="n">{formatPeso(bal.current)}</div><div className="l">{name(loan.stAccountId)}</div></div>
        <div className="card stat"><div className="l">Non-current portion</div><div className="n">{formatPeso(bal.nonCurrent)}</div><div className="l">{name(loan.ltAccountId)}</div></div>
        <div className="card stat"><div className="l">Unamortized transaction costs</div><div className="n">{formatPeso(bal.unamortized)}</div><div className="l">Carrying amount {formatPeso(bal.carrying)}</div></div>
        <div className="card stat"><div className="l">Accrued interest payable</div><div className="n">{formatPeso(bal.accrued)}</div><div className="l">{name(loan.interestPayableAccountId)}</div></div>
      </div>
      {loan.notes && <p className="muted">{loan.notes}</p>}

      {active && (post || create) && <div className="noprint">
        {post && <details className="card" open={!drawn}>
          <summary><b>Record drawdown</b> (loan proceeds received)</summary>
          <ActionForm action={loanAction}>{hidden}<input type="hidden" name="op" value="drawdown" />
            <div className="row" style={{ marginTop: 8 }}>
              <div><label>Date</label><input type="date" name="date" defaultValue={drawn ? t : fmtDate(loan.startDate)} required /></div>
              <div><label>Amount drawn</label><input name="amount" defaultValue={drawn ? "" : loan.originalPrincipal.toString()} required inputMode="decimal" /></div>
              <div><label>Transaction costs deducted (fees, DST)</label><input name="fees" defaultValue="0" inputMode="decimal" /></div>
              <div><label>Proceeds deposited to</label>{bankSel}</div>
              <div style={{ flex: 2 }}><label>Memo</label><input name="memo" placeholder="optional" /></div>
            </div>
            <p className="muted">Posts: debit bank (net proceeds), debit transaction costs, credit the loan split into current and non-current portions. The repayment schedule is generated from the drawdown date.</p>
            <button>Post drawdown</button>
          </ActionForm>
        </details>}

        {drawn && create && due && <details className="card" open>
          <summary><b>Pay principal and interest</b> (creates a cash disbursement voucher)</summary>
          <ActionForm action={loanAction}>{hidden}<input type="hidden" name="op" value="pay" />
            <div className="row" style={{ marginTop: 8 }}>
              <div><label>Payment date</label><input type="date" name="date" defaultValue={payDate} required /></div>
              <div><label>Principal</label><input name="principal" defaultValue={input(due.principal)} inputMode="decimal" /></div>
              <div><label>Interest</label><input name="interest" defaultValue={input(due.interest)} inputMode="decimal" /></div>
              <div><label>Paid from</label>{bankSel}</div>
              <div><label>Method</label><select name="method" defaultValue="BANK_TRANSFER"><option value="BANK_TRANSFER">Bank transfer / auto-debit</option><option value="CHECK">Check</option><option value="ONLINE">Online</option></select></div>
              <div><label>Check no. (blank = next in checkbook)</label><input name="checkNo" /></div>
            </div>
            <p className="muted">Defaults: principal scheduled up to the payment date and not yet paid; interest accrued to the payment date (accrued automatically when you save). Principal settles the current portion first; interest settles accrued interest first. Outstanding {formatPeso(due.outstanding)}.</p>
            <div className="row" style={{ gap: 8 }}>
              <button name="intent" value="submit">Create voucher and submit for approval</button>
              <button name="intent" value="draft" className="secondary">Save voucher as draft</button>
            </div>
          </ActionForm>
        </details>}

        {drawn && post && <details className="card">
          <summary><b>Accrue interest</b> (effective interest method)</summary>
          <ActionForm action={loanAction}>{hidden}<input type="hidden" name="op" value="accrue" />
            <div className="row" style={{ marginTop: 8 }}>
              <div><label>Accrue up to</label><input type="date" name="date" defaultValue={t} required /></div>
              <div style={{ flex: 3 }} className="muted">Debit interest expense at the effective rate, credit accrued interest at the contract rate; the difference amortizes the transaction costs. To accrue every loan at month-end and reclassify, use the <Link href="/debt/period-end">period-end run</Link>.</div>
            </div>
            <button>Accrue and post</button>
          </ActionForm>
        </details>}

        {drawn && post && <details className="card">
          <summary><b>Modify terms</b> (restructuring, rate reset, extension, re-amortization after a prepayment)</summary>
          <ActionForm action={modifyAction}>{hidden}
            <div className="row" style={{ marginTop: 8 }}>
              <div><label>Effective date</label><input type="date" name="date" defaultValue={t} required /></div>
              <div style={{ flex: 2 }}><label>Kind</label><select name="kind" defaultValue="TERMS">
                <option value="TERMS">Change of terms (PFRS 9 10% test)</option>
                <option value="REPRICING">Floating rate reset or re-amortization (no gain or loss)</option></select></div>
              <div><label>New interest rate (%)</label><input name="interestRate" defaultValue={loan.interestRate.toString()} required /></div>
              <div><label>New maturity date</label><input type="date" name="maturityDate" defaultValue={fmtDate(loan.maturityDate)} required /></div>
            </div>
            <div className="row">
              <div><label>Payment frequency</label><select name="paymentFrequency" defaultValue={loan.paymentFrequency}>{Object.entries(FREQUENCY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div style={{ flex: 2 }}><label>Principal repayment</label><select name="repaymentType" defaultValue={loan.repaymentType}>{Object.entries(REPAYMENT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div><label>Next payment date (blank = one period after)</label><input type="date" name="firstPaymentDate" /></div>
            </div>
            <div className="row">
              <div><label>Fees paid to the lender</label><input name="fees" defaultValue="0" inputMode="decimal" /></div>
              <div><label>Fees paid from</label>
                <select name="bankAccountId" defaultValue={loan.bankAccountId ?? ""}><option value="">—</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></div>
              <div><label>Gain / loss account</label><AccountSelect name="gainLossAccountId" accounts={accounts} types={["EXPENSE", "INCOME"]} value={loan.interestExpenseAccountId} /></div>
              <div style={{ flex: 2 }}><label>Reason / agreement reference</label><input name="reason" required /></div>
            </div>
            <p className="muted">Preview first. Under 10% change in the present value (at the original effective rate): the carrying amount is adjusted and the difference is a gain or loss. 10% or more: the old loan is derecognized and remaining unamortized costs and fees are expensed.</p>
            <div className="row" style={{ gap: 8 }}><button name="intent" value="preview" className="secondary">Preview</button><button name="intent" value="post">Post modification</button></div>
          </ActionForm>
        </details>}
      </div>}

      <h2>Covenants</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Covenant</th><th>Measure</th><th className="num">Required</th><th className="num">Actual today</th><th>Status</th><th>Waiver until</th><th className="noprint" /></tr></thead>
        <tbody>
          {covenants.map((cv) => {
            const e = covEval.find((x) => x.covenant.id === cv.id);
            const peso = METRICS[cv.metric]?.unit === "peso";
            return (
              <tr key={cv.id}>
                <td>{cv.name}{cv.notes && <div className="muted">{cv.notes}</div>}</td><td>{METRICS[cv.metric]?.label ?? cv.metric}</td>
                <td className="num">{cv.operator === "MIN" ? "at least" : "at most"} {peso ? p(cv.threshold) : Number(cv.threshold)}</td>
                <td className="num">{e?.value == null ? "—" : peso ? e.value.toLocaleString("en-PH", { minimumFractionDigits: 2 }) : e.value.toFixed(2)}</td>
                <td>{e && <span className={`badge ${e.status === "PASS" ? "POSTED" : e.status === "BREACH" ? "BREACH" : e.status === "WATCH" || e.status === "WAIVED" ? "DRAFT" : "VOID"}`}>{e.status.replace("_", " ")}</span>}</td>
                <td>{cv.waiverUntil ? fmtDate(cv.waiverUntil) : ""}</td>
                <td className="noprint">{post && <ActionForm action={loanAction} confirm="Remove this covenant?">{hidden}<input type="hidden" name="op" value="covenant_remove" /><input type="hidden" name="covenantId" value={cv.id} /><button className="secondary">Remove</button></ActionForm>}</td>
              </tr>
            );
          })}
          {covenants.length === 0 && <tr><td colSpan={7} className="muted">No covenants.</td></tr>}
        </tbody>
      </table></div>
      {post && active && <details className="card noprint">
        <summary><b>Add or update a covenant</b></summary>
        <ActionForm action={loanAction}>{hidden}<input type="hidden" name="op" value="covenant" />
          <div className="row" style={{ marginTop: 8 }}>
            <div><label>Update existing</label><select name="covenantId" defaultValue=""><option value="">New covenant</option>{covenants.map((cv) => <option key={cv.id} value={cv.id}>{cv.name}</option>)}</select></div>
            <div style={{ flex: 2 }}><label>Name (as in the agreement)</label><input name="name" required placeholder="e.g. Debt-to-equity not more than 2.5x" /></div>
            <div style={{ flex: 2 }}><label>Measure</label><select name="metric">{Object.entries(METRICS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}</select></div>
          </div>
          <div className="row">
            <div><label>Rule</label><select name="operator"><option value="MIN">At least (minimum)</option><option value="MAX">At most (maximum)</option></select></div>
            <div><label>Threshold</label><input name="threshold" required inputMode="decimal" /></div>
            <div><label>Tested</label><select name="frequency"><option value="QUARTERLY">Quarterly</option><option value="SEMI_ANNUAL">Semi-annually</option><option value="ANNUAL">Annually</option></select></div>
            <div><label>Manual value (for Other)</label><input name="manualValue" inputMode="decimal" /></div>
            <div><label>Waiver valid until</label><input type="date" name="waiverUntil" /></div>
            <div style={{ flex: 2 }}><label>Notes</label><input name="notes" /></div>
          </div>
          <button>Save covenant</button>
        </ActionForm>
      </details>}

      <h2>Transactions</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Type</th><th>Description</th><th>GL / voucher</th><th className="num">Principal</th><th className="num">Current portion</th><th className="num">Interest expense</th><th className="num">Cash</th><th>Status</th><th className="noprint" /></tr></thead>
        <tbody>
          {txns.map((x) => {
            const v = x.cashTransactionId ? vn.get(x.cashTransactionId) : null;
            const j = x.journalEntryId ? jn.get(x.journalEntryId) : null;
            return (
              <tr key={x.id} style={x.status === "VOID" ? { opacity: 0.5 } : undefined}>
                <td style={{ whiteSpace: "nowrap" }}>{fmtDate(x.date)}</td><td>{TXN_LABELS[x.type] ?? x.type}</td><td>{x.memo}</td>
                <td>{v ? <Link href={`/cash/${v.id}`}>{v.number}</Link> : j ? <Link href={`/journals/${j.id}`}>{j.number}</Link> : ""}</td>
                <td className="num">{p(x.principalChange)}</td><td className="num">{p(x.currentChange)}</td><td className="num">{p(x.interestExpense)}</td><td className="num">{p(x.cashChange)}</td>
                <td><span className={`badge ${x.status === "PENDING" ? "PENDING_APPROVAL" : x.status}`}>{x.status === "PENDING" ? `VOUCHER ${v?.status === "DRAFT" ? "DRAFT" : "FOR APPROVAL"}` : x.status}</span></td>
                <td className="noprint">{voidOk && latest?.id === x.id && x.status === "POSTED" && ["ACCRUAL", "RECLASS", "DRAWDOWN"].includes(x.type) &&
                  <ActionForm action={loanAction} confirm="Undo this transaction? Its GL entry will be reversed.">{hidden}<input type="hidden" name="op" value="undo" /><input type="hidden" name="txnId" value={x.id} /><button className="secondary">Undo</button></ActionForm>}</td>
              </tr>
            );
          })}
          {txns.length === 0 && <tr><td colSpan={10} className="muted">No transactions yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
