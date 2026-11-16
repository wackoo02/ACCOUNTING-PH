// The ONE way anything writes to the general ledger. Manual journals, and later
// AR/AP, bank reconciliation, payroll, expense claims and BIR modules, all call these functions.
import { Prisma, type JournalSource, type LedgerBook } from "@prisma/client";
import { randomUUID } from "crypto";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { validateLines, type LineInput, type NormalizedLine } from "./validate";
import { DIMENSIONS, DIM_KEYS } from "./dimensions";
import { PH_IFRS_TEMPLATE, normalBalanceFor } from "../coa-template";
import { can } from "../permissions";

type Tx = Prisma.TransactionClient;

export class LedgerError extends Error {
  constructor(public errors: string[]) {
    super(errors.join("; "));
  }
}

export type AttachmentInput = { name: string; url: string };

export type RecordJournalInput = {
  organizationId: string;
  userId: string;
  date: Date;              // posting date (decides the period)
  transactionDate?: Date;  // document date; defaults to posting date
  memo: string;
  reference?: string | null;
  lines: LineInput[];
  attachments?: AttachmentInput[];
  source?: JournalSource;
  sourceId?: string | null;
  book?: LedgerBook;
  autoReverseOn?: Date | null;
  intercompanyGroupId?: string | null;
  /** "draft" (default), "submit" for approval, or "post". Manual "post" runs approval controls. */
  action?: "draft" | "submit" | "post";
};

const dec = (c: bigint) => new Prisma.Decimal(fromCentavos(c));
const cents = (d: Prisma.Decimal | null | undefined) => toCentavos(d?.toString() ?? "0");

/** Entries are dated by calendar day, stored as UTC midnight. */
export function asDay(d: Date | string): Date {
  const s = typeof d === "string" ? d : d.toISOString();
  return new Date(s.slice(0, 10) + "T00:00:00.000Z");
}

async function orgOf(tx: Tx, organizationId: string) {
  const o = await tx.organization.findUnique({ where: { id: organizationId } });
  if (!o) throw new LedgerError(["Company not found"]);
  return o;
}

async function validated(tx: Tx, organizationId: string, lines: LineInput[], manual: boolean) {
  const org = await orgOf(tx, organizationId);
  const v = validateLines(lines, org.baseCurrency);
  if (!v.ok) throw new LedgerError(v.errors);
  await checkRefs(tx, organizationId, org.baseCurrency, v.lines, manual);
  return v;
}

function lineData(organizationId: string, l: NormalizedLine) {
  return {
    organizationId,
    lineNo: l.lineNo,
    accountId: l.accountId,
    description: l.description,
    debit: dec(l.debit),
    credit: dec(l.credit),
    currencyCode: l.currencyCode,
    fxRate: new Prisma.Decimal(l.fxRate),
    fxDebit: dec(l.fxDebit),
    fxCredit: dec(l.fxCredit),
    partyType: l.partyType,
    partyId: l.partyId,
    ...l.dims,
    intercompanyOrgId: l.intercompanyOrgId,
  };
}

export async function nextNumber(tx: Tx, organizationId: string, prefix: string, year: number) {
  const key = `${prefix}-${year}`;
  const seq = await tx.documentSequence.upsert({
    where: { organizationId_key: { organizationId, key } },
    create: { organizationId, key, next: 2 },
    update: { next: { increment: 1 } },
  });
  return `${key}-${String(seq.next - 1).padStart(6, "0")}`;
}

async function assertPeriodOpen(tx: Tx, organizationId: string, date: Date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const p = await tx.fiscalPeriod.findUnique({ where: { organizationId_year_month: { organizationId, year, month } } });
  const label = `${year}-${String(month).padStart(2, "0")}`;
  if (p?.status === "CLOSED") throw new LedgerError([`The period ${label} is closed. Reopen it or use a later posting date.`]);
  if (p?.status === "LOCKED") throw new LedgerError([`The period ${label} is locked after year-end closing.`]);
  if (!p) await tx.fiscalPeriod.create({ data: { organizationId, year, month } });
}

