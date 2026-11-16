// Cash management: receipts, disbursements (cash or check), petty cash vouchers and fund transfers.
// Each voucher goes draft -> for approval -> posted and posts to the GL through recordJournalTx (source BANK).
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { validateLines, type Dims, type LineInput } from "../ledger/validate";
import { LedgerError, assertCanApprove, asDay, audit, nextNumber, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import { normCheck } from "./match";
import { can } from "../permissions";

type Tx = Prisma.TransactionClient;

export type CashType = "RECEIPT" | "DISBURSEMENT" | "TRANSFER";
export type CashLine = { accountId: string; amount: string; description?: string | null; dims?: Dims };

export type CashInput = {
  organizationId: string;
  userId: string;
  type: CashType;
  bankAccountId: string;
  toBankAccountId?: string | null;
  date: Date;
  payee?: string | null;
  partyType?: string | null;
  partyId?: string | null;
  method?: string | null;
  checkNo?: string | null;
  checkDate?: Date | null;
  reference?: string | null;
  memo: string;
  fxRate?: string | null;
  toAmount?: string | null;   // transfer: amount received (if the currencies differ)
  toFxRate?: string | null;
  amount?: string | null;     // transfer only; receipts/disbursements are the sum of their lines
  withholdingTaxCodeId?: string | null;
  withholdingAmount?: string | null; // blank = rate x total of lines
  lines?: CashLine[];
  action?: "draft" | "submit" | "post";
};

export const METHODS = ["CASH", "CHECK", "BANK_TRANSFER", "ONLINE", "EWALLET"] as const;
export const KIND_LABELS: Record<string, string> = {
  CURRENT: "Bank - current (checking)", SAVINGS: "Bank - savings", PETTY_CASH: "Petty cash fund", CASH_ON_HAND: "Cash on hand / undeposited collections", EWALLET: "E-wallet (GCash, Maya)",
};
export const isBank = (kind: string) => kind === "CURRENT" || kind === "SAVINGS";

const cents = (d: Prisma.Decimal | string | null | undefined) => toCentavos(d?.toString() ?? "0");
const fmt = (c: bigint) => (Number(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 });

function prefix(type: CashType, kind: string) {
  if (type === "TRANSFER") return "FT";
  if (type === "RECEIPT") return "CR";
  return kind === "PETTY_CASH" ? "PCV" : "CD";
}

export function cashTypeLabel(t: { type: string; isReplenishment?: boolean; number?: string }) {
  if (t.isReplenishment) return "Petty cash replenishment";
  if (t.type === "RECEIPT") return "Cash receipt";
  if (t.type === "TRANSFER") return "Fund transfer";
  return t.number?.startsWith("PCV") ? "Petty cash voucher" : "Disbursement";
}

async function bankOf(tx: Tx, organizationId: string, id: string | null | undefined) {
  const b = id ? await tx.bankAccount.findFirst({ where: { id, organizationId }, include: { glAccount: true } }) : null;
  if (!b) throw new LedgerError(["Choose a bank or cash account"]);
  if (!b.isActive) throw new LedgerError([`${b.name} is inactive`]);
  return b;
}

async function balanceOf(tx: Tx, organizationId: string, glAccountId: string, asOf?: Date) {
  const agg = await tx.journalLine.aggregate({
    where: { organizationId, accountId: glAccountId, journalEntry: { status: "POSTED", book: "STATUTORY", ...(asOf ? { date: { lte: asOf } } : {}) } },
    _sum: { fxDebit: true, fxCredit: true },
  });
  return cents(agg._sum.fxDebit) - cents(agg._sum.fxCredit);
}

/** Book balance of a bank/cash account in its own currency. */
export async function bookBalance(organizationId: string, glAccountId: string, asOf?: Date) {
  return prisma.$transaction((tx) => balanceOf(tx, organizationId, glAccountId, asOf));
}

type Prepared = { data: Omit<Prisma.CashTransactionUncheckedCreateInput, "organizationId" | "number" | "createdById">; kind: string };

/** Validate the input and work out the amounts. Does not write. */
async function prepare(tx: Tx, input: CashInput): Promise<Prepared> {
  const errors: string[] = [];
  const bank = await bankOf(tx, input.organizationId, input.bankAccountId);
  if (!input.memo?.trim()) errors.push("Enter the purpose / particulars");
  const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
  const foreign = bank.currencyCode !== org.baseCurrency;
  const fxRate = foreign ? (input.fxRate?.trim() || "") : "1";
  if (foreign && !(Number(fxRate) > 0)) errors.push(`Enter the exchange rate for ${bank.currencyCode}`);
  const method = (input.method || "CASH").toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) errors.push("Choose a payment method");
  const base = {
    type: input.type, bankAccountId: bank.id, date: asDay(input.date), memo: input.memo?.trim() ?? "",
    reference: input.reference?.trim() || null, currencyCode: bank.currencyCode, fxRate: new Prisma.Decimal(fxRate || "1"),
    method, payee: input.payee?.trim() || null, partyType: input.partyType || null, partyId: input.partyId?.trim() || null,
  };

  if (input.type === "TRANSFER") {
    const to = await bankOf(tx, input.organizationId, input.toBankAccountId);
    if (to.id === bank.id) errors.push("Choose two different accounts");
    let amt = 0n, toAmt = 0n;
    try { amt = toCentavos(input.amount); } catch (e) { errors.push((e as Error).message); }
    if (amt <= 0n) errors.push("Enter the amount transferred");
    const same = to.currencyCode === bank.currencyCode;
    const toForeign = to.currencyCode !== org.baseCurrency;
    const toFxRate = !toForeign ? "1" : same ? fxRate : (input.toFxRate?.trim() || "");
    if (toForeign && !(Number(toFxRate) > 0)) errors.push(`Enter the exchange rate for ${to.currencyCode}`);
    try { toAmt = same ? amt : toCentavos(input.toAmount); } catch (e) { errors.push((e as Error).message); }
    if (!same && toAmt <= 0n) errors.push(`Enter the amount received in ${to.currencyCode}`);
    if (method === "CHECK" && !input.checkNo?.trim() && !bank.nextCheckNo) errors.push("Enter the check number");
    if (errors.length) throw new LedgerError(errors);
    return { kind: bank.kind, data: {
      ...base, toBankAccountId: to.id, amount: new Prisma.Decimal(fromCentavos(amt)), toAmount: new Prisma.Decimal(fromCentavos(toAmt)),
      toFxRate: new Prisma.Decimal(toFxRate || "1"), checkNo: input.checkNo?.trim() || null, checkDate: input.checkDate ? asDay(input.checkDate) : null,
      lines: [], withholdingAmount: 0,
    } };
  }

  const lines = (input.lines ?? []).filter((l) => l.accountId || String(l.amount ?? "").trim());
  if (!lines.length) errors.push(input.type === "RECEIPT" ? "Add at least one line: what the money is for (e.g. customer payment, other income)" : "Add at least one line: what was paid (expense, payable, advance)");
  let gross = 0n;
  lines.forEach((l, i) => {
    if (!l.accountId) errors.push(`Line ${i + 1}: choose an account`);
    try {
      const c = toCentavos(l.amount);
      if (c <= 0n) errors.push(`Line ${i + 1}: enter a positive amount`);
      gross += c;
    } catch (e) { errors.push(`Line ${i + 1}: ${(e as Error).message}`); }
  });
  let wht = 0n;
  let whtCode: string | null = null;
  if (input.withholdingTaxCodeId) {
    const tc = await tx.taxCode.findFirst({ where: { id: input.withholdingTaxCodeId, organizationId: input.organizationId, isActive: true } });
    if (!tc) errors.push("Withholding tax code not found");
    else {
      whtCode = tc.id;
      const typed = input.withholdingAmount?.trim();
      try {
        wht = typed ? toCentavos(typed) : (gross * toCentavos(tc.rate.toString()) + 5000n) / 10000n;
      } catch (e) { errors.push(`Withholding tax: ${(e as Error).message}`); }
      if (wht < 0n || wht >= gross) errors.push("Withholding tax must be less than the total");
    }
  }
  if (input.type === "DISBURSEMENT" && method === "CHECK" && !input.checkNo?.trim() && !bank.nextCheckNo) errors.push("Enter the check number (or set the next check number on the bank account)");
  if (input.type === "DISBURSEMENT" && method === "CHECK" && !isBank(bank.kind)) errors.push("Checks can only be drawn on a bank account");
  if (errors.length) throw new LedgerError(errors);
  return { kind: bank.kind, data: {
    ...base, toBankAccountId: null, amount: new Prisma.Decimal(fromCentavos(gross - wht)), toAmount: null, toFxRate: null,
    withholdingTaxCodeId: whtCode, withholdingAmount: new Prisma.Decimal(fromCentavos(wht)),
    checkNo: input.checkNo?.trim() || null, checkDate: input.checkDate ? asDay(input.checkDate) : null,
    lines: lines.map((l) => ({ accountId: l.accountId, amount: fromCentavos(toCentavos(l.amount)), description: l.description?.trim() || null, dims: l.dims ?? {} })),
  } };
}

