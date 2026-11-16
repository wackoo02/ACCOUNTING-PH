// Debt module: loans and borrowings at amortized cost (PFRS 9), current / non-current split (PAS 1).
// GL postings go through recordJournalTx (source DEBT). Loan payments are cash disbursement vouchers
// (Cash and Bank), so they follow the voucher approval workflow and appear in the bank reconciliation.
import { Prisma, type Loan } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { LedgerError, asDay, audit, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import type { LineInput } from "../ledger/validate";
import { balanceSheet, incomeStatement } from "../ledger/reports";
import { saveCashTransaction, type CashLine } from "../bank/cash";
import {
  accrualBetween, addMonths, buildSchedule, presentValue, tenPercentTest, ymd,
  type DayCount, type Frequency, type RepaymentType, type Row, type Terms,
} from "./schedule";

type Tx = Prisma.TransactionClient;

export const LOAN_TYPES: Record<string, string> = {
  TERM_LOAN: "Term loan", REVOLVING: "Revolving credit line", NOTES_PAYABLE: "Notes payable",
  RELATED_PARTY: "Loan from related party / shareholder", OTHER: "Other borrowing",
};
export const FREQUENCIES = ["MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL", "AT_MATURITY"] as const;
export const REPAYMENTS = ["ANNUITY", "EQUAL_PRINCIPAL", "BULLET"] as const;
export const DAY_COUNTS = ["ACT_365", "ACT_360", "30_360"] as const;
export const TXN_LABELS: Record<string, string> = {
  DRAWDOWN: "Drawdown", PAYMENT: "Payment", ACCRUAL: "Interest accrual", RECLASS: "Current / non-current reclassification",
  MODIFICATION: "Modification", WRITE_OFF: "Settlement write-off",
};

const c = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");
const dec = (b: bigint) => new Prisma.Decimal(fromCentavos(b));
const fmt = (b: bigint) => (Number(b) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const monthsOf = (f: string) => ({ MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 } as Record<string, number>)[f] ?? 0;

// ---------- Terms and schedule ----------

type TermFields = Pick<Loan, "interestRate" | "dayCount" | "paymentFrequency" | "repaymentType" | "firstPaymentDate" | "startDate" | "maturityDate" | "graceMonths">;

export function termsOf(l: TermFields): Terms {
  const m = monthsOf(l.paymentFrequency);
  return {
    rate: Number(l.interestRate),
    dayCount: l.dayCount as DayCount,
    frequency: l.paymentFrequency as Frequency,
    repaymentType: l.repaymentType as RepaymentType,
    anchor: l.firstPaymentDate ?? (m ? addMonths(l.startDate, m) : l.maturityDate),
    maturityDate: l.maturityDate,
    principalFrom: l.graceMonths > 0 ? addMonths(l.startDate, l.graceMonths) : null,
  };
}

const rowOf = (r: Prisma.LoanScheduleLineGetPayload<object>): Row => ({
  seq: r.seq, periodStart: r.periodStart, dueDate: r.dueDate, openingPrincipal: c(r.openingPrincipal), interest: c(r.interest),
  principal: c(r.principal), payment: c(r.payment), closingPrincipal: c(r.closingPrincipal), openingCarrying: c(r.openingCarrying),
  eirInterest: c(r.eirInterest), amortization: c(r.amortization), closingCarrying: c(r.closingCarrying),
});

async function scheduleOf(tx: Tx, loanId: string) {
  return (await tx.loanScheduleLine.findMany({ where: { loanId }, orderBy: [{ dueDate: "asc" }, { seq: "asc" }] })).map(rowOf);
}

/** Replace the schedule after `from` with a new one built on the outstanding balance. */
async function regenerate(tx: Tx, loan: Loan, from: Date, principal: bigint, carrying: bigint, terms: Terms) {
  await tx.loanScheduleLine.deleteMany({ where: { loanId: loan.id, dueDate: { gt: from } } });
  const kept = await tx.loanScheduleLine.count({ where: { loanId: loan.id } });
  const { rows, eir } = buildSchedule(from, principal, carrying, terms);
  if (rows.length) {
    await tx.loanScheduleLine.createMany({
      data: rows.map((r) => ({
        loanId: loan.id, seq: kept + r.seq, periodStart: r.periodStart, dueDate: r.dueDate,
        openingPrincipal: dec(r.openingPrincipal), interest: dec(r.interest), principal: dec(r.principal), payment: dec(r.payment),
        closingPrincipal: dec(r.closingPrincipal), openingCarrying: dec(r.openingCarrying), eirInterest: dec(r.eirInterest),
        amortization: dec(r.amortization), closingCarrying: dec(r.closingCarrying),
      })),
    });
  }
  await tx.loan.update({ where: { id: loan.id }, data: { effectiveRate: new Prisma.Decimal(eir.toFixed(8)) } });
  return { rows, eir };
}

/** Principal falling due within 12 months after `asOf` (PAS 1.69), capped at what is outstanding. */
export function currentPortion(rows: Row[], asOf: Date, outstanding: bigint) {
  const horizon = addMonths(asOf, 12);
  const later = rows.filter((r) => r.dueDate > horizon).reduce((s, r) => s + r.principal, 0n);
  return max(0n, outstanding - min(outstanding, later));
}

// ---------- Balances ----------

export type LoanBalance = { principal: bigint; current: bigint; nonCurrent: bigint; unamortized: bigint; carrying: bigint; accrued: bigint };

async function balancesTx(tx: Tx, loanId: string, asOf?: Date, includePending = false): Promise<LoanBalance> {
  const a = await tx.loanTransaction.aggregate({
    where: { loanId, status: { in: includePending ? ["POSTED", "PENDING"] : ["POSTED"] }, ...(asOf ? { date: { lte: asOf } } : {}) },
    _sum: { principalChange: true, currentChange: true, costChange: true, accruedChange: true },
  });
  const principal = c(a._sum.principalChange), current = c(a._sum.currentChange), unamortized = c(a._sum.costChange);
  return { principal, current, nonCurrent: principal - current, unamortized, carrying: principal - unamortized, accrued: c(a._sum.accruedChange) };
}

export async function loanBalances(organizationId: string, asOf?: Date) {
  await syncLoanPayments(organizationId);
  const loans = await prisma.loan.findMany({ where: { organizationId }, orderBy: { number: "asc" } });
  const out = new Map<string, LoanBalance>();
  await prisma.$transaction(async (tx) => { for (const l of loans) out.set(l.id, await balancesTx(tx, l.id, asOf)); });
  return { loans, balances: out };
}

// ---------- Helpers ----------

async function loadLoan(tx: Tx, organizationId: string, id: string) {
  const l = await tx.loan.findFirst({ where: { id, organizationId } });
  if (!l) throw new LedgerError(["Loan not found"]);
  return l;
}

const party = (l: Loan) => (l.lenderVendorCode ? { partyType: "VENDOR", partyId: l.lenderVendorCode } : {});
const costAcct = (l: Loan) => l.issueCostAccountId ?? l.ltAccountId;

/** A debit (positive) or credit (negative) line; zero lines are skipped. */
function line(accountId: string, signed: bigint, description: string, extra: Partial<LineInput> = {}): LineInput[] {
  if (signed === 0n) return [];
  return [{ accountId, description, ...(signed > 0n ? { debit: fromCentavos(signed) } : { credit: fromCentavos(-signed) }), ...extra }];
}

type TxnData = {
  type: string; date: Date; memo: string; principalChange?: bigint; currentChange?: bigint; costChange?: bigint; accruedChange?: bigint;
  interestExpense?: bigint; cashChange?: bigint; details?: Prisma.InputJsonValue; status?: string; cashTransactionId?: string | null;
};

/** Record a loan transaction and post its GL entry (source DEBT, sourceId = the transaction). */
async function recordTxn(tx: Tx, loan: Loan, userId: string, t: TxnData, lines: LineInput[]) {
  const row = await tx.loanTransaction.create({
    data: {
      organizationId: loan.organizationId, loanId: loan.id, type: t.type, date: asDay(t.date), memo: t.memo,
      principalChange: dec(t.principalChange ?? 0n), currentChange: dec(t.currentChange ?? 0n), costChange: dec(t.costChange ?? 0n),
      accruedChange: dec(t.accruedChange ?? 0n), interestExpense: dec(t.interestExpense ?? 0n), cashChange: dec(t.cashChange ?? 0n),
      details: t.details, status: t.status ?? "POSTED", cashTransactionId: t.cashTransactionId ?? null, createdById: userId,
    },
  });
  let journalNumber: string | null = null;
  if (lines.length) {
    const e = await recordJournalTx(tx, {
      organizationId: loan.organizationId, userId, date: t.date, memo: `Loan ${loan.number} (${loan.lender}): ${t.memo}`,
      reference: loan.number, lines, source: "DEBT", sourceId: row.id, action: "post",
    });
    await tx.loanTransaction.update({ where: { id: row.id }, data: { journalEntryId: e.id } });
    journalNumber = e.number;
  }
  await audit(tx, loan.organizationId, userId, `loan.${t.type.toLowerCase()}`, loan.id, { number: loan.number, journal: journalNumber, date: ymd(t.date) }, null, null, "loan");
  return row;
}

/** Loan transactions are recorded in date order. Accruals dated later only block changes to the balance or schedule. */
async function assertNothingLater(tx: Tx, loan: Loan, date: Date, includeAccruals = false) {
  const later = await tx.loanTransaction.findFirst({ where: { loanId: loan.id, status: "POSTED", date: { gt: date }, ...(includeAccruals ? {} : { type: { not: "ACCRUAL" } }) }, orderBy: { date: "desc" } });
  if (later) throw new LedgerError([`This loan already has a ${TXN_LABELS[later.type]?.toLowerCase() ?? later.type} dated ${ymd(later.date)}. Use that date or later.`]);
}

async function bankOf(tx: Tx, organizationId: string, id: string | null | undefined) {
  const b = id ? await tx.bankAccount.findFirst({ where: { id, organizationId } }) : null;
  if (!b) throw new LedgerError(["Choose the bank account"]);
  if (!b.isActive) throw new LedgerError([`${b.name} is inactive`]);
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (b.currencyCode !== org.baseCurrency) throw new LedgerError([`Loans are in ${org.baseCurrency} for now; choose a ${org.baseCurrency} bank account`]);
  return b;
}

// ---------- Loan master ----------

export type LoanInput = {
  organizationId: string; userId: string;
  number: string; lender: string; lenderVendorCode?: string | null; loanType: string;
  originalPrincipal: string; interestRate: string; rateType?: string; dayCount: string;
  startDate: Date; maturityDate: Date; firstPaymentDate?: Date | null; paymentFrequency: string; repaymentType: string; graceMonths?: number;
  stAccountId: string; ltAccountId: string; interestExpenseAccountId: string; interestPayableAccountId: string;
  issueCostAccountId?: string | null; bankAccountId?: string | null; notes?: string | null;
};

const TERM_KEYS = ["originalPrincipal", "interestRate", "dayCount", "startDate", "maturityDate", "firstPaymentDate", "paymentFrequency", "repaymentType", "graceMonths",
  "stAccountId", "ltAccountId", "interestExpenseAccountId", "interestPayableAccountId", "issueCostAccountId"] as const;

export async function saveLoan(input: LoanInput, id?: string) {
  return prisma.$transaction(async (tx) => {
    const errors: string[] = [];
    const org = input.organizationId;
    if (!input.number?.trim()) errors.push("Enter the loan number");
    if (!input.lender?.trim()) errors.push("Enter the lender");
    if (!LOAN_TYPES[input.loanType]) errors.push("Choose the loan type");
    let principal = 0n;
    try { principal = toCentavos(input.originalPrincipal); } catch (e) { errors.push(`Principal: ${(e as Error).message}`); }
    if (principal <= 0n) errors.push("Enter the original principal (or credit limit for a revolving line)");
    const rate = Number(input.interestRate);
    if (!(rate >= 0 && rate < 100) || String(input.interestRate ?? "").trim() === "") errors.push("Enter the annual interest rate in percent, e.g. 7.5");
    if (!(DAY_COUNTS as readonly string[]).includes(input.dayCount)) errors.push("Choose the day count");
    if (!(FREQUENCIES as readonly string[]).includes(input.paymentFrequency)) errors.push("Choose the payment frequency");
    if (!(REPAYMENTS as readonly string[]).includes(input.repaymentType)) errors.push("Choose how principal is repaid");
    const start = asDay(input.startDate), maturity = asDay(input.maturityDate);
    const first = input.firstPaymentDate ? asDay(input.firstPaymentDate) : null;
    if (!(maturity > start)) errors.push("The maturity date must be after the start date");
    if (first && (first <= start || first > maturity)) errors.push("The first payment date must be after the start date and not after maturity");
    const grace = Math.max(0, Math.floor(input.graceMonths ?? 0));

    const accts = await tx.account.findMany({ where: { organizationId: org, id: { in: [input.stAccountId, input.ltAccountId, input.interestExpenseAccountId, input.interestPayableAccountId, input.issueCostAccountId].filter(Boolean) as string[] } } });
    const chk = (aid: string | null | undefined, label: string, types: string[]) => {
      if (!aid) { errors.push(`Choose the ${label}`); return; }
      const a = accts.find((x) => x.id === aid);
      if (!a) errors.push(`The ${label} does not belong to this company`);
      else if (!a.isPostable || !a.isActive) errors.push(`${a.code} ${a.name} cannot be posted to (header or inactive)`);
      else if (!types.includes(a.type)) errors.push(`The ${label} must be a ${types.join(" or ").toLowerCase()} account (${a.code} is ${a.type.toLowerCase()})`);
    };
    chk(input.stAccountId, "current portion account", ["LIABILITY"]);
    chk(input.ltAccountId, "non-current portion account", ["LIABILITY"]);
    chk(input.interestExpenseAccountId, "interest expense account", ["EXPENSE"]);
    chk(input.interestPayableAccountId, "accrued interest payable account", ["LIABILITY"]);
    if (input.issueCostAccountId) chk(input.issueCostAccountId, "unamortized transaction cost account", ["LIABILITY", "ASSET"]);
    const st = accts.find((a) => a.id === input.stAccountId), lt = accts.find((a) => a.id === input.ltAccountId);
    if (st && st.isCurrent === false) errors.push(`${st.code} ${st.name} is a non-current account; choose a current liability for the current portion`);
    if (lt && lt.isCurrent === true) errors.push(`${lt.code} ${lt.name} is a current account; choose a non-current liability for the non-current portion`);
    if (input.stAccountId && input.stAccountId === input.ltAccountId) errors.push("Use different accounts for the current and non-current portions");
    if (input.bankAccountId && !(await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, organizationId: org } }))) errors.push("Bank account not found");
    const vendorCode = input.lenderVendorCode?.trim() || null;
    if (vendorCode && !(await tx.vendor.findUnique({ where: { organizationId_code: { organizationId: org, code: vendorCode } } }))) errors.push(`Vendor ${vendorCode} is not in the Vendors list`);
    if (errors.length) throw new LedgerError(errors);

    const data = {
      number: input.number.trim(), lender: input.lender.trim(), lenderVendorCode: vendorCode, loanType: input.loanType,
      originalPrincipal: dec(principal), interestRate: new Prisma.Decimal(String(rate)), rateType: input.rateType === "FLOATING" ? "FLOATING" : "FIXED",
      dayCount: input.dayCount, startDate: start, maturityDate: maturity, firstPaymentDate: first, paymentFrequency: input.paymentFrequency,
      repaymentType: input.repaymentType, graceMonths: grace, stAccountId: input.stAccountId, ltAccountId: input.ltAccountId,
      interestExpenseAccountId: input.interestExpenseAccountId, interestPayableAccountId: input.interestPayableAccountId,
      issueCostAccountId: input.issueCostAccountId || null, bankAccountId: input.bankAccountId || null, notes: input.notes?.trim() || null,
    };
    const dup = await tx.loan.findUnique({ where: { organizationId_number: { organizationId: org, number: data.number } } });
    if (dup && dup.id !== id) throw new LedgerError([`Loan number ${data.number} already exists`]);
    if (id) {
      const cur = await loadLoan(tx, org, id);
      const used = await tx.loanTransaction.count({ where: { loanId: id, status: { not: "VOID" } } });
      if (used) {
        const changed = TERM_KEYS.filter((k) => String(cur[k] instanceof Date ? ymd(cur[k] as Date) : cur[k] ?? "") !== String(data[k] instanceof Date ? ymd(data[k] as Date) : data[k] ?? ""));
        if (changed.length) throw new LedgerError(["This loan already has transactions. Change the rate, dates or payment terms with Modify terms; accounts and principal cannot change."]);
      }
      const l = await tx.loan.update({ where: { id }, data: { ...data, updatedById: input.userId } });
      await audit(tx, org, input.userId, "loan.update", id, { number: l.number }, JSON.parse(JSON.stringify(cur)), JSON.parse(JSON.stringify(l)), "loan");
      return l;
    }
    const l = await tx.loan.create({ data: { ...data, organizationId: org, createdById: input.userId } });
    await audit(tx, org, input.userId, "loan.create", l.id, { number: l.number }, null, JSON.parse(JSON.stringify(l)), "loan");
    return l;
  });
}