/** Every account, dimension, currency and counterparty must belong to this company. */
async function checkRefs(tx: Tx, organizationId: string, base: string, lines: NormalizedLine[], manual: boolean) {
  const errors: string[] = [];
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter(Boolean) as string[])];

  const ids = uniq(lines.map((l) => l.accountId));
  const accounts = await tx.account.findMany({ where: { id: { in: ids }, organizationId } });
  if (accounts.length !== ids.length) errors.push("One or more accounts do not belong to this company");
  for (const a of accounts) {
    if (!a.isPostable) errors.push(`${a.code} ${a.name} is a header account; post to one of its sub-accounts`);
    if (!a.isActive) errors.push(`${a.code} ${a.name} is inactive`);
    if (manual && !a.allowManualPosting) errors.push(`${a.code} ${a.name} only accepts postings from its sub-ledger module, not manual journals`);
  }
  for (const l of lines) {
    const a = accounts.find((x) => x.id === l.accountId);
    if (a?.currencyCode && a.currencyCode !== l.currencyCode) errors.push(`Line ${l.lineNo}: ${a.code} ${a.name} is a ${a.currencyCode} account`);
  }

  for (const d of DIMENSIONS) {
    const vals = uniq(lines.map((l) => l.dims[d.key]));
    if (!vals.length) continue;
    const n = await tx.dimensionValue.count({ where: { id: { in: vals }, organizationId, type: d.type, isActive: true } });
    if (n !== vals.length) errors.push(`A ${d.label.toLowerCase()} is inactive or does not belong to this company`);
  }

  const curs = uniq(lines.map((l) => l.currencyCode)).filter((c) => c !== base);
  if (curs.length) {
    const found = await tx.currency.findMany({ where: { organizationId, code: { in: curs }, isActive: true }, select: { code: true } });
    const missing = curs.filter((c) => !found.some((f) => f.code === c));
    if (missing.length) errors.push(`Add ${missing.join(", ")} to the Currencies list first`);
  }

  for (const ic of uniq(lines.map((l) => l.intercompanyOrgId))) {
    if (ic === organizationId) errors.push("An entity cannot be its own intercompany counterparty");
    else if (!(await tx.intercompanyLink.findUnique({ where: { organizationId_counterpartyOrgId: { organizationId, counterpartyOrgId: ic } } })))
      errors.push("Intercompany counterparty is not set up for this company");
  }
  if (errors.length) throw new LedgerError(errors);
}

/** Approval controls: permission, segregation of duties, and approval limit. */
export async function assertCanApprove(tx: Tx, organizationId: string, userId: string, preparerIds: (string | null)[], total: bigint) {
  const org = await orgOf(tx, organizationId);
  const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  if (!m || !can(m.role, "journal.post")) throw new LedgerError(["You do not have rights to approve and post entries"]);
  if (org.segregationOfDuties && preparerIds.includes(userId)) {
    throw new LedgerError(["Segregation of duties: someone other than the preparer must approve this entry"]);
  }
  if (m.approvalLimit !== null && total > cents(m.approvalLimit)) {
    throw new LedgerError([`This entry (${fmt(total)}) is above your approval limit of ${fmt(cents(m.approvalLimit))}`]);
  }
}

/** A JSON snapshot of an entry for the audit trail's before/after. */
async function snapshot(tx: Tx, id: string) {
  const e = await tx.journalEntry.findUnique({ where: { id }, include: { lines: { orderBy: { lineNo: "asc" } }, attachments: true } });
  if (!e) return null;
  return JSON.parse(JSON.stringify(e)) as Prisma.InputJsonValue;
}

export async function recordJournal(input: RecordJournalInput) {
  return prisma.$transaction((tx) => recordJournalTx(tx, input));
}

export async function recordJournalTx(tx: Tx, input: RecordJournalInput) {
  if (!input.memo.trim()) throw new LedgerError(["Enter a description (narration) for the entry"]);
  const source = input.source ?? "MANUAL";
  const manual = source === "MANUAL";
  const action = input.action ?? "draft";
  const v = await validated(tx, input.organizationId, input.lines, manual);
  const date = asDay(input.date);
  const org = await orgOf(tx, input.organizationId);

  let status: "DRAFT" | "PENDING_APPROVAL" | "POSTED" = "DRAFT";
  if (action === "submit") status = "PENDING_APPROVAL";
  if (action === "post") {
    if (manual) {
      if (org.requireApproval) throw new LedgerError(["This company requires approval: submit the entry for approval instead"]);
      // Preparer == approver here; segregation of duties blocks it, and the approval limit applies.
      await assertCanApprove(tx, input.organizationId, input.userId, org.segregationOfDuties ? [input.userId] : [], v.totalDebit);
    }
    status = "POSTED";
  }
  if (status === "POSTED") await assertPeriodOpen(tx, input.organizationId, date);

  const number = await nextNumber(tx, input.organizationId, prefixFor(source), date.getUTCFullYear());
  const now = new Date();
  const entry = await tx.journalEntry.create({
    data: {
      organizationId: input.organizationId,
      number,
      date,
      transactionDate: asDay(input.transactionDate ?? input.date),
      memo: input.memo.trim(),
      reference: input.reference?.trim() || null,
      source,
      sourceId: input.sourceId ?? null,
      book: input.book ?? "STATUTORY",
      autoReverseOn: input.autoReverseOn ? asDay(input.autoReverseOn) : null,
      intercompanyGroupId: input.intercompanyGroupId ?? null,
      status,
      totalDebit: dec(v.totalDebit),
      totalCredit: dec(v.totalCredit),
      createdById: input.userId,
      submittedById: status !== "DRAFT" ? input.userId : null,
      submittedAt: status !== "DRAFT" ? now : null,
      postedById: status === "POSTED" ? input.userId : null,
      postedAt: status === "POSTED" ? now : null,
      lines: { create: v.lines.map((l) => lineData(input.organizationId, l)) },
      attachments: { create: cleanAttachments(input.attachments).map((a) => ({ ...a, addedById: input.userId })) },
    },
  });
  await audit(tx, input.organizationId, input.userId, `journal.create${status === "DRAFT" ? "" : status === "POSTED" ? "_post" : "_submit"}`, entry.id, { number }, null, await snapshot(tx, entry.id));
  return entry;
}