/** Check numbers are unique per bank account (voided checks keep their number). */
async function assignCheckNo(tx: Tx, organizationId: string, bankAccountId: string, type: string, method: string, checkNo: string | null, selfId?: string) {
  if (type === "RECEIPT" || method !== "CHECK") return checkNo;
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: bankAccountId } });
  let no = checkNo;
  if (!no) {
    if (!bank.nextCheckNo) throw new LedgerError(["Enter the check number"]);
    no = String(bank.nextCheckNo).padStart(6, "0");
  }
  const n = normCheck(no);
  if (!n) throw new LedgerError(["The check number must contain digits"]);
  const others = await tx.cashTransaction.findMany({
    where: { organizationId, bankAccountId, method: "CHECK", type: { not: "RECEIPT" }, checkNo: { not: null }, ...(selfId ? { id: { not: selfId } } : {}) },
    select: { checkNo: true, number: true },
  });
  const clash = others.find((o) => normCheck(o.checkNo) === n);
  if (clash) throw new LedgerError([`Check no. ${no} is already used on ${clash.number}`]);
  if (bank.nextCheckNo && Number(n) >= bank.nextCheckNo) await tx.bankAccount.update({ where: { id: bank.id }, data: { nextCheckNo: Number(n) + 1 } });
  return no;
}