// ---------- Interest accrual (effective interest method) ----------

/** Accrue interest from the last accrual date to `asOf`: expense at the EIR, payable at the contract rate,
 *  the difference amortizes the transaction costs. */
async function accrueTx(tx: Tx, loan: Loan, userId: string, asOf: Date) {
  asOf = asDay(asOf);
  const from = loan.lastAccrualDate;
  if (!from || asOf <= from) return null;
  const rows = await scheduleOf(tx, loan.id);
  const { interest, eir } = accrualBetween(rows, from, asOf);
  await tx.loan.update({ where: { id: loan.id }, data: { lastAccrualDate: asOf } });
  loan.lastAccrualDate = asOf;
  if (interest === 0n && eir === 0n) return null;
  const amort = eir - interest;
  const memo = `Interest ${ymd(new Date(from.getTime() + 86_400_000))} to ${ymd(asOf)}`;
  return recordTxn(tx, loan, userId, { type: "ACCRUAL", date: asOf, memo, accruedChange: interest, costChange: -amort, interestExpense: eir, details: { from: ymd(from), to: ymd(asOf) } }, [
    ...line(loan.interestExpenseAccountId, eir, "Interest expense (effective interest method)"),
    ...line(loan.interestPayableAccountId, -interest, "Accrued interest payable", party(loan)),
    ...line(costAcct(loan), -amort, "Amortization of transaction costs", party(loan)),
  ]);
}