function cleanAttachments(a?: AttachmentInput[]) {
  return (a ?? [])
    .map((x) => ({ name: x.name.trim() || x.url.trim(), url: x.url.trim() }))
    .filter((x) => x.url)
    .map((x) => {
      if (!/^https?:\/\//i.test(x.url)) throw new LedgerError([`Supporting document link must start with http:// or https:// (${x.url})`]);
      return x;
    });
}

/** Edit a DRAFT (or a rejected) entry. Posted entries are never edited: reverse them instead. */
export async function updateDraft(entryId: string, input: Omit<RecordJournalInput, "source" | "sourceId">) {
  return prisma.$transaction(async (tx) => {
    const e = await tx.journalEntry.findFirst({ where: { id: entryId, organizationId: input.organizationId } });
    if (!e) throw new LedgerError(["Entry not found"]);
    if (e.status !== "DRAFT") throw new LedgerError(["Only draft entries can be edited. Posted entries are corrected by reversal."]);
    if (!input.memo.trim()) throw new LedgerError(["Enter a description (narration) for the entry"]);
    const v = await validated(tx, input.organizationId, input.lines, e.source === "MANUAL");
    const before = await snapshot(tx, e.id);
    await tx.journalLine.deleteMany({ where: { journalEntryId: e.id } });
    await tx.journalAttachment.deleteMany({ where: { journalEntryId: e.id } });
    await tx.journalEntry.update({
      where: { id: e.id },
      data: {
        date: asDay(input.date),
        transactionDate: asDay(input.transactionDate ?? input.date),
        memo: input.memo.trim(),
        reference: input.reference?.trim() || null,
        totalDebit: dec(v.totalDebit),
        totalCredit: dec(v.totalCredit),
        updatedById: input.userId,
        lines: { create: v.lines.map((l) => lineData(input.organizationId, l)) },
        attachments: { create: cleanAttachments(input.attachments).map((a) => ({ ...a, addedById: input.userId })) },
      },
    });
    await audit(tx, input.organizationId, input.userId, "journal.update", e.id, null, before, await snapshot(tx, e.id));
  });
}

const toInput = (l: Prisma.JournalLineGetPayload<object>): LineInput => ({
  accountId: l.accountId,
  debit: l.fxDebit.toString(),
  credit: l.fxCredit.toString(),
  currencyCode: l.currencyCode,
  fxRate: l.fxRate.toString(),
  dims: Object.fromEntries(DIM_KEYS.map((k) => [k, l[k]])),
  intercompanyOrgId: l.intercompanyOrgId,
});

export async function submitForApproval(organizationId: string, userId: string, entryId: string) {
  return prisma.$transaction(async (tx) => {
    const e = await tx.journalEntry.findFirst({ where: { id: entryId, organizationId }, include: { lines: true } });
    if (!e) throw new LedgerError(["Entry not found"]);
    if (e.status !== "DRAFT") throw new LedgerError([`Entry is already ${label(e.status)}`]);
    await validated(tx, organizationId, e.lines.map(toInput), e.source === "MANUAL");
    await tx.journalEntry.update({ where: { id: e.id }, data: { status: "PENDING_APPROVAL", submittedById: userId, submittedAt: new Date() } });
    await audit(tx, organizationId, userId, "journal.submit", e.id, { number: e.number });
  });
}

/** Approve and post. Applies segregation of duties and the approver's limit. */
export async function postJournal(organizationId: string, userId: string, entryId: string) {
  return prisma.$transaction(async (tx) => {
    const e = await tx.journalEntry.findFirst({ where: { id: entryId, organizationId }, include: { lines: true } });
    if (!e) throw new LedgerError(["Entry not found"]);
    const org = await orgOf(tx, organizationId);
    if (e.status === "POSTED" || e.status === "VOID") throw new LedgerError([`Entry is already ${label(e.status)}`]);
    if (e.status === "DRAFT" && org.requireApproval && e.source === "MANUAL") throw new LedgerError(["Submit the entry for approval first"]);
    // Re-validate in case accounts or dimensions were deactivated since the draft was saved.
    await validated(tx, organizationId, e.lines.map(toInput), e.source === "MANUAL");
    await assertCanApprove(tx, organizationId, userId, [e.createdById, e.submittedById, e.updatedById], cents(e.totalDebit));
    await assertPeriodOpen(tx, organizationId, e.date);
    const res = await tx.journalEntry.updateMany({
      where: { id: e.id, status: e.status },
      data: { status: "POSTED", postedById: userId, postedAt: new Date() },
    });
    if (res.count !== 1) throw new LedgerError(["Entry was changed by someone else; refresh and try again"]);
    await audit(tx, organizationId, userId, "journal.approve_post", e.id, { number: e.number });
  });
}

export async function rejectJournal(organizationId: string, userId: string, entryId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const e = await tx.journalEntry.findFirst({ where: { id: entryId, organizationId } });
    if (!e) throw new LedgerError(["Entry not found"]);
    if (e.status !== "PENDING_APPROVAL") throw new LedgerError(["Only entries waiting for approval can be returned"]);
    const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
    if (!m || !can(m.role, "journal.post")) throw new LedgerError(["You do not have rights to approve or reject entries"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason so the preparer knows what to fix"]);
    await tx.journalEntry.update({ where: { id: e.id }, data: { status: "DRAFT" } });
    await audit(tx, organizationId, userId, "journal.reject", e.id, { number: e.number, reason: reason.trim() });
  });
}

/** Drafts are voided (no GL effect). Posted entries are reversed with a new, linked entry. */
export async function voidOrReverse(organizationId: string, userId: string, entryId: string, reversalDate?: Date) {
  return prisma.$transaction((tx) => voidOrReverseTx(tx, organizationId, userId, entryId, reversalDate));
}

/** `fromSubledger`: the cash/bank module undoing its own entry (users must void the voucher instead). */
export async function voidOrReverseTx(tx: Tx, organizationId: string, userId: string, entryId: string, reversalDate?: Date, fromSubledger = false) {
  {
    const e = await tx.journalEntry.findFirst({ where: { id: entryId, organizationId }, include: { lines: true, reversedBy: true } });
    if (!e) throw new LedgerError(["Entry not found"]);
    if (e.source === "BANK" && e.sourceId && !fromSubledger) {
      throw new LedgerError(["This entry came from Cash and Bank. Void the cash voucher, or undo the bank adjustment on the reconciliation screen, instead."]);
    }
    if (e.lines.some((l) => l.clearedAt)) {
      throw new LedgerError(["This entry is already cleared against the bank statement. Undo the match on the bank reconciliation screen first."]);
    }
    if (e.status === "VOID") throw new LedgerError(["Entry is already void"]);
    if (e.status === "DRAFT" || e.status === "PENDING_APPROVAL") {
      await tx.journalEntry.update({ where: { id: e.id }, data: { status: "VOID", voidedById: userId, voidedAt: new Date() } });
      await audit(tx, organizationId, userId, "journal.void", e.id, { number: e.number });
      return null;
    }
    if (e.reversedBy) throw new LedgerError([`Already reversed by ${e.reversedBy.number}`]);
    if (e.source === "REVERSAL") throw new LedgerError(["A reversal entry cannot itself be reversed"]);
    if (e.source === "CLOSING") throw new LedgerError(["Reopen the fiscal year to undo a closing entry"]);
    if (e.intercompanyGroupId) throw new LedgerError(["Intercompany entries must be reversed together from the intercompany screen"]);
    return reverseTx(tx, organizationId, userId, e, reversalDate);
  }
}

type EntryWithLines = Prisma.JournalEntryGetPayload<{ include: { lines: true } }>;

async function reverseTx(tx: Tx, organizationId: string, userId: string, e: EntryWithLines, reversalDate?: Date, intercompanyGroupId?: string, skipPeriodCheck = false) {
  const date = asDay(reversalDate ?? e.date);
  if (!skipPeriodCheck) await assertPeriodOpen(tx, organizationId, date);
  const number = await nextNumber(tx, organizationId, "RV", date.getUTCFullYear());
  const rev = await tx.journalEntry.create({
    data: {
      organizationId,
      number,
      date,
      transactionDate: date,
      memo: `Reversal of ${e.number}: ${e.memo}`,
      reference: e.reference,
      status: "POSTED",
      book: e.book,
      // Undoing a year-end close stays a CLOSING entry so P&L reports keep ignoring it.
      source: e.source === "CLOSING" ? "CLOSING" : "REVERSAL",
      reversalOfId: e.id,
      intercompanyGroupId: intercompanyGroupId ?? null,
      totalDebit: e.totalCredit,
      totalCredit: e.totalDebit,
      createdById: userId,
      postedById: userId,
      postedAt: new Date(),
      lines: {
        create: e.lines.map(({ id: _id, journalEntryId: _j, debit, credit, fxDebit, fxCredit, clearedAt: _c, clearingRef: _r, ...rest }) => ({
          ...rest,
          debit: credit,
          credit: debit,
          fxDebit: fxCredit,
          fxCredit: fxDebit,
        })),
      },
    },
  });
  await audit(tx, organizationId, userId, "journal.reverse", e.id, { number: e.number, reversal: number });
  return rev;
}

// ---------- Multi-currency revaluation (IAS 21) ----------

/**
 * Revalue foreign-currency accounts (accounts with a currency set, e.g. a USD bank account)
 * at the closing rate. The difference goes to Unrealized FX Gain/Loss and the entry is set to
 * reverse automatically on the first day of the next month. Realized gains/losses are recorded
 * on settlement lines (Foreign Exchange Gain/Loss accounts).
 */
export async function revalueForeignCurrency(organizationId: string, userId: string, asOf: Date, rates: Record<string, string>) {
  const date = asDay(asOf);
  return prisma.$transaction(async (tx) => {
    const org = await orgOf(tx, organizationId);
    const accts = await tx.account.findMany({ where: { organizationId, currencyCode: { not: null }, isActive: true } });
    const gain = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: "UNREALIZED_FX_GAIN" } } });
    const loss = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: "UNREALIZED_FX_LOSS" } } });
    if (!gain || !loss) throw new LedgerError(["Assign the Unrealized FX Gain and Loss accounts first"]);
    const lines: { accountId: string; debit: bigint; credit: bigint; currencyCode: string; description: string }[] = [];
    let net = 0n;
    for (const a of accts) {
      if (a.currencyCode === org.baseCurrency) continue;
      const rate = rates[a.currencyCode!];
      if (!rate) throw new LedgerError([`Enter the closing rate for ${a.currencyCode}`]);
      const agg = await tx.journalLine.aggregate({
        where: { organizationId, accountId: a.id, journalEntry: { status: "POSTED", date: { lte: date } } },
        _sum: { debit: true, credit: true, fxDebit: true, fxCredit: true },
      });
      const fxBal = cents(agg._sum.fxDebit) - cents(agg._sum.fxCredit);
      const baseBal = cents(agg._sum.debit) - cents(agg._sum.credit);
      const target = (fxBal * toMicro(rate) + (fxBal >= 0n ? 500000n : -500000n)) / 1000000n;
      const diff = target - baseBal;
      if (diff === 0n) continue;
      lines.push({ accountId: a.id, debit: diff > 0n ? diff : 0n, credit: diff < 0n ? -diff : 0n, currencyCode: a.currencyCode!, description: `Revalue ${fromCentavos(fxBal)} ${a.currencyCode} at ${rate}` });
      net += diff;
    }
    if (!lines.length) return null;
    if (net > 0n) lines.push({ accountId: gain.id, debit: 0n, credit: net, currencyCode: org.baseCurrency, description: "Unrealized foreign exchange gain" });
    else lines.push({ accountId: loss.id, debit: -net, credit: 0n, currencyCode: org.baseCurrency, description: "Unrealized foreign exchange loss" });
    await assertPeriodOpen(tx, organizationId, date);
    const total = lines.reduce((s, l) => s + l.debit, 0n);
    const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    const number = await nextNumber(tx, organizationId, "FX", date.getUTCFullYear());
    const e = await tx.journalEntry.create({
      data: {
        organizationId, number, date, transactionDate: date, memo: `Unrealized FX revaluation as of ${date.toISOString().slice(0, 10)}`,
        status: "POSTED", source: "FX_REVALUATION", autoReverseOn: next, totalDebit: dec(total), totalCredit: dec(total),
        createdById: userId, postedById: userId, postedAt: new Date(),
        lines: { create: lines.map((l, i) => ({
          organizationId, lineNo: i + 1, accountId: l.accountId, description: l.description, debit: dec(l.debit), credit: dec(l.credit),
          // Base-only adjustment: forex amount stays 0, rate records the closing rate used.
          currencyCode: l.currencyCode, fxRate: new Prisma.Decimal(l.currencyCode === org.baseCurrency ? "1" : rates[l.currencyCode]), fxDebit: 0, fxCredit: 0,
        })) },
      },
    });
    await audit(tx, organizationId, userId, "fx.revalue", e.id, { number, rates });
    return e;
  });
}

