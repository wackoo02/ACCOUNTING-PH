// Payment vouchers to suppliers. Draft -> approval matrix -> released: the last approval creates a posted
// cash disbursement (check or transfer) that debits Accounts Payable per bill, so the check appears in
// check monitoring and the bank reconciliation. EWT was already withheld on the bill; BIR Form 2307 data
// for the payment comes from the bills it settles.
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { LedgerError, asDay, audit, nextNumber } from "../ledger/service";
import { approveLevel, recordReturn, recordSubmission } from "../approvals";
import { postSubledgerDisbursementTx, voidCashTx, isBank } from "../bank/cash";
import { fromCentavos, toCentavos } from "../money";
import type { LineInput } from "../ledger/validate";
import { quarterOf, roundDiv } from "./compute";
import { type Tx, cents, dec, q4of, roleAccount, withFxDifference } from "./common";
import { openBalances } from "./bills";

export type PaymentInput = {
  organizationId: string; userId: string; vendorId: string; bankAccountId: string; date: Date; method: string;
  checkNo?: string | null; checkDate?: Date | null; reference?: string | null; memo?: string | null; fxRate?: string | null;
  lines: { billId: string; amount: string }[]; action?: "draft" | "submit";
};

const snap = (x: unknown) => JSON.parse(JSON.stringify(x)) as Prisma.InputJsonValue;
export const paymentBaseTotal = (p: { amount: Prisma.Decimal; fxRate: Prisma.Decimal }) => roundDiv(cents(p.amount) * q4of(p.fxRate), 10000n);

async function prepare(tx: Tx, input: PaymentInput, selfId?: string) {
  const errors: string[] = [];
  const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
  const vendor = await tx.vendor.findFirst({ where: { id: input.vendorId, organizationId: input.organizationId } });
  if (!vendor) throw new LedgerError(["Choose the supplier"]);
  const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, organizationId: input.organizationId, isActive: true } });
  if (!bank) throw new LedgerError(["Choose the bank or cash account to pay from"]);
  const method = (input.method || "CHECK").toUpperCase();
  if (method === "CHECK" && !isBank(bank.kind)) errors.push("Checks can only be drawn on a bank account");
  const foreign = bank.currencyCode !== org.baseCurrency;
  const fxRate = foreign ? (input.fxRate || "").trim() : "1";
  if (foreign && !(Number(fxRate) > 0)) errors.push(`Enter today's exchange rate for ${bank.currencyCode}`);
  const lines = input.lines.filter((l) => String(l.amount ?? "").trim() && toCentavosSafe(l.amount) !== 0n);
  if (!lines.length) errors.push("Choose at least one bill to pay");
  const bills = await tx.apBill.findMany({ where: { organizationId: input.organizationId, id: { in: lines.map((l) => l.billId) } } });
  const paid = await openBalances(tx, input.organizationId, bills.map((b) => b.id), selfId);
  let total = 0n;
  const rows = lines.map((l) => {
    const b = bills.find((x) => x.id === l.billId);
    if (!b) { errors.push("A bill was not found"); return { billId: l.billId, amount: dec(0n) }; }
    if (b.vendorId !== vendor.id) errors.push(`${b.number} is from a different supplier`);
    if (b.status !== "POSTED") errors.push(`${b.number} is not yet approved and posted`);
    if (b.onHold) errors.push(`${b.number} is on hold for payment`);
    if (b.currencyCode !== bank.currencyCode) errors.push(`${b.number} is in ${b.currencyCode}; pay it from a ${b.currencyCode} account`);
    let amt = 0n;
    try { amt = toCentavos(l.amount); } catch (e) { errors.push(`${b.number}: ${(e as Error).message}`); }
    const open = cents(b.netPayable) - (paid.get(b.id) ?? 0n);
    if (amt <= 0n) errors.push(`${b.number}: enter a positive amount`);
    else if (amt > open) errors.push(`${b.number}: ${fromCentavos(amt)} is more than the unpaid balance of ${fromCentavos(open)} (other payment vouchers included)`);
    total += amt;
    return { billId: b.id, amount: dec(amt) };
  });
  if (errors.length) throw new LedgerError(errors);
  const numbers = bills.map((b) => b.supplierInvoiceNo).join(", ");
  return {
    total, rows,
    head: {
      vendorId: vendor.id, bankAccountId: bank.id, date: asDay(input.date), method, checkNo: input.checkNo?.trim() || null, checkDate: input.checkDate ? asDay(input.checkDate) : null,
      reference: input.reference?.trim() || null, memo: input.memo?.trim() || `Payment of invoice ${numbers}`.slice(0, 300), currencyCode: bank.currencyCode, fxRate: new Prisma.Decimal(fxRate || "1"), amount: dec(total),
    },
  };
}
const toCentavosSafe = (s: string) => { try { return toCentavos(s); } catch { return 1n; } };