type Txn = Prisma.CashTransactionGetPayload<object>;

/** The GL lines for a voucher. Cash side first. */
async function journalLines(tx: Tx, t: Txn): Promise<LineInput[]> {
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: t.bankAccountId } });
  const org = await tx.organization.findUniqueOrThrow({ where: { id: t.organizationId } });
  const party = { partyType: t.partyType, partyId: t.partyId };
  const cur = { currencyCode: t.currencyCode, fxRate: t.fxRate.toString() };
  const amount = t.amount.toString();
  if (t.type === "TRANSFER") {
    const to = await tx.bankAccount.findUniqueOrThrow({ where: { id: t.toBankAccountId! } });
    const lines: LineInput[] = [
      { accountId: to.glAccountId, debit: t.toAmount!.toString(), currencyCode: to.currencyCode, fxRate: t.toFxRate!.toString(), description: `Transfer from ${bank.name}` },
      { accountId: bank.glAccountId, credit: amount, ...cur, description: `Transfer to ${to.name}` },
    ];
    const v = validateLines([...lines, ...lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit }))], org.baseCurrency);
    if (v.ok) {
      const diff = v.lines[0].debit - v.lines[1].credit; // >0: received more (in PHP) than sent -> gain
      if (diff !== 0n) {
        const role = diff > 0n ? "FX_GAIN" : "FX_LOSS";
        const acct = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId: t.organizationId, systemRole: role } } });
        if (!acct) throw new LedgerError([`Assign the ${role === "FX_GAIN" ? "realized FX gain" : "realized FX loss"} account first`]);
        const amt = fromCentavos(diff > 0n ? diff : -diff);
        lines.push({ accountId: acct.id, [diff > 0n ? "credit" : "debit"]: amt, currencyCode: org.baseCurrency, description: "Realized foreign exchange difference on transfer" });
      }
    }
    return lines;
  }
  const receipt = t.type === "RECEIPT";
  const counter = (t.lines as CashLine[]).map((l): LineInput => ({
    accountId: l.accountId, [receipt ? "credit" : "debit"]: l.amount, description: l.description || t.memo, dims: l.dims, ...cur, ...party,
  }));
  const wht = cents(t.withholdingAmount);
  const out: LineInput[] = [{ accountId: bank.glAccountId, [receipt ? "debit" : "credit"]: amount, description: t.payee ? `${receipt ? "From" : "To"} ${t.payee}` : t.memo, ...cur, ...party }];
  if (wht > 0n) {
    let acctId: string | undefined;
    if (receipt) acctId = (await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId: t.organizationId, systemRole: "CWT_RECEIVABLE" } } }))?.id;
    else {
      const tc = await tx.taxCode.findUnique({ where: { id: t.withholdingTaxCodeId! } });
      const code = tc?.accountCode;
      acctId = code ? (await tx.account.findUnique({ where: { organizationId_code: { organizationId: t.organizationId, code } } }))?.id : undefined;
      acctId ??= (await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId: t.organizationId, systemRole: "EWT_PAYABLE" } } }))?.id;
    }
    if (!acctId) throw new LedgerError([receipt ? "Assign the Creditable Withholding Tax account first" : "Set the GL account of the withholding tax code first"]);
    out.push({ accountId: acctId, [receipt ? "debit" : "credit"]: fromCentavos(wht), description: receipt ? "Creditable withholding tax (BIR 2307)" : "Expanded withholding tax", ...cur, ...party });
  }
  return [...out, ...counter];
}