/** Post the reversals of entries flagged to auto-reverse on or before `asOf`. */
export async function runAutoReversals(organizationId: string, userId: string, asOf: Date) {
  const due = await prisma.journalEntry.findMany({
    where: { organizationId, status: "POSTED", autoReverseOn: { lte: asDay(asOf) }, reversedBy: null },
    include: { lines: true },
  });
  const out = [];
  for (const e of due) {
    out.push(await prisma.$transaction((tx) => reverseTx(tx, organizationId, userId, e, e.autoReverseOn!)));
  }
  return out;
}

function toMicro(rate: string) {
  const s = rate.replace(/,/g, "").trim();
  if (!/^\d+(\.\d{0,6})?$/.test(s)) throw new LedgerError([`Invalid rate ${rate}`]);
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 1000000n + BigInt((f + "000000").slice(0, 6));
}

// ---------- Intercompany ----------

export type IntercompanySide = { organizationId: string; lines: LineInput[] };

/**
 * Record one transaction between two entities, posting a linked entry in each entity's books.
 * Each side lists only its own lines (e.g. Parent: Cr Cash 10,000; Subsidiary: Dr Rent 10,000).
 * The system adds the balancing "Due from"/"Due to" line on each side from the intercompany setup,
 * tags it with the counterparty (for consolidation eliminations), and checks both sides agree.
 */