export async function accrueInterest(organizationId: string, userId: string, loanId: string, asOf: Date) {
  return prisma.$transaction(async (tx) => {
    const loan = await loadLoan(tx, organizationId, loanId);
    if (!loan.lastAccrualDate) throw new LedgerError(["Record the drawdown first"]);
    if (asDay(asOf) <= loan.lastAccrualDate) throw new LedgerError([`Interest is already accrued up to ${ymd(loan.lastAccrualDate)}`]);
    return accrueTx(tx, loan, userId, asOf);
  });
}

// ---------- Drawdown ----------

export async function recordDrawdown(input: {
  organizationId: string; userId: string; loanId: string; date: Date; amount: string; fees?: string | null; bankAccountId?: string | null; memo?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const loan = await loadLoan(tx, input.organizationId, input.loanId);
    const date = asDay(input.date);
    const errors: string[] = [];
    let amount = 0n, fees = 0n;
    try { amount = toCentavos(input.amount); } catch (e) { errors.push(`Amount: ${(e as Error).message}`); }
    try { fees = toCentavos(input.fees); } catch (e) { errors.push(`Fees: ${(e as Error).message}`); }
    if (amount <= 0n) errors.push("Enter the amount drawn");
    if (fees < 0n || (amount > 0n && fees >= amount)) errors.push("Transaction costs must be zero or more and less than the amount drawn");
    if (loan.status !== "ACTIVE") errors.push("This loan is already settled");
    if (date < loan.startDate) errors.push(`The drawdown cannot be before the loan start date ${ymd(loan.startDate)}`);
    if (date >= loan.maturityDate) errors.push("The drawdown must be before the maturity date");
    if (errors.length) throw new LedgerError(errors);
    const bank = await bankOf(tx, input.organizationId, input.bankAccountId || loan.bankAccountId);
    await assertNothingLater(tx, loan, date, true);

    const limit = c(loan.originalPrincipal);
    const bal0 = await balancesTx(tx, loan.id, undefined, true);
    if (loan.loanType === "REVOLVING") {
      if (bal0.principal + amount > limit) throw new LedgerError([`This would exceed the credit line of ${fmt(limit)} (outstanding ${fmt(bal0.principal)})`]);
    } else {
      const drawn = c((await tx.loanTransaction.aggregate({ where: { loanId: loan.id, type: "DRAWDOWN", status: "POSTED" }, _sum: { principalChange: true } }))._sum.principalChange);
      if (drawn + amount > limit) throw new LedgerError([`Total drawdowns would exceed the loan amount of ${fmt(limit)} (already drawn ${fmt(drawn)})`]);
    }
    if (loan.lastAccrualDate) await accrueTx(tx, loan, input.userId, date);
    else await tx.loan.update({ where: { id: loan.id }, data: { lastAccrualDate: date } });

    const bal = await balancesTx(tx, loan.id);
    const principal = bal.principal + amount, unamortized = bal.unamortized + fees;
    const { rows, eir } = await regenerate(tx, loan, date, principal, principal - unamortized, termsOf(loan));
    const currentChange = currentPortion(rows, date, principal) - bal.current;
    const memo = input.memo?.trim() || `Drawdown${fees ? `, net of ${fmt(fees)} transaction costs` : ""}`;
    const txn = await recordTxn(tx, loan, input.userId, {
      type: "DRAWDOWN", date, memo, principalChange: amount, currentChange, costChange: fees, cashChange: amount - fees,
      details: { bankAccountId: bank.id, fees: fromCentavos(fees), effectiveRate: eir },
    }, [
      ...line(bank.glAccountId, amount - fees, `Loan proceeds from ${loan.lender}`),
      ...line(costAcct(loan), fees, "Transaction costs (amortized at the effective rate)", party(loan)),
      ...line(loan.stAccountId, -currentChange, "Loan payable - current portion", party(loan)),
      ...line(loan.ltAccountId, -(amount - currentChange), "Loan payable - non-current portion", party(loan)),
    ]);
    return txn;
  });
}