async function baseTotal(tx: Tx, t: Txn) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: t.organizationId } });
  const v = validateLines(await journalLines(tx, t), org.baseCurrency);
  if (!v.ok) throw new LedgerError(v.errors);
  return v.totalDebit;
}

/** Nothing may be dated inside a finalized bank reconciliation. */
export async function assertNotReconciled(tx: Tx, organizationId: string, bankIds: (string | null)[], date: Date) {
  const st = await tx.bankStatement.findFirst({
    where: { organizationId, bankAccountId: { in: bankIds.filter(Boolean) as string[] }, status: "RECONCILED", periodTo: { gte: date } },
    orderBy: { periodTo: "desc" },
  });
  if (st) throw new LedgerError([`The bank reconciliation up to ${st.periodTo.toISOString().slice(0, 10)} is finalized. Use a later date.`]);
}

async function postTx(tx: Tx, t: Txn, userId: string) {
  await assertNotReconciled(tx, t.organizationId, [t.bankAccountId, t.toBankAccountId], t.date);
  // Petty cash and cash on hand cannot go negative.
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: t.bankAccountId } });
  if (!isBank(bank.kind) && t.type !== "RECEIPT") {
    const bal = await balanceOf(tx, t.organizationId, bank.glAccountId);
    if (cents(t.amount) > bal) throw new LedgerError([`${bank.name} only has ${fmt(bal)} on hand. Replenish or fund it first.`]);
  }
  const e = await recordJournalTx(tx, {
    organizationId: t.organizationId, userId, date: t.date, memo: `${t.number}: ${t.memo}`,
    reference: [t.reference, t.checkNo ? `Check ${t.checkNo}` : null].filter(Boolean).join(" / ") || t.number,
    lines: await journalLines(tx, t), source: "BANK", sourceId: t.id, action: "post",
  });
  const now = new Date();
  const r = await tx.cashTransaction.updateMany({
    where: { id: t.id, status: t.status },
    data: { status: "POSTED", journalEntryId: e.id, approvedById: userId, approvedAt: now, submittedById: t.submittedById ?? userId, submittedAt: t.submittedAt ?? now, rejectReason: null },
  });
  if (r.count !== 1) throw new LedgerError(["This voucher was changed by someone else; refresh and try again"]);
  await audit(tx, t.organizationId, userId, "cash.post", t.id, { number: t.number, journal: e.number }, null, null, "cash");
  return e;
}