export async function recordIntercompany(input: { userId: string; date: Date; memo: string; reference?: string | null; from: IntercompanySide; to: IntercompanySide }) {
  const { from, to } = input;
  if (from.organizationId === to.organizationId) throw new LedgerError(["Choose two different entities"]);
  return prisma.$transaction(async (tx) => {
    const groupId = randomUUID();
    const sides = [{ side: from, other: to.organizationId }, { side: to, other: from.organizationId }];
    const nets: bigint[] = [];
    const prepared: LineInput[][] = [];
    for (const { side, other } of sides) {
      const link = await tx.intercompanyLink.findUnique({ where: { organizationId_counterpartyOrgId: { organizationId: side.organizationId, counterpartyOrgId: other } } });
      if (!link) throw new LedgerError(["Intercompany accounts are not set up between these entities. Set them up under Entities and Intercompany."]);
      const org = await orgOf(tx, side.organizationId);
      const net = netOf(side.lines, org.baseCurrency); // >0: side has more debits, needs a credit
      if (net === 0n) throw new LedgerError(["Each side needs an amount that one entity owes the other"]);
      nets.push(net);
      const ic: LineInput = net > 0n
        ? { accountId: link.dueToAccountId, credit: fromCentavos(net), intercompanyOrgId: other, description: "Intercompany payable" }
        : { accountId: link.dueFromAccountId, debit: fromCentavos(-net), intercompanyOrgId: other, description: "Intercompany receivable" };
      prepared.push([...side.lines, ic]);
    }
    if (nets[0] !== -nets[1]) {
      throw new LedgerError([`The two sides don't agree (${fmt(abs(nets[0]))} vs ${fmt(abs(nets[1]))}). One entity must record as owed exactly what the other records as receivable, and on opposite sides.`]);
    }
    for (const s of sides) {
      const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId: input.userId, organizationId: s.side.organizationId } } });
      if (!m || !can(m.role, "journal.post")) throw new LedgerError(["You need posting rights in both entities"]);
    }
    const entries = [];
    for (let i = 0; i < 2; i++) {
      entries.push(await recordJournalTx(tx, {
        organizationId: sides[i].side.organizationId, userId: input.userId, date: input.date, memo: input.memo, reference: input.reference,
        lines: prepared[i], source: "INTERCOMPANY", action: "post", intercompanyGroupId: groupId,
      }));
    }
    return { groupId, entries };
  });
}