// ---------- Payments (cash disbursement vouchers) ----------

/** What is due on `date`: scheduled principal not yet paid, and interest accrued to that date. */
export async function paymentDue(organizationId: string, loanId: string, date: Date) {
  await syncLoanPayments(organizationId, loanId);
  return prisma.$transaction(async (tx) => {
    const loan = await loadLoan(tx, organizationId, loanId);
    const d = asDay(date);
    const bal = await balancesTx(tx, loan.id, undefined, true);
    const rows = await scheduleOf(tx, loan.id);
    const after = rows.filter((r) => r.dueDate > d).reduce((s, r) => s + r.principal, 0n);
    const principal = max(0n, bal.principal - min(bal.principal, after));
    const extra = loan.lastAccrualDate && d > loan.lastAccrualDate ? accrualBetween(rows, loan.lastAccrualDate, d).interest : 0n;
    return { principal, interest: max(0n, bal.accrued + extra), outstanding: bal.principal };
  });
}

export async function createLoanPayment(input: {
  organizationId: string; userId: string; loanId: string; date: Date; bankAccountId?: string | null;
  principal: string; interest: string; method?: string | null; checkNo?: string | null; checkDate?: Date | null; reference?: string | null;
  action?: "draft" | "submit" | "post";
}) {
  await syncLoanPayments(input.organizationId, input.loanId);
  const date = asDay(input.date);
  let principal = 0n, interest = 0n;
  const errors: string[] = [];
  try { principal = toCentavos(input.principal); } catch (e) { errors.push(`Principal: ${(e as Error).message}`); }
  try { interest = toCentavos(input.interest); } catch (e) { errors.push(`Interest: ${(e as Error).message}`); }
  if (principal < 0n || interest < 0n) errors.push("Amounts cannot be negative");
  if (principal + interest <= 0n) errors.push("Enter the principal and/or interest paid");
  if (errors.length) throw new LedgerError(errors);

  // Step 1: accrue interest up to the payment date and work out which accounts the payment settles.
  const plan = await prisma.$transaction(async (tx) => {
    const loan = await loadLoan(tx, input.organizationId, input.loanId);
    if (loan.status !== "ACTIVE") throw new LedgerError(["This loan is already settled"]);
    if (!loan.lastAccrualDate) throw new LedgerError(["Record the drawdown first"]);
    const bank = await bankOf(tx, input.organizationId, input.bankAccountId || loan.bankAccountId);
    await assertNothingLater(tx, loan, date);
    const pre = await balancesTx(tx, loan.id, undefined, true);
    if (principal > pre.principal) throw new LedgerError([`Principal paid is more than the outstanding ${fmt(pre.principal)} (including payments not yet posted)`]);
    await accrueTx(tx, loan, input.userId, date);
    const bal = await balancesTx(tx, loan.id, undefined, true);
    const st = min(principal, max(0n, bal.current));
    const ip = min(interest, max(0n, bal.accrued));
    const lines: CashLine[] = [];
    const add = (accountId: string, amt: bigint, description: string) => {
      if (amt <= 0n) return;
      const same = lines.find((l) => l.accountId === accountId);
      if (same) same.amount = fromCentavos(toCentavos(same.amount) + amt);
      else lines.push({ accountId, amount: fromCentavos(amt), description });
    };
    add(loan.stAccountId, st, `Loan ${loan.number} principal - current portion`);
    add(loan.ltAccountId, principal - st, `Loan ${loan.number} principal - prepayment of non-current portion`);
    add(loan.interestPayableAccountId, ip, `Loan ${loan.number} interest`);
    add(loan.interestExpenseAccountId, interest - ip, `Loan ${loan.number} interest not yet accrued`);
    return { loan, bank, lines };
  });

  // Step 2: the cash disbursement voucher (draft / for approval / posted, per the company's controls).
  const { loan, bank, lines } = plan;
  const v = await saveCashTransaction({
    organizationId: input.organizationId, userId: input.userId, type: "DISBURSEMENT", bankAccountId: bank.id, date,
    payee: loan.lender, partyType: loan.lenderVendorCode ? "VENDOR" : null, partyId: loan.lenderVendorCode,
    method: input.method || "BANK_TRANSFER", checkNo: input.checkNo, checkDate: input.checkDate ?? null,
    reference: input.reference?.trim() || loan.number,
    memo: `Loan ${loan.number} (${loan.lender}) payment: principal ${fmt(principal)}, interest ${fmt(interest)}`,
    lines, action: input.action ?? "submit",
  });
  await prisma.loanTransaction.create({
    data: {
      organizationId: input.organizationId, loanId: loan.id, type: "PAYMENT", date, memo: `Payment ${v.number}`, status: "PENDING",
      cashTransactionId: v.id, createdById: input.userId,
    },
  });
  await syncLoanPayments(input.organizationId, loan.id);
  return v;
}

/** Bring loan payments in line with their cash vouchers: amounts come from the voucher lines;
 *  a posted voucher posts the payment, a voided one voids it. Fully repaid loans are settled. */
export async function syncLoanPayments(organizationId: string, loanId?: string) {
  const pays = await prisma.loanTransaction.findMany({
    where: { organizationId, type: "PAYMENT", status: { in: ["PENDING", "POSTED"] }, cashTransactionId: { not: null }, ...(loanId ? { loanId } : {}) },
  });
  if (!pays.length) return;
  const vouchers = new Map((await prisma.cashTransaction.findMany({ where: { id: { in: pays.map((p) => p.cashTransactionId!) } } })).map((v) => [v.id, v]));
  const touched = new Set<string>();
  for (const p of pays) {
    const v = vouchers.get(p.cashTransactionId!);
    if (!v) continue;
    const want = v.status === "VOID" ? "VOID" : v.status === "POSTED" ? "POSTED" : "PENDING";
    if (want === p.status && want !== "PENDING") continue;
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: p.loanId } });
    const sum = (aid: string) => (v.lines as CashLine[]).filter((l) => l.accountId === aid).reduce((s, l) => s + toCentavos(l.amount), 0n);
    const st = sum(loan.stAccountId), lt = sum(loan.ltAccountId), ip = sum(loan.interestPayableAccountId), ie = sum(loan.interestExpenseAccountId);
    const data = {
      status: want, date: v.date, journalEntryId: v.journalEntryId, principalChange: dec(-(st + lt)), currentChange: dec(-st),
      accruedChange: dec(-ip), interestExpense: dec(ie), cashChange: dec(-c(v.amount)), memo: `Payment ${v.number}`,
    };
    const changed = want !== p.status || c(p.principalChange) !== -(st + lt) || c(p.currentChange) !== -st || c(p.accruedChange) !== -ip || c(p.interestExpense) !== ie || p.date.getTime() !== v.date.getTime();
    if (!changed) continue;
    await prisma.loanTransaction.update({ where: { id: p.id }, data });
    if (want !== p.status) await prisma.auditLog.create({ data: { organizationId, userId: null, action: `loan.payment_${want.toLowerCase()}`, entity: "loan", entityId: loan.id, details: { number: loan.number, voucher: v.number } } });
    touched.add(loan.id);
  }
  for (const id of touched) await settleIfRepaid(organizationId, id);
}