export async function savePayment(input: PaymentInput, id?: string) {
  return prisma.$transaction(async (tx) => {
    const p = await prepare(tx, input, id);
    let pid: string;
    if (id) {
      const cur = await tx.apPayment.findFirst({ where: { id, organizationId: input.organizationId }, include: { lines: true } });
      if (!cur) throw new LedgerError(["Payment voucher not found"]);
      if (cur.status !== "DRAFT") throw new LedgerError(["Only drafts can be edited"]);
      await tx.apPaymentLine.deleteMany({ where: { paymentId: id } });
      await tx.apPayment.update({ where: { id }, data: { ...p.head, updatedById: input.userId, lines: { create: p.rows } } });
      await audit(tx, input.organizationId, input.userId, "payment.update", id, { number: cur.number }, snap(cur), null, "ap_payment");
      pid = id;
    } else {
      const number = await nextNumber(tx, input.organizationId, "PV", p.head.date.getUTCFullYear());
      const r = await tx.apPayment.create({ data: { ...p.head, organizationId: input.organizationId, number, createdById: input.userId, lines: { create: p.rows } } });
      await audit(tx, input.organizationId, input.userId, "payment.create", r.id, { number }, null, null, "ap_payment");
      pid = r.id;
    }
    if (input.action === "submit") await submitPaymentTx(tx, input.organizationId, input.userId, pid);
    return tx.apPayment.findUniqueOrThrow({ where: { id: pid } });
  });
}

async function loadPayment(tx: Tx, organizationId: string, id: string) {
  const p = await tx.apPayment.findFirst({ where: { id, organizationId }, include: { lines: { include: { bill: true } } } });
  if (!p) throw new LedgerError(["Payment voucher not found"]);
  return p;
}

async function submitPaymentTx(tx: Tx, organizationId: string, userId: string, id: string) {
  const p = await loadPayment(tx, organizationId, id);
  if (p.status !== "DRAFT") throw new LedgerError(["Only drafts can be submitted"]);
  await tx.apPayment.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedById: userId, submittedAt: new Date(), rejectReason: null } });
  await recordSubmission(tx, organizationId, "PAYMENT", id, userId);
  await audit(tx, organizationId, userId, "payment.submit", id, { number: p.number }, null, null, "ap_payment");
}
export const submitPayment = (organizationId: string, userId: string, id: string) => prisma.$transaction((tx) => submitPaymentTx(tx, organizationId, userId, id));

/** One approval level; the last one releases the payment (posted disbursement). */
export async function approvePayment(organizationId: string, userId: string, id: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    const p = await loadPayment(tx, organizationId, id);
    if (p.status !== "PENDING_APPROVAL") throw new LedgerError(["This payment voucher is not waiting for approval"]);
    const done = await approveLevel(tx, { organizationId, docType: "PAYMENT", docId: id, userId, total: paymentBaseTotal(p), preparerIds: [p.createdById, p.submittedById, p.updatedById], comment });
    if (!done) { await audit(tx, organizationId, userId, "payment.approve_level", id, { number: p.number }, null, null, "ap_payment"); return null; }
    // Re-validate balances (another voucher may have been released meanwhile).
    await prepare(tx, { organizationId, userId, vendorId: p.vendorId, bankAccountId: p.bankAccountId, date: p.date, method: p.method, checkNo: p.checkNo, checkDate: p.checkDate, reference: p.reference, memo: p.memo, fxRate: p.fxRate.toString(), lines: p.lines.map((l) => ({ billId: l.billId, amount: l.amount.toString() })) }, p.id);
    const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: p.vendorId } });
    const ap = await roleAccount(tx, organizationId, "AP_CONTROL", "Accounts Payable");
    const party = { partyType: "VENDOR", partyId: vendor.code };
    const debits: LineInput[] = p.lines.map((l) => ({ accountId: ap.id, debit: l.amount.toString(), currencyCode: l.bill.currencyCode, fxRate: l.bill.fxRate.toString(), description: `${l.bill.number} / invoice ${l.bill.supplierInvoiceNo}`, ...party }));
    const t = await postSubledgerDisbursementTx(tx, {
      organizationId, userId, bankAccountId: p.bankAccountId, date: p.date, payee: vendor.name, ...party, method: p.method, checkNo: p.checkNo, checkDate: p.checkDate,
      reference: p.reference ?? p.number, memo: `${p.number}: ${p.memo}`, fxRate: p.fxRate.toString(), amount: cents(p.amount),
      displayLines: [{ accountId: ap.id, amount: p.amount.toString(), description: `Accounts payable: ${p.lines.map((l) => l.bill.supplierInvoiceNo).join(", ")}` }],
      debits, withFx: (lines) => withFxDifference(tx, organizationId, lines, `Realized exchange difference on ${p.number}`),
    });
    const r = await tx.apPayment.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: "POSTED", cashTransactionId: t.id, checkNo: t.checkNo, approvedById: userId, approvedAt: new Date() } });
    if (r.count !== 1) throw new LedgerError(["This payment voucher was changed by someone else; refresh and try again"]);
    await tx.apBill.updateMany({ where: { id: { in: p.lines.map((l) => l.billId) } }, data: { scheduledPayDate: null } });
    await audit(tx, organizationId, userId, "payment.post", id, { number: p.number, voucher: t.number }, null, null, "ap_payment");
    return t;
  });
}