/** Net base-currency (debit - credit) of an incomplete set of lines. */
function netOf(lines: LineInput[], base: string) {
  const errs: string[] = [];
  let net = 0n;
  for (const l of lines) {
    // Validate each line by pairing it with its mirror, which always balances.
    const r = validateLines([l, { ...l, debit: l.credit, credit: l.debit }], base);
    if (!r.ok) errs.push(...r.errors.filter((e) => !/^Line 2/.test(e)));
    else net += r.lines[0].debit - r.lines[0].credit;
  }
  if (errs.length) throw new LedgerError(errs);
  return net;
}

/** Reverse both sides of an intercompany transaction together. */
export async function reverseIntercompany(userId: string, intercompanyGroupId: string, reversalDate?: Date) {
  return prisma.$transaction(async (tx) => {
    const es = await tx.journalEntry.findMany({ where: { intercompanyGroupId, source: "INTERCOMPANY" }, include: { lines: true, reversedBy: true } });
    if (es.length !== 2) throw new LedgerError(["Intercompany transaction not found"]);
    for (const e of es) {
      const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId: e.organizationId } } });
      if (!m || !can(m.role, "journal.void")) throw new LedgerError(["You need reversal rights in both entities"]);
    }
    if (es.some((e) => e.reversedBy)) throw new LedgerError(["Already reversed"]);
    const revGroup = randomUUID();
    const out = [];
    for (const e of es) out.push(await reverseTx(tx, e.organizationId, userId, e, reversalDate, revGroup));
    return out;
  });
}

/** Create Due from / Due to accounts in both entities and link them. */
export async function setupIntercompany(userId: string, aId: string, bId: string) {
  if (aId === bId) throw new LedgerError(["Choose two different entities"]);
  return prisma.$transaction(async (tx) => {
    for (const [self, other] of [[aId, bId], [bId, aId]]) {
      const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId: self } } });
      if (!m || !can(m.role, "masters.manage")) throw new LedgerError(["You need administrator rights in both entities"]);
      if (await tx.intercompanyLink.findUnique({ where: { organizationId_counterpartyOrgId: { organizationId: self, counterpartyOrgId: other } } })) continue;
      const o = await orgOf(tx, other);
      const tag = o.code ?? o.name.slice(0, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
      const parentA = await tx.account.findUnique({ where: { organizationId_code: { organizationId: self, code: "1000" } } });
      const parentL = await tx.account.findUnique({ where: { organizationId_code: { organizationId: self, code: "2000" } } });
      const dueFrom = await tx.account.create({ data: {
        organizationId: self, code: await freeCode(tx, self, "1130"), name: `Due from ${o.name}`, type: "ASSET", ifrsGroup: "Due from related parties",
        isCurrent: true, normalBalance: "DEBIT", parentId: parentA?.id ?? null, description: `Intercompany receivable from ${tag}`,
      } });
      const dueTo = await tx.account.create({ data: {
        organizationId: self, code: await freeCode(tx, self, "2085"), name: `Due to ${o.name}`, type: "LIABILITY", ifrsGroup: "Due to related parties",
        isCurrent: true, normalBalance: "CREDIT", parentId: parentL?.id ?? null, description: `Intercompany payable to ${tag}`,
      } });
      await tx.intercompanyLink.create({ data: { organizationId: self, counterpartyOrgId: other, dueFromAccountId: dueFrom.id, dueToAccountId: dueTo.id } });
      await audit(tx, self, userId, "intercompany.setup", other, { dueFrom: dueFrom.code, dueTo: dueTo.code }, null, null, "intercompany");
    }
  });
}