/** Once the principal is fully repaid, write off any unamortized transaction costs and close the loan. */
async function settleIfRepaid(organizationId: string, loanId: string) {
  await prisma.$transaction(async (tx) => {
    const loan = await loadLoan(tx, organizationId, loanId);
    const bal = await balancesTx(tx, loanId);
    if (loan.status === "ACTIVE" && bal.principal <= 0n) {
      const last = await tx.loanTransaction.findFirst({ where: { loanId, status: "POSTED", type: "PAYMENT" }, orderBy: { date: "desc" } });
      const date = last?.date ?? asDay(new Date());
      if (bal.unamortized !== 0n || bal.current !== 0n) {
        await recordTxn(tx, loan, loan.createdById, { type: "WRITE_OFF", date, memo: "Loan fully repaid: unamortized transaction costs written off", costChange: -bal.unamortized, interestExpense: bal.unamortized, currentChange: -bal.current }, [
          ...line(loan.interestExpenseAccountId, bal.unamortized, "Unamortized transaction costs on settlement"),
          ...line(costAcct(loan), -bal.unamortized, "Unamortized transaction costs on settlement", party(loan)),
          ...line(loan.stAccountId, bal.current, "Clear current portion", party(loan)),
          ...line(loan.ltAccountId, -bal.current, "Clear non-current portion", party(loan)),
        ]);
      }
      await tx.loan.update({ where: { id: loanId }, data: { status: "SETTLED" } });
    } else if (loan.status === "SETTLED" && bal.principal > 0n) {
      // A payment was voided after settlement: undo the write-off and reopen.
      const wo = await tx.loanTransaction.findFirst({ where: { loanId, status: "POSTED", type: "WRITE_OFF" }, orderBy: { createdAt: "desc" } });
      if (wo?.journalEntryId) await voidOrReverseTx(tx, organizationId, loan.createdById, wo.journalEntryId, undefined, true);
      if (wo) await tx.loanTransaction.update({ where: { id: wo.id }, data: { status: "VOID" } });
      await tx.loan.update({ where: { id: loanId }, data: { status: "ACTIVE" } });
    }
  });
}

// ---------- Current / non-current reclassification ----------

export type ReclassRow = { loan: Loan; principal: bigint; current: bigint; target: bigint; change: bigint; breached: boolean };

async function reclassPlan(tx: Tx, loan: Loan, asOf: Date, breached: boolean): Promise<ReclassRow> {
  const bal = await balancesTx(tx, loan.id, asOf);
  const target = breached ? bal.principal : currentPortion(await scheduleOf(tx, loan.id), asOf, bal.principal);
  return { loan, principal: bal.principal, current: bal.current, target, change: target - bal.current, breached };
}

/** Preview (post = false) or post the true-up of each loan's current portion as of `asOf`.
 *  Loans with an unwaived covenant breach at the reporting date are classified current in full (PAS 1.74). */
export async function reclassify(organizationId: string, userId: string, asOf: Date, post: boolean, loanIds?: string[]) {
  const d = asDay(asOf);
  await syncLoanPayments(organizationId);
  const cov = await evaluateCovenants(organizationId, d);
  const breached = new Set(cov.filter((x) => x.classifyCurrent).map((x) => x.covenant.loanId));
  return prisma.$transaction(async (tx) => {
    const loans = await tx.loan.findMany({ where: { organizationId, status: "ACTIVE", ...(loanIds ? { id: { in: loanIds } } : {}) }, orderBy: { number: "asc" } });
    const out: ReclassRow[] = [];
    for (const loan of loans) {
      if (!loan.lastAccrualDate) continue;
      const r = await reclassPlan(tx, loan, d, breached.has(loan.id));
      out.push(r);
      if (post && r.change !== 0n) {
        await assertNothingLater(tx, loan, d);
        await recordTxn(tx, loan, userId, {
          type: "RECLASS", date: d, memo: r.breached ? "Covenant breach: whole loan classified as current" : "Principal due within 12 months reclassified to current",
          currentChange: r.change, details: { target: fromCentavos(r.target), breached: r.breached },
        }, [
          ...line(loan.ltAccountId, r.change, "Non-current portion", party(loan)),
          ...line(loan.stAccountId, -r.change, "Current portion", party(loan)),
        ]);
      }
    }
    return out;
  });
}

/** Period-end: accrue interest on every active loan to `asOf`, then reclassify current portions. */
export async function runPeriodEnd(organizationId: string, userId: string, asOf: Date) {
  const d = asDay(asOf);
  await syncLoanPayments(organizationId);
  const accrued = await prisma.$transaction(async (tx) => {
    const loans = await tx.loan.findMany({ where: { organizationId, status: "ACTIVE", lastAccrualDate: { lt: d } } });
    let n = 0;
    for (const l of loans) if (await accrueTx(tx, l, userId, d)) n++;
    return n;
  });
  const reclass = await reclassify(organizationId, userId, d, true);
  return { accrued, reclassified: reclass.filter((r) => r.change !== 0n).length };
}

// ---------- Modification (PFRS 9 3.3.2, B3.3.6, 5.4.3) ----------

export type ModificationInput = {
  organizationId: string; userId: string; loanId: string; date: Date;
  kind: "TERMS" | "REPRICING"; // TERMS: 10% test; REPRICING: floating-rate reset / re-amortization, prospective EIR change
  interestRate: string; maturityDate: Date; paymentFrequency: string; repaymentType: string; firstPaymentDate?: Date | null;
  fees?: string | null; bankAccountId?: string | null; gainLossAccountId?: string | null; reason: string;
};

export async function previewModification(input: ModificationInput) {
  await syncLoanPayments(input.organizationId, input.loanId);
  return prisma.$transaction((tx) => modificationPlan(tx, input, false)); // reads only; accrual happens on posting
}