/** Create or update (draft only) a voucher, then optionally submit or post it. */
export async function saveCashTransaction(input: CashInput, id?: string) {
  return prisma.$transaction(async (tx) => {
    const p = await prepare(tx, input);
    const action = input.action ?? "draft";
    let t: Txn;
    if (id) {
      const cur = await tx.cashTransaction.findFirst({ where: { id, organizationId: input.organizationId } });
      if (!cur) throw new LedgerError(["Voucher not found"]);
      if (cur.status !== "DRAFT") throw new LedgerError(["Only drafts can be edited. Void a posted voucher and record a new one."]);
      if (cur.isReplenishment) throw new LedgerError(["Void this replenishment and create a new one instead of editing it"]);
      if (cur.type !== input.type || cur.bankAccountId !== p.data.bankAccountId) {
        if (prefix(cur.type as CashType, (await tx.bankAccount.findUniqueOrThrow({ where: { id: cur.bankAccountId } })).kind) !== prefix(input.type, p.kind))
          throw new LedgerError(["The voucher type cannot change. Void this draft and create a new one."]);
      }
      const checkNo = await assignCheckNo(tx, input.organizationId, p.data.bankAccountId, input.type, p.data.method as string, (p.data.checkNo as string | null) ?? null, id);
      t = await tx.cashTransaction.update({ where: { id }, data: { ...p.data, checkNo, updatedById: input.userId } });
      await audit(tx, input.organizationId, input.userId, "cash.update", id, { number: t.number }, JSON.parse(JSON.stringify(cur)), JSON.parse(JSON.stringify(t)), "cash");
    } else {
      const checkNo = await assignCheckNo(tx, input.organizationId, p.data.bankAccountId, input.type, p.data.method as string, (p.data.checkNo as string | null) ?? null);
      const number = await nextNumber(tx, input.organizationId, prefix(input.type, p.kind), (p.data.date as Date).getUTCFullYear());
      t = await tx.cashTransaction.create({ data: { ...p.data, checkNo, organizationId: input.organizationId, number, createdById: input.userId } });
      await audit(tx, input.organizationId, input.userId, "cash.create", t.id, { number }, null, JSON.parse(JSON.stringify(t)), "cash");
    }
    // Validate the GL effect now, so a draft never hides an entry that cannot post.
    const total = await baseTotal(tx, t);
    if (action === "submit") {
      t = await tx.cashTransaction.update({ where: { id: t.id }, data: { status: "PENDING_APPROVAL", submittedById: input.userId, submittedAt: new Date(), rejectReason: null } });
      await audit(tx, input.organizationId, input.userId, "cash.submit", t.id, { number: t.number }, null, null, "cash");
    }
    if (action === "post") {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
      if (org.requireApproval) throw new LedgerError(["This company requires approval: submit the voucher for approval instead"]);
      await assertCanApprove(tx, input.organizationId, input.userId, org.segregationOfDuties ? [input.userId] : [], total);
      await postTx(tx, t, input.userId);
    }
    return tx.cashTransaction.findUniqueOrThrow({ where: { id: t.id } });
  });
}