async function freeCode(tx: Tx, organizationId: string, start: string) {
  let n = Number(start);
  while (await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: String(n) } } })) n++;
  return String(n);
}

const abs = (x: bigint) => (x < 0n ? -x : x);
const fmt = (c: bigint) => (Number(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 });
const label = (s: string) => s.toLowerCase().replace("_", " ");

// ---------- Fiscal periods and year-end ----------

/** Fiscal year `year` ends in calendar year `year`. With a January start it is just the calendar year. */
export function fiscalYearRange(startMonth: number, year: number) {
  const startYear = startMonth === 1 ? year : year - 1;
  const start = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const end = new Date(Date.UTC(startYear + 1, startMonth - 1, 0));
  return { start, end };
}

export function fiscalYearOf(startMonth: number, d: Date) {
  const m = d.getUTCMonth() + 1;
  return startMonth === 1 || m < startMonth ? d.getUTCFullYear() : d.getUTCFullYear() + 1;
}

function monthsBetween(start: Date, end: Date) {
  const out: { year: number; month: number }[] = [];
  for (let d = new Date(start); d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    out.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  }
  return out;
}

export async function setPeriodStatus(organizationId: string, userId: string, year: number, month: number, status: "OPEN" | "CLOSED") {
  return prisma.$transaction(async (tx) => {
    const p = await tx.fiscalPeriod.findUnique({ where: { organizationId_year_month: { organizationId, year, month } } });
    if (p?.status === "LOCKED") throw new LedgerError(["This period is locked by year-end closing. Reopen the fiscal year first."]);
    const closed = status === "CLOSED";
    await tx.fiscalPeriod.upsert({
      where: { organizationId_year_month: { organizationId, year, month } },
      create: { organizationId, year, month, status, closedAt: closed ? new Date() : null, closedById: closed ? userId : null },
      update: { status, closedAt: closed ? new Date() : null, closedById: closed ? userId : null },
    });
    await audit(tx, organizationId, userId, closed ? "period.close" : "period.reopen", `${year}-${month}`, null, { status: p?.status ?? "OPEN" }, { status }, "period");
  });
}

/**
 * Year-end close: transfers every income and expense balance for the fiscal year to Retained
 * Earnings with a CLOSING entry dated the last day of the year, then locks all its periods.
 */
export async function closeFiscalYear(organizationId: string, userId: string, year: number) {
  return prisma.$transaction(async (tx) => {
    const org = await orgOf(tx, organizationId);
    const { start, end } = fiscalYearRange(org.fiscalYearStartMonth, year);
    const fy = await tx.fiscalYear.findUnique({ where: { organizationId_year: { organizationId, year } } });
    if (fy?.status === "CLOSED") throw new LedgerError([`FY${year} is already closed`]);
    const pending = await tx.journalEntry.count({ where: { organizationId, status: { in: ["DRAFT", "PENDING_APPROVAL"] }, date: { gte: start, lte: end } } });
    if (pending) throw new LedgerError([`There are ${pending} draft or unapproved entries in FY${year}. Post or void them first.`]);
    const prior = await tx.fiscalYear.findFirst({ where: { organizationId, year: { lt: year }, status: "OPEN" } });
    if (prior) throw new LedgerError([`Close FY${prior.year} first`]);
    const re = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: "RETAINED_EARNINGS" } } });
    if (!re) throw new LedgerError(["Assign a Retained Earnings account first"]);

    const sums = await tx.journalLine.groupBy({
      by: ["accountId"],
      where: { organizationId, account: { type: { in: ["INCOME", "EXPENSE"] } }, journalEntry: { status: "POSTED", book: "STATUTORY", date: { gte: start, lte: end } } },
      _sum: { debit: true, credit: true },
    });
    const lines: { accountId: string; debit: bigint; credit: bigint; description: string }[] = [];
    let net = 0n; // debit - credit of P&L = -(profit)
    for (const s of sums) {
      const bal = cents(s._sum.debit) - cents(s._sum.credit);
      if (bal === 0n) continue;
      lines.push({ accountId: s.accountId, debit: bal < 0n ? -bal : 0n, credit: bal > 0n ? bal : 0n, description: "Close to retained earnings" });
      net += bal;
    }
    let closingEntryId: string | null = null;
    if (lines.length) {
      // Profit (net < 0) is credited to retained earnings; a loss is debited.
      lines.push({ accountId: re.id, debit: net > 0n ? net : 0n, credit: net < 0n ? -net : 0n, description: net < 0n ? "Net profit for the year" : "Net loss for the year" });
      const total = lines.reduce((t, l) => t + l.debit, 0n);
      const number = await nextNumber(tx, organizationId, "CL", end.getUTCFullYear());
      const e = await tx.journalEntry.create({ data: {
        organizationId, number, date: end, transactionDate: end, memo: `Year-end closing FY${year}`, status: "POSTED", source: "CLOSING",
        totalDebit: dec(total), totalCredit: dec(total), createdById: userId, postedById: userId, postedAt: new Date(),
        lines: { create: lines.map((l, i) => ({ organizationId, lineNo: i + 1, accountId: l.accountId, description: l.description,
          debit: dec(l.debit), credit: dec(l.credit), fxDebit: dec(l.debit), fxCredit: dec(l.credit), currencyCode: org.baseCurrency })) },
      } });
      closingEntryId = e.id;
    }
    for (const { year: y, month } of monthsBetween(start, end)) {
      await tx.fiscalPeriod.upsert({
        where: { organizationId_year_month: { organizationId, year: y, month } },
        create: { organizationId, year: y, month, status: "LOCKED", closedAt: new Date(), closedById: userId },
        update: { status: "LOCKED", closedAt: new Date(), closedById: userId },
      });
    }
    await tx.fiscalYear.upsert({
      where: { organizationId_year: { organizationId, year } },
      create: { organizationId, year, startDate: start, endDate: end, status: "CLOSED", closingEntryId, closedAt: new Date(), closedById: userId },
      update: { status: "CLOSED", closingEntryId, closedAt: new Date(), closedById: userId },
    });
    await audit(tx, organizationId, userId, "fiscal_year.close", String(year), { netProfit: fromCentavos(-net) }, null, null, "fiscal_year");
    return { closingEntryId, netProfit: -net };
  }, { timeout: 60_000 });
}