async function modificationPlan(tx: Tx, input: ModificationInput, post: boolean) {
  const loan = await loadLoan(tx, input.organizationId, input.loanId);
  const date = asDay(input.date);
  const errors: string[] = [];
  if (loan.status !== "ACTIVE") errors.push("This loan is already settled");
  if (!loan.lastAccrualDate) errors.push("Record the drawdown first");
  if (!input.reason?.trim()) errors.push("Enter the reason (e.g. restructuring agreement, rate reset notice)");
  const rate = Number(input.interestRate);
  if (!(rate >= 0 && rate < 100) || String(input.interestRate ?? "").trim() === "") errors.push("Enter the new annual interest rate");
  const maturity = asDay(input.maturityDate);
  if (!(maturity > date)) errors.push("The new maturity date must be after the modification date");
  if (!(FREQUENCIES as readonly string[]).includes(input.paymentFrequency)) errors.push("Choose the payment frequency");
  if (!(REPAYMENTS as readonly string[]).includes(input.repaymentType)) errors.push("Choose how principal is repaid");
  const first = input.firstPaymentDate ? asDay(input.firstPaymentDate) : null;
  if (first && (first <= date || first > maturity)) errors.push("The first payment date must be after the modification date and not after maturity");
  let fees = 0n;
  try { fees = toCentavos(input.fees); } catch (e) { errors.push(`Fees: ${(e as Error).message}`); }
  if (fees < 0n) errors.push("Fees cannot be negative");
  if (errors.length) throw new LedgerError(errors);
  if (await tx.loanTransaction.count({ where: { loanId: loan.id, status: "PENDING" } })) throw new LedgerError(["Post or void this loan's pending payment vouchers first"]);
  await assertNothingLater(tx, loan, date, true);
  const bank = fees > 0n ? await bankOf(tx, input.organizationId, input.bankAccountId || loan.bankAccountId) : null;
  const gainLoss = input.gainLossAccountId || loan.interestExpenseAccountId;
  if (input.gainLossAccountId && !(await tx.account.findFirst({ where: { id: gainLoss, organizationId: input.organizationId, isPostable: true, type: { in: ["EXPENSE", "INCOME"] } } })))
    throw new LedgerError(["Choose an income or expense account for the modification gain or loss"]);

  if (post) await accrueTx(tx, loan, input.userId, date);
  const bal = await balancesTx(tx, loan.id, date);
  if (bal.principal <= 0n) throw new LedgerError(["Nothing is outstanding on this loan"]);
  const m = monthsOf(input.paymentFrequency);
  const terms: Terms = {
    rate, dayCount: loan.dayCount as DayCount, frequency: input.paymentFrequency as Frequency, repaymentType: input.repaymentType as RepaymentType,
    anchor: first ?? (m ? addMonths(date, m) : maturity), maturityDate: maturity, principalFrom: null,
  };
  const oldCarrying = bal.principal - bal.unamortized;
  const oldEir = Number(loan.effectiveRate ?? loan.interestRate);
  const nominal = buildSchedule(date, bal.principal, bal.principal, terms).rows;
  const pvNew = presentValue(nominal, oldEir, terms.dayCount);
  let substantial = false, pct = 0, gainLossAmt = 0n, newCarrying: bigint;
  if (input.kind === "REPRICING") {
    newCarrying = oldCarrying - fees;
  } else {
    ({ pct, substantial } = tenPercentTest(oldCarrying, pvNew, fees));
    if (substantial) {
      gainLossAmt = bal.unamortized + fees; // derecognize old liability; new one at its principal (market terms)
      newCarrying = bal.principal;
    } else {
      gainLossAmt = pvNew - oldCarrying;    // PFRS 9 5.4.3: adjust to PV at the original EIR
      newCarrying = pvNew - fees;
    }
  }
  const newUnamortized = bal.principal - newCarrying;
  const after = buildSchedule(date, bal.principal, newCarrying, terms);
  const currentChange = currentPortion(after.rows, date, bal.principal) - bal.current;
  return {
    loan, date, bank, gainLoss, terms, bal, fees, pvNew, oldCarrying, oldEir, newEir: after.eir, newCarrying, newUnamortized,
    substantial, pct, gainLossAmt, currentChange, costChange: newUnamortized - bal.unamortized, rows: after.rows,
  };
}

export async function modifyLoan(input: ModificationInput) {
  await syncLoanPayments(input.organizationId, input.loanId);
  return prisma.$transaction(async (tx) => {
    const p = await modificationPlan(tx, input, true);
    const { loan } = p;
    const old = { interestRate: loan.interestRate.toString(), maturityDate: ymd(loan.maturityDate), paymentFrequency: loan.paymentFrequency, repaymentType: loan.repaymentType, effectiveRate: p.oldEir };
    const label = input.kind === "REPRICING" ? "Rate reset / re-amortization" : p.substantial ? "Substantial modification: old loan derecognized, new loan recognized" : "Non-substantial modification";
    const updated = await tx.loan.update({
      where: { id: loan.id },
      data: { interestRate: new Prisma.Decimal(String(p.terms.rate)), maturityDate: p.terms.maturityDate, paymentFrequency: p.terms.frequency, repaymentType: p.terms.repaymentType, firstPaymentDate: p.terms.anchor, graceMonths: 0, updatedById: input.userId },
    });
    await regenerate(tx, updated, p.date, p.bal.principal, p.newCarrying, p.terms);
    const costSide = p.costChange; // debit (+) / credit (-) to the unamortized cost account
    return recordTxn(tx, updated, input.userId, {
      type: "MODIFICATION", date: p.date, memo: `${label}. ${input.reason.trim()}`, costChange: p.costChange, currentChange: p.currentChange,
      interestExpense: p.gainLossAmt, cashChange: -p.fees,
      details: {
        kind: input.kind, substantial: p.substantial, tenPercentTest: p.pct, oldCarrying: fromCentavos(p.oldCarrying), pvAtOriginalEir: fromCentavos(p.pvNew),
        gainLoss: fromCentavos(p.gainLossAmt), fees: fromCentavos(p.fees), newEffectiveRate: p.newEir, old, reason: input.reason.trim(),
      },
    }, [
      ...line(p.gainLoss, p.gainLossAmt, p.gainLossAmt >= 0n ? "Loss on loan modification" : "Gain on loan modification"),
      ...line(costAcct(loan), costSide, "Adjustment to unamortized transaction costs", party(loan)),
      ...(p.bank ? line(p.bank.glAccountId, -p.fees, "Modification fees paid") : []),
      ...line(loan.ltAccountId, p.currentChange, "Non-current portion", party(loan)),
      ...line(loan.stAccountId, -p.currentChange, "Current portion", party(loan)),
    ]);
  });
}

// ---------- Undo ----------

/** Reverse the latest accrual or reclassification, or a drawdown that has nothing after it. */
export async function reverseLoanTransaction(organizationId: string, userId: string, loanId: string, txnId: string) {
  return prisma.$transaction(async (tx) => {
    const loan = await loadLoan(tx, organizationId, loanId);
    const t = await tx.loanTransaction.findFirst({ where: { id: txnId, loanId, status: "POSTED" } });
    if (!t) throw new LedgerError(["Transaction not found"]);
    if (!["ACCRUAL", "RECLASS", "DRAWDOWN"].includes(t.type)) throw new LedgerError([t.type === "PAYMENT" ? "Void the payment voucher in Cash and Bank instead" : "This transaction cannot be undone; record a new modification instead"]);
    const latest = await tx.loanTransaction.findFirst({ where: { loanId, status: { in: ["POSTED", "PENDING"] } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }] });
    if (latest?.id !== t.id) throw new LedgerError(["Only the latest transaction of a loan can be undone"]);
    if (t.journalEntryId) await voidOrReverseTx(tx, organizationId, userId, t.journalEntryId, undefined, true);
    await tx.loanTransaction.update({ where: { id: t.id }, data: { status: "VOID" } });
    if (t.type === "ACCRUAL" || t.type === "DRAWDOWN") {
      const prev = await tx.loanTransaction.findFirst({ where: { loanId, status: "POSTED", type: { in: ["ACCRUAL", "DRAWDOWN", "MODIFICATION"] } }, orderBy: { date: "desc" } });
      const detailsFrom = t.type === "ACCRUAL" ? (t.details as { from?: string } | null)?.from : null;
      await tx.loan.update({ where: { id: loanId }, data: { lastAccrualDate: detailsFrom ? asDay(detailsFrom) : prev?.date ?? null } });
      if (t.type === "DRAWDOWN") {
        const drawn = await tx.loanTransaction.count({ where: { loanId, status: "POSTED", type: "DRAWDOWN" } });
        if (drawn) throw new LedgerError(["Only a loan's single drawdown can be undone; record a modification instead"]);
        await tx.loanScheduleLine.deleteMany({ where: { loanId } });
        await tx.loan.update({ where: { id: loanId }, data: { lastAccrualDate: null, effectiveRate: null } });
      }
    }
    await audit(tx, organizationId, userId, "loan.undo", loan.id, { number: loan.number, type: t.type, date: ymd(t.date) }, null, null, "loan");
  });
}