async function load(tx: Tx, organizationId: string, id: string) {
  const t = await tx.cashTransaction.findFirst({ where: { id, organizationId } });
  if (!t) throw new LedgerError(["Voucher not found"]);
  return t;
}

export async function submitCash(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const t = await load(tx, organizationId, id);
    if (t.status !== "DRAFT") throw new LedgerError(["Only drafts can be submitted"]);
    await baseTotal(tx, t);
    await tx.cashTransaction.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedById: userId, submittedAt: new Date(), rejectReason: null } });
    await audit(tx, organizationId, userId, "cash.submit", id, { number: t.number }, null, null, "cash");
  });
}

/** Approve and post: permission, segregation of duties and approval limit, same as journals. */
export async function approveCash(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const t = await load(tx, organizationId, id);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (t.status === "POSTED" || t.status === "VOID") throw new LedgerError([`Voucher is already ${t.status.toLowerCase()}`]);
    if (t.status === "DRAFT" && org.requireApproval) throw new LedgerError(["Submit the voucher for approval first"]);
    await assertCanApprove(tx, organizationId, userId, [t.createdById, t.submittedById, t.updatedById], await baseTotal(tx, t));
    return postTx(tx, t, userId);
  });
}

export async function rejectCash(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const t = await load(tx, organizationId, id);
    if (t.status !== "PENDING_APPROVAL") throw new LedgerError(["Only vouchers waiting for approval can be returned"]);
    const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
    if (!m || !can(m.role, "journal.post")) throw new LedgerError(["You do not have rights to approve or return vouchers"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason so the preparer knows what to fix"]);
    await tx.cashTransaction.update({ where: { id }, data: { status: "DRAFT", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "cash.reject", id, { number: t.number, reason: reason.trim() }, null, null, "cash");
  });
}

/**
 * Void a voucher. Drafts just become void. A posted voucher is reversed in the GL (on `reversalDate`,
 * default its own date), and the original and reversal cash lines clear each other so neither shows
 * as an outstanding check or deposit in transit after the void date.
 */
export async function voidCash(organizationId: string, userId: string, id: string, reason: string, reversalDate?: Date) {
  return prisma.$transaction(async (tx) => {
    const t = await load(tx, organizationId, id);
    if (t.status === "VOID") throw new LedgerError(["Voucher is already void"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason for voiding"]);
    if (t.replenishedById) {
      const r = await tx.cashTransaction.findUnique({ where: { id: t.replenishedById } });
      if (r && r.status !== "VOID") throw new LedgerError([`This petty cash voucher was already replenished by ${r.number}. Void the replenishment first.`]);
    }
    if (t.status === "POSTED" && t.journalEntryId) {
      await assertNotReconciled(tx, organizationId, [t.bankAccountId, t.toBankAccountId], asDay(reversalDate ?? t.date));
      const rev = await voidOrReverseTx(tx, organizationId, userId, t.journalEntryId, reversalDate ?? t.date, true);
      if (rev) {
        const lines = await tx.journalLine.findMany({ where: { journalEntryId: { in: [t.journalEntryId, rev.id] }, clearedAt: null } });
        const banks = await tx.bankAccount.findMany({ where: { organizationId, id: { in: [t.bankAccountId, t.toBankAccountId].filter(Boolean) as string[] } } });
        for (const b of banks) {
          const ls = lines.filter((l) => l.accountId === b.glAccountId);
          if (!ls.length) continue;
          const m = await tx.bankMatch.create({ data: { organizationId, bankAccountId: b.id, method: "NO_STATEMENT", note: `Voided ${t.number}: reversal offsets the original`, createdById: userId } });
          for (const l of ls) await tx.journalLine.update({ where: { id: l.id }, data: { clearedAt: rev.date, clearingRef: m.id } });
        }
      }
    }
    await tx.cashTransaction.update({ where: { id }, data: { status: "VOID", voidedById: userId, voidedAt: new Date(), voidReason: reason.trim() } });
    if (t.isReplenishment) await tx.cashTransaction.updateMany({ where: { replenishedById: id }, data: { replenishedById: null } });
    await audit(tx, organizationId, userId, "cash.void", id, { number: t.number, reason: reason.trim() }, null, null, "cash");
  });
}

/** Record the date a check was handed to the payee (check monitoring). */
export async function releaseCheck(organizationId: string, userId: string, id: string, date: Date | null) {
  return prisma.$transaction(async (tx) => {
    const t = await load(tx, organizationId, id);
    if (t.method !== "CHECK" || t.type === "RECEIPT") throw new LedgerError(["This voucher is not a check payment"]);
    if (t.status !== "POSTED") throw new LedgerError(["Only approved (posted) checks can be released"]);
    await tx.cashTransaction.update({ where: { id }, data: { checkReleasedAt: date ? asDay(date) : null } });
    await audit(tx, organizationId, userId, date ? "check.release" : "check.unrelease", id, { number: t.number, checkNo: t.checkNo, date: date?.toISOString().slice(0, 10) ?? null }, null, null, "cash");
  });
}

/** Posted petty cash vouchers of a fund not yet replenished. */
export async function unreplenished(organizationId: string, fundId: string, upTo?: Date) {
  return prisma.cashTransaction.findMany({
    where: { organizationId, bankAccountId: fundId, type: "DISBURSEMENT", status: "POSTED", replenishedById: null, ...(upTo ? { date: { lte: asDay(upTo) } } : {}) },
    orderBy: { date: "asc" },
  });
}

/**
 * Replenish a petty cash fund (imprest system): one transfer from a bank account to the fund for the
 * total of the posted petty cash vouchers not yet replenished. The vouchers are tagged with it.
 */
export async function replenishPettyCash(input: { organizationId: string; userId: string; fundId: string; fromBankAccountId: string; date: Date; method: string; checkNo?: string | null; action?: "draft" | "submit" }) {
  const fund = await prisma.bankAccount.findFirst({ where: { id: input.fundId, organizationId: input.organizationId } });
  if (!fund || fund.kind !== "PETTY_CASH") throw new LedgerError(["Choose a petty cash fund"]);
  const pcvs = await unreplenished(input.organizationId, fund.id, input.date);
  const pending = await prisma.cashTransaction.findFirst({ where: { organizationId: input.organizationId, toBankAccountId: fund.id, isReplenishment: true, status: { in: ["DRAFT", "PENDING_APPROVAL"] } } });
  if (pending) throw new LedgerError([`Replenishment ${pending.number} is still waiting for approval`]);
  if (!pcvs.length) throw new LedgerError(["There are no posted petty cash vouchers to replenish"]);
  const total = pcvs.reduce((s, p) => s + cents(p.amount), 0n);
  const t = await saveCashTransaction({
    organizationId: input.organizationId, userId: input.userId, type: "TRANSFER", bankAccountId: input.fromBankAccountId, toBankAccountId: fund.id,
    date: input.date, method: input.method, checkNo: input.checkNo, payee: fund.custodian, amount: fromCentavos(total),
    memo: `Replenish ${fund.name}: ${pcvs.length} voucher(s) ${pcvs[0].number} to ${pcvs[pcvs.length - 1].number}`, action: "draft",
  });
  await prisma.$transaction(async (tx) => {
    await tx.cashTransaction.update({ where: { id: t.id }, data: { isReplenishment: true } });
    await tx.cashTransaction.updateMany({ where: { id: { in: pcvs.map((p) => p.id) } }, data: { replenishedById: t.id } });
  });
  if (input.action !== "draft") await submitCash(input.organizationId, input.userId, t.id);
  return prisma.cashTransaction.findUniqueOrThrow({ where: { id: t.id } });
}