/** Owner only: unlock a closed year by reversing its closing entry. */
export async function reopenFiscalYear(organizationId: string, userId: string, year: number) {
  return prisma.$transaction(async (tx) => {
    const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
    if (m?.role !== "OWNER") throw new LedgerError(["Only the owner can reopen a closed fiscal year"]);
    const fy = await tx.fiscalYear.findUnique({ where: { organizationId_year: { organizationId, year } } });
    if (!fy || fy.status !== "CLOSED") throw new LedgerError([`FY${year} is not closed`]);
    const later = await tx.fiscalYear.findFirst({ where: { organizationId, year: { gt: year }, status: "CLOSED" } });
    if (later) throw new LedgerError([`Reopen FY${later.year} first`]);
    if (fy.closingEntryId) {
      const e = await tx.journalEntry.findUniqueOrThrow({ where: { id: fy.closingEntryId }, include: { lines: true } });
      await reverseTx(tx, organizationId, userId, e, fy.endDate, undefined, true);
    }
    for (const { year: y, month } of monthsBetween(fy.startDate, fy.endDate)) {
      await tx.fiscalPeriod.update({ where: { organizationId_year_month: { organizationId, year: y, month } }, data: { status: "CLOSED" } });
    }
    await tx.fiscalYear.update({ where: { id: fy.id }, data: { status: "OPEN", closingEntryId: null, closedAt: null, closedById: null } });
    await audit(tx, organizationId, userId, "fiscal_year.reopen", String(year), null, null, null, "fiscal_year");
  });
}

// ---------- Lookups and setup ----------

/** Look up an account by its system role (e.g. "AR_CONTROL") so modules don't hard-code codes. */
export async function accountByRole(organizationId: string, systemRole: string) {
  const a = await prisma.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole } } });
  if (!a) throw new LedgerError([`No account is assigned the role ${systemRole}`]);
  return a;
}

/** Create the default PH/IFRS chart of accounts for a new company. */
export async function seedChartOfAccounts(tx: Tx, organizationId: string) {
  const idByCode = new Map<string, string>();
  for (const t of PH_IFRS_TEMPLATE) {
    const a = await tx.account.create({
      data: {
        organizationId,
        code: t.code,
        name: t.name,
        type: t.type,
        ifrsGroup: t.ifrsGroup,
        isCurrent: t.isCurrent ?? null,
        normalBalance: normalBalanceFor(t),
        isPostable: !t.header,
        systemRole: t.systemRole ?? null,
        parentId: t.parent ? idByCode.get(t.parent) ?? null : null,
      },
    });
    idByCode.set(t.code, a.id);
  }
}

function prefixFor(source: JournalSource) {
  const map: Partial<Record<JournalSource, string>> = {
    SALES: "SJ", PURCHASES: "PJ", BANK: "BK", INVENTORY: "IN", FIXED_ASSETS: "FA", PREPAID: "PP", LEASE: "LS", DEBT: "DB", PAYROLL: "PY", EXPENSE_CLAIM: "EC", TAX: "TX",
    OPENING_BALANCE: "OB", CLOSING: "CL", REVERSAL: "RV", INTERCOMPANY: "IC", CONSOLIDATION: "CA", FX_REVALUATION: "FX",
  };
  return map[source] ?? "JV";
}

export async function audit(
  tx: Tx, organizationId: string, userId: string | null, action: string, entityId: string,
  details: Prisma.InputJsonValue | null, before: Prisma.InputJsonValue | null = null, after: Prisma.InputJsonValue | null = null, entity = "journal",
) {
  await tx.auditLog.create({
    data: { organizationId, userId, action, entity, entityId, details: details ?? undefined, before: before ?? undefined, after: after ?? undefined },
  });
}