// ---------- Covenants ----------

export const METRICS: Record<string, { label: string; unit: "x" | "peso" }> = {
  CURRENT_RATIO: { label: "Current ratio (current assets / current liabilities)", unit: "x" },
  DEBT_TO_EQUITY: { label: "Debt to equity (loans outstanding / equity)", unit: "x" },
  LIABILITIES_TO_EQUITY: { label: "Total liabilities to equity", unit: "x" },
  INTEREST_COVERAGE: { label: "Interest coverage (EBIT / interest expense, last 12 months)", unit: "x" },
  DSCR: { label: "Debt service coverage (EBITDA / principal + interest paid, last 12 months)", unit: "x" },
  NET_DEBT_TO_EBITDA: { label: "Net debt to EBITDA (last 12 months)", unit: "x" },
  MIN_NET_WORTH: { label: "Minimum net worth (total equity)", unit: "peso" },
  MANUAL: { label: "Other (value entered manually)", unit: "x" },
};

export type CovenantInput = {
  organizationId: string; userId: string; loanId: string; name: string; metric: string; operator: string; threshold: string;
  frequency?: string; manualValue?: string | null; waiverUntil?: Date | null; notes?: string | null;
};

export async function saveCovenant(input: CovenantInput, id?: string) {
  const errors: string[] = [];
  if (!input.name?.trim()) errors.push("Enter the covenant name (as written in the loan agreement)");
  if (!METRICS[input.metric]) errors.push("Choose what is measured");
  if (!["MIN", "MAX"].includes(input.operator)) errors.push("Choose minimum or maximum");
  if (!Number.isFinite(Number(input.threshold)) || String(input.threshold ?? "").trim() === "") errors.push("Enter the threshold");
  const manual = input.manualValue?.trim() ? input.manualValue.trim() : null;
  if (manual && !Number.isFinite(Number(manual))) errors.push("The manual value must be a number");
  if (errors.length) throw new LedgerError(errors);
  return prisma.$transaction(async (tx) => {
    await loadLoan(tx, input.organizationId, input.loanId);
    const data = {
      name: input.name.trim(), metric: input.metric, operator: input.operator, threshold: new Prisma.Decimal(String(Number(input.threshold))),
      frequency: input.frequency || "QUARTERLY", manualValue: manual ? new Prisma.Decimal(manual) : null,
      waiverUntil: input.waiverUntil ? asDay(input.waiverUntil) : null, notes: input.notes?.trim() || null,
    };
    if (id) {
      const cur = await tx.loanCovenant.findFirst({ where: { id, organizationId: input.organizationId } });
      if (!cur) throw new LedgerError(["Covenant not found"]);
      await tx.loanCovenant.update({ where: { id }, data });
    } else await tx.loanCovenant.create({ data: { ...data, organizationId: input.organizationId, loanId: input.loanId } });
    await audit(tx, input.organizationId, input.userId, id ? "loan.covenant_update" : "loan.covenant_add", input.loanId, { name: data.name }, null, null, "loan");
  });
}

export async function deleteCovenant(organizationId: string, userId: string, id: string) {
  await prisma.$transaction(async (tx) => {
    const cv = await tx.loanCovenant.findFirst({ where: { id, organizationId } });
    if (!cv) throw new LedgerError(["Covenant not found"]);
    await tx.loanCovenant.update({ where: { id }, data: { isActive: false } });
    await audit(tx, organizationId, userId, "loan.covenant_remove", cv.loanId, { name: cv.name }, null, null, "loan");
  });
}

/** Company-level ratios used by covenants, as of `asOf` (income figures: the 12 months to `asOf`). */
export async function covenantMetrics(organizationId: string, asOf: Date) {
  const d = asDay(asOf);
  const from = new Date(addMonths(d, -12).getTime() + 86_400_000);
  const [bs, is, { loans, balances }, pays, interest] = await Promise.all([
    balanceSheet(organizationId, d), incomeStatement(organizationId, from, d), loanBalances(organizationId, d),
    prisma.loanTransaction.aggregate({ where: { organizationId, type: "PAYMENT", status: "POSTED", date: { gte: from, lte: d } }, _sum: { principalChange: true, accruedChange: true, interestExpense: true } }),
    prisma.loanTransaction.aggregate({ where: { organizationId, type: { in: ["ACCRUAL", "PAYMENT"] }, status: "POSTED", date: { gte: from, lte: d } }, _sum: { interestExpense: true } }),
  ]);
  const debt = loans.reduce((s, l) => s + (balances.get(l.id)?.principal ?? 0n), 0n);
  const cash = bs.ca.lines.find((l) => l.label === "Cash and cash equivalents")?.amount ?? 0n;
  const interestExp = c(interest._sum.interestExpense) || is.finCost.total;
  const ebit = is.profitBeforeTax + is.finCost.total;
  const da = [...is.cos.lines, ...is.opex.lines, ...is.otherExp.lines].flatMap((l) => l.accounts ?? []).filter((a) => /depreciation|amortization/i.test(a.name)).reduce((s, a) => s + a.amount, 0n);
  const ebitda = ebit + da;
  const service = -c(pays._sum.principalChange) - c(pays._sum.accruedChange) + c(pays._sum.interestExpense);
  const r = (a: bigint, b: bigint) => (b === 0n ? null : Number(a) / Number(b));
  const values: Record<string, number | null> = {
    CURRENT_RATIO: r(bs.ca.total, bs.cl.total),
    DEBT_TO_EQUITY: r(debt, bs.equity.total),
    LIABILITIES_TO_EQUITY: r(bs.totalLiabilities, bs.equity.total),
    INTEREST_COVERAGE: r(ebit, interestExp),
    DSCR: r(ebitda, service),
    NET_DEBT_TO_EBITDA: ebitda <= 0n ? null : r(debt - cash, ebitda),
    MIN_NET_WORTH: Number(bs.equity.total) / 100,
  };
  return { values, parts: { debt, cash, equity: bs.equity.total, ebit, ebitda, da, interest: interestExp, debtService: service, ca: bs.ca.total, cl: bs.cl.total, liabilities: bs.totalLiabilities }, from, to: d };
}

export type CovenantResult = {
  covenant: Prisma.LoanCovenantGetPayload<object>; loan: Loan; value: number | null;
  status: "PASS" | "WATCH" | "BREACH" | "WAIVED" | "NO_DATA"; headroomPct: number | null; classifyCurrent: boolean;
};