export async function returnPayment(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const p = await loadPayment(tx, organizationId, id);
    if (p.status !== "PENDING_APPROVAL") throw new LedgerError(["Only payment vouchers waiting for approval can be returned"]);
    await recordReturn(tx, organizationId, "PAYMENT", id, userId, reason, paymentBaseTotal(p));
    await tx.apPayment.update({ where: { id }, data: { status: "DRAFT", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "payment.return", id, { number: p.number, reason }, null, null, "ap_payment");
  });
}

/** Void: drafts just become void; a released payment voids its disbursement (GL reversed, bills open again). */
export async function voidPayment(organizationId: string, userId: string, id: string, reason: string, reversalDate?: Date) {
  return prisma.$transaction(async (tx) => {
    const p = await loadPayment(tx, organizationId, id);
    if (p.status === "VOID") throw new LedgerError(["Already void"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason for voiding"]);
    if (p.cashTransactionId) await voidCashTx(tx, organizationId, userId, p.cashTransactionId, reason, reversalDate, true);
    await tx.apPayment.update({ where: { id }, data: { status: "VOID", voidedById: userId, voidedAt: new Date(), voidReason: reason.trim() } });
    await audit(tx, organizationId, userId, "payment.void", id, { number: p.number, reason }, null, null, "ap_payment");
  });
}

/** Payment run: one draft payment voucher per supplier for the selected bills' unpaid balances. */
export async function createPaymentRun(organizationId: string, userId: string, input: { bankAccountId: string; date: Date; method: string; fxRate?: string | null; billIds: string[]; submit?: boolean }) {
  const bills = await prisma.apBill.findMany({ where: { organizationId, id: { in: input.billIds }, status: "POSTED" }, orderBy: { dueDate: "asc" } });
  if (!bills.length) throw new LedgerError(["Select the bills to pay"]);
  const paid = await openBalances(prisma, organizationId, bills.map((b) => b.id));
  const byVendor = new Map<string, typeof bills>();
  for (const b of bills) byVendor.set(b.vendorId, [...(byVendor.get(b.vendorId) ?? []), b]);
  const created = [];
  for (const [vendorId, bs] of byVendor) {
    const lines = bs.map((b) => ({ billId: b.id, amount: fromCentavos(cents(b.netPayable) - (paid.get(b.id) ?? 0n)) })).filter((l) => toCentavos(l.amount) > 0n);
    if (!lines.length) continue;
    created.push(await savePayment({ organizationId, userId, vendorId, bankAccountId: input.bankAccountId, date: input.date, method: input.method, fxRate: input.fxRate, lines, action: input.submit ? "submit" : "draft" }));
  }
  if (!created.length) throw new LedgerError(["The selected bills are already fully paid or in other payment vouchers"]);
  return created;
}

// ---------- BIR Form 2307 ----------

export type Cert2307Row = { atc: string; nature: string; months: [bigint, bigint, bigint]; total: bigint; tax: bigint };
export type Cert2307 = { year: number; quarter: number; from: Date; to: Date; rows: Cert2307Row[]; totalIncome: bigint; totalTax: bigint };

const quarterRange = (year: number, q: number) => ({ from: new Date(Date.UTC(year, (q - 1) * 3, 1)), to: new Date(Date.UTC(year, q * 3, 0)) });

/**
 * Certificate of Creditable Tax Withheld at Source rows: income payments (net of VAT) and tax withheld
 * by ATC, in the month of the quarter when the tax was withheld (the bill's posting date).
 * `share` prorates a bill for a partial payment.
 */
async function certRows(organizationId: string, items: { billId: string; share: [bigint, bigint] }[]) {
  const bills = await prisma.apBill.findMany({ where: { organizationId, id: { in: items.map((i) => i.billId) } }, include: { lines: true } });
  const codes = await prisma.taxCode.findMany({ where: { organizationId, taxType: "EWT" } });
  const certs = new Map<string, Cert2307>();
  for (const it of items) {
    const b = bills.find((x) => x.id === it.billId);
    if (!b) continue;
    const { year, quarter, monthInQuarter } = quarterOf(b.date);
    const key = `${year}-Q${quarter}`;
    const c = certs.get(key) ?? { year, quarter, ...quarterRange(year, quarter), rows: [], totalIncome: 0n, totalTax: 0n };
    for (const l of b.lines) {
      if (!l.ewtTaxCodeId || cents(l.ewtAmount) === 0n) continue;
      const tc = codes.find((t) => t.id === l.ewtTaxCodeId);
      const atc = tc?.atcCode ?? tc?.code ?? "";
      const [num, den] = it.share;
      const base = roundDiv(roundDiv(cents(l.netAmount) * q4of(b.fxRate), 10000n) * num, den);
      const tax = roundDiv(roundDiv(cents(l.ewtAmount) * q4of(b.fxRate), 10000n) * num, den);
      let row = c.rows.find((r) => r.atc === atc);
      if (!row) { row = { atc, nature: tc?.name ?? "", months: [0n, 0n, 0n], total: 0n, tax: 0n }; c.rows.push(row); }
      row.months[monthInQuarter - 1] += base; row.total += base; row.tax += tax;
      c.totalIncome += base; c.totalTax += tax;
    }
    certs.set(key, c);
  }
  return [...certs.values()].filter((c) => c.rows.length).sort((a, b) => a.year - b.year || a.quarter - b.quarter);
}

/** 2307 for the bills settled by one payment voucher (one certificate per quarter). */
export async function certificatesForPayment(organizationId: string, paymentId: string) {
  const p = await prisma.apPayment.findFirst({ where: { id: paymentId, organizationId }, include: { lines: { include: { bill: true } } } });
  if (!p) throw new LedgerError(["Payment voucher not found"]);
  return { payment: p, certs: await certRows(organizationId, p.lines.map((l) => ({ billId: l.billId, share: [cents(l.amount), cents(l.bill.netPayable) || 1n] as [bigint, bigint] }))) };
}

/** Quarterly 2307 for a supplier: every posted bill with EWT in the quarter. */
export async function certificateForQuarter(organizationId: string, vendorId: string, year: number, quarter: number) {
  const { from, to } = quarterRange(year, quarter);
  const bills = await prisma.apBill.findMany({ where: { organizationId, vendorId, status: "POSTED", date: { gte: from, lte: to }, ewtAmount: { gt: 0 } }, select: { id: true } });
  return (await certRows(organizationId, bills.map((b) => ({ billId: b.id, share: [1n, 1n] as [bigint, bigint] }))))[0] ?? { year, quarter, from, to, rows: [], totalIncome: 0n, totalTax: 0n };
}

// ---------- Amount in words (check printing) ----------
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function words999(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r >= 20) parts.push(TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : ""));
  else if (r) parts.push(ONES[r]);
  return parts.join(" ");
}
/** 12345.67 -> "Twelve Thousand Three Hundred Forty-Five Pesos and 67/100 Only" */
export function amountInWords(c: bigint, currency = "PHP") {
  const whole = c / 100n, frac = c % 100n;
  const scales = ["", "Thousand", "Million", "Billion", "Trillion"];
  let n = whole; let i = 0; const parts: string[] = [];
  if (n === 0n) parts.push("Zero");
  while (n > 0n) {
    const chunk = Number(n % 1000n);
    if (chunk) parts.unshift(`${words999(chunk)}${scales[i] ? " " + scales[i] : ""}`);
    n /= 1000n; i++;
  }
  const unit = currency === "PHP" ? "Pesos" : currency === "USD" ? "US Dollars" : currency;
  return `${parts.join(" ")} ${unit} and ${String(frac).padStart(2, "0")}/100 Only`;
}