export async function evaluateCovenants(organizationId: string, asOf: Date) {
  const covs = await prisma.loanCovenant.findMany({ where: { organizationId, isActive: true }, include: { loan: true }, orderBy: [{ loanId: "asc" }, { name: "asc" }] });
  const live = covs.filter((x) => x.loan.status === "ACTIVE");
  if (!live.length) return [] as CovenantResult[];
  const m = await covenantMetrics(organizationId, asOf);
  const d = asDay(asOf);
  return live.map(({ loan, ...cv }): CovenantResult => {
    const value = cv.metric === "MANUAL" ? (cv.manualValue === null ? null : Number(cv.manualValue)) : m.values[cv.metric] ?? null;
    const t = Number(cv.threshold);
    if (value === null) return { covenant: cv, loan, value, status: "NO_DATA", headroomPct: null, classifyCurrent: false };
    const room = cv.operator === "MIN" ? value - t : t - value;
    const headroomPct = t === 0 ? null : Math.round((room / Math.abs(t)) * 10000) / 100;
    let status: CovenantResult["status"] = room < 0 ? "BREACH" : headroomPct !== null && headroomPct < 10 ? "WATCH" : "PASS";
    let classifyCurrent = status === "BREACH";
    if (status === "BREACH" && cv.waiverUntil && cv.waiverUntil >= d) {
      status = "WAIVED";
      // A waiver obtained by the reporting date for at least 12 months keeps the loan non-current (PAS 1.75).
      classifyCurrent = cv.waiverUntil < addMonths(d, 12);
    }
    return { covenant: cv, loan, value, status, headroomPct, classifyCurrent };
  });
}

// ---------- Reports ----------

export type RowStatus = "PAID" | "PARTIAL" | "OVERDUE" | "DUE" | "UPCOMING";

/** Schedule rows with paid / overdue status as of `asOf` (payments applied oldest installment first). */
export async function amortizationTable(organizationId: string, loanId: string, asOf: Date) {
  await syncLoanPayments(organizationId, loanId);
  const d = asDay(asOf);
  const loan = await prisma.loan.findFirst({ where: { id: loanId, organizationId } });
  if (!loan) throw new LedgerError(["Loan not found"]);
  const [rows, paid] = await Promise.all([
    prisma.$transaction((tx) => scheduleOf(tx, loanId)),
    prisma.loanTransaction.aggregate({ where: { loanId, type: "PAYMENT", status: "POSTED", date: { lte: d } }, _sum: { principalChange: true, accruedChange: true, interestExpense: true } }),
  ]);
  // Principal and interest paid are applied separately, each to the oldest installment first.
  let poolP = -c(paid._sum.principalChange), poolI = -c(paid._sum.accruedChange) + c(paid._sum.interestExpense);
  const out = rows.map((r) => {
    const ap = min(max(poolP, 0n), r.principal), ai = min(max(poolI, 0n), r.interest);
    poolP -= ap; poolI -= ai;
    const unpaidPrincipal = r.principal - ap, unpaidInterest = r.interest - ai, unpaid = unpaidPrincipal + unpaidInterest;
    const status: RowStatus = unpaid === 0n ? "PAID" : r.dueDate < d ? (ap + ai > 0n ? "PARTIAL" : "OVERDUE") : r.dueDate.getTime() === d.getTime() ? "DUE" : "UPCOMING";
    return { ...r, paid: ap + ai, unpaid, unpaidPrincipal, unpaidInterest, status, daysPastDue: r.dueDate < d && unpaid > 0n ? Math.round((d.getTime() - r.dueDate.getTime()) / 86_400_000) : 0 };
  });
  return { loan, rows: out };
}

export const MATURITY_BUCKETS = ["Overdue", "Within 3 months", "3 to 12 months", "1 to 2 years", "2 to 5 years", "Over 5 years"] as const;
export const OVERDUE_BUCKETS = ["1-30 days", "31-60 days", "61-90 days", "91-180 days", "Over 180 days"] as const;

/** Debt aging: outstanding principal and contractual interest by when it falls due (PFRS 7.39 maturity analysis),
 *  plus unpaid installments by days past due. */
export async function debtAging(organizationId: string, asOf: Date) {
  const d = asDay(asOf);
  const { loans, balances } = await loanBalances(organizationId, d);
  const result = [];
  for (const loan of loans) {
    const bal = balances.get(loan.id)!;
    if (bal.principal === 0n && bal.accrued === 0n) continue;
    const { rows } = await amortizationTable(organizationId, loan.id, d);
    const principal = MATURITY_BUCKETS.map(() => 0n), interest = MATURITY_BUCKETS.map(() => 0n), overdue = OVERDUE_BUCKETS.map(() => 0n);
    let leftP = bal.principal;
    for (const r of rows) {
      if (r.unpaid === 0n) continue;
      const rowPrin = min(leftP, r.unpaidPrincipal); // capped at what is outstanding
      leftP -= rowPrin;
      const rowInt = r.unpaidInterest;
      let b: number;
      if (r.dueDate < d) {
        b = 0;
        const dpd = r.daysPastDue;
        overdue[dpd <= 30 ? 0 : dpd <= 60 ? 1 : dpd <= 90 ? 2 : dpd <= 180 ? 3 : 4] += rowPrin + rowInt;
      } else if (r.dueDate <= addMonths(d, 3)) b = 1;
      else if (r.dueDate <= addMonths(d, 12)) b = 2;
      else if (r.dueDate <= addMonths(d, 24)) b = 3;
      else if (r.dueDate <= addMonths(d, 60)) b = 4;
      else b = 5;
      principal[b] += rowPrin;
      interest[b] += rowInt;
    }
    if (leftP > 0n) principal[0] += leftP; // past maturity / not on the schedule
    result.push({ loan, balance: bal, principal, interest, overdue, nextDue: rows.find((r) => r.unpaid > 0n && r.dueDate >= d) ?? null });
  }
  return result;
}

/** Debt schedule: every loan's balances as of `asOf`, and a tie-out of the loan accounts to the GL. */
export async function debtSchedule(organizationId: string, asOf: Date) {
  const d = asDay(asOf);
  const { loans, balances } = await loanBalances(organizationId, d);
  const movement = await prisma.loanTransaction.groupBy({
    by: ["loanId", "type"], where: { organizationId, status: "POSTED", date: { lte: d } }, _sum: { principalChange: true, interestExpense: true },
  });
  const sumOf = (loanId: string, type: string, f: "principalChange" | "interestExpense") => c(movement.find((m) => m.loanId === loanId && m.type === type)?._sum[f]);
  const rows = loans.filter((l) => balances.get(l.id)!.principal !== 0n || l.status === "ACTIVE").map((l) => ({
    loan: l, bal: balances.get(l.id)!, drawn: sumOf(l.id, "DRAWDOWN", "principalChange"), repaid: -sumOf(l.id, "PAYMENT", "principalChange"),
  }));
  // GL tie-out by account: sub-ledger expectation vs posted GL balance (credit positive).
  const expect = new Map<string, bigint>();
  const addE = (id: string, v: bigint) => expect.set(id, (expect.get(id) ?? 0n) + v);
  for (const r of rows) {
    addE(r.loan.stAccountId, r.bal.current);
    addE(r.loan.ltAccountId, r.bal.nonCurrent);
    addE(costAcct(r.loan), -r.bal.unamortized);
    addE(r.loan.interestPayableAccountId, r.bal.accrued);
  }
  const ids = [...expect.keys()];
  const [accts, gl] = await Promise.all([
    prisma.account.findMany({ where: { id: { in: ids } } }),
    prisma.journalLine.groupBy({ by: ["accountId"], where: { organizationId, accountId: { in: ids }, journalEntry: { status: "POSTED", book: "STATUTORY", date: { lte: d } } }, _sum: { debit: true, credit: true } }),
  ]);
  const tieOut = accts.sort((a, b) => a.code.localeCompare(b.code)).map((a) => {
    const g = gl.find((x) => x.accountId === a.id);
    const glBal = c(g?._sum.credit) - c(g?._sum.debit);
    return { account: a, subledger: expect.get(a.id) ?? 0n, gl: glBal, difference: glBal - (expect.get(a.id) ?? 0n) };
  });
  return { rows, tieOut };
}
