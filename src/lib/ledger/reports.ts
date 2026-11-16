// Read-only reports over POSTED entries. Amounts are bigint centavos in the base currency.
import type { Account, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { toCentavos } from "../money";
import { DIMENSIONS, type DimKey } from "./dimensions";

const c = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");

export type ReportFilter = {
  dims?: Partial<Record<DimKey, string>>;
  includeConsolidation?: boolean; // include group-only adjustments
  excludeClosing?: boolean;       // ignore year-end closing entries (for P&L style reports)
  where?: Prisma.JournalLineWhereInput; // extra line conditions (custom report builder filters)
};

function lineWhere(organizationId: string | { in: string[] }, f: ReportFilter, date: Prisma.DateTimeFilter): Prisma.JournalLineWhereInput {
  const w: Prisma.JournalLineWhereInput = {
    organizationId,
    journalEntry: {
      status: "POSTED",
      date,
      ...(f.includeConsolidation ? {} : { book: "STATUTORY" }),
      ...(f.excludeClosing ? { source: { not: "CLOSING" } } : {}),
    },
  };
  for (const d of DIMENSIONS) {
    const v = f.dims?.[d.key];
    if (v) (w as Record<string, unknown>)[d.key] = v;
  }
  if (f.where) w.AND = [f.where];
  return w;
}

async function sums(organizationId: string, f: ReportFilter, date: Prisma.DateTimeFilter) {
  const rows = await prisma.journalLine.groupBy({ by: ["accountId"], where: lineWhere(organizationId, f, date), _sum: { debit: true, credit: true } });
  return new Map(rows.map((r) => [r.accountId, { debit: c(r._sum.debit), credit: c(r._sum.credit) }]));
}

const accountsOf = (organizationId: string) => prisma.account.findMany({ where: { organizationId }, orderBy: { code: "asc" } });

// ---------- Trial balance / account activity ----------

export type ActivityRow = {
  account: Account;
  opening: bigint; periodDebit: bigint; periodCredit: bigint; closing: bigint; // signed: debit positive
  debit: bigint; credit: bigint; // closing balance split by side
};

/** Opening balance, movement and closing balance per account for [from, to]. */
export async function accountActivity(organizationId: string, from: Date, to: Date, f: ReportFilter = {}) {
  const [accounts, before, during] = await Promise.all([accountsOf(organizationId), sums(organizationId, f, { lt: from }), sums(organizationId, f, { gte: from, lte: to })]);
  const rows: ActivityRow[] = [];
  let totalDebit = 0n, totalCredit = 0n, totalPD = 0n, totalPC = 0n;
  for (const account of accounts) {
    const b = before.get(account.id), m = during.get(account.id);
    if (!b && !m) continue;
    const opening = (b?.debit ?? 0n) - (b?.credit ?? 0n);
    const pd = m?.debit ?? 0n, pc = m?.credit ?? 0n;
    const closing = opening + pd - pc;
    if (opening === 0n && pd === 0n && pc === 0n) continue;
    const row = { account, opening, periodDebit: pd, periodCredit: pc, closing, debit: closing > 0n ? closing : 0n, credit: closing < 0n ? -closing : 0n };
    totalDebit += row.debit; totalCredit += row.credit; totalPD += pd; totalPC += pc;
    rows.push(row);
  }
  return { rows, totalDebit, totalCredit, totalPeriodDebit: totalPD, totalPeriodCredit: totalPC, balanced: totalDebit === totalCredit };
}

export const trialBalance = (organizationId: string, to: Date, from?: Date, f: ReportFilter = {}) =>
  accountActivity(organizationId, from ?? new Date("1900-01-01"), to, f);

// ---------- Account ledger / GL listing ----------

export type LedgerLine = {
  id: string; date: Date; transactionDate: Date; number: string; entryId: string; memo: string; description: string | null;
  reference: string | null; source: string; currencyCode: string; fxRate: string; fxDebit: bigint; fxCredit: bigint;
  debit: bigint; credit: bigint; balance: bigint;
};

export async function accountLedger(organizationId: string, accountId: string, from: Date, to: Date, f: ReportFilter = {}) {
  const account = await prisma.account.findFirst({ where: { id: accountId, organizationId } });
  if (!account) return null;
  const sign = account.normalBalance === "DEBIT" ? 1n : -1n;
  const open = await prisma.journalLine.aggregate({ where: { ...lineWhere(organizationId, f, { lt: from }), accountId }, _sum: { debit: true, credit: true } });
  const opening = sign * (c(open._sum.debit) - c(open._sum.credit));
  const raw = await prisma.journalLine.findMany({
    where: { ...lineWhere(organizationId, f, { gte: from, lte: to }), accountId },
    include: { journalEntry: true },
    orderBy: [{ journalEntry: { date: "asc" } }, { journalEntry: { number: "asc" } }, { lineNo: "asc" }],
  });
  let bal = opening, totalDebit = 0n, totalCredit = 0n;
  const lines: LedgerLine[] = raw.map((l) => {
    const d = c(l.debit), cr = c(l.credit);
    totalDebit += d; totalCredit += cr; bal += sign * (d - cr);
    return {
      id: l.id, date: l.journalEntry.date, transactionDate: l.journalEntry.transactionDate, number: l.journalEntry.number, entryId: l.journalEntryId,
      memo: l.journalEntry.memo, description: l.description, reference: l.journalEntry.reference, source: l.journalEntry.source,
      currencyCode: l.currencyCode, fxRate: l.fxRate.toString(), fxDebit: c(l.fxDebit), fxCredit: c(l.fxCredit), debit: d, credit: cr, balance: bal,
    };
  });
  return { account, opening, lines, totalDebit, totalCredit, closing: bal };
}

// ---------- Financial statements ----------

export type StatementLine = { label: string; amount: bigint; accounts?: { id: string; code: string; name: string; amount: bigint }[] };
export type StatementSection = { title: string; lines: StatementLine[]; total: bigint };

function groupBy(rows: { account: Account; amount: bigint }[]): StatementLine[] {
  const m = new Map<string, StatementLine>();
  for (const r of rows) {
    if (r.amount === 0n) continue;
    const g = m.get(r.account.ifrsGroup) ?? { label: r.account.ifrsGroup, amount: 0n, accounts: [] };
    g.amount += r.amount;
    g.accounts!.push({ id: r.account.id, code: r.account.code, name: r.account.name, amount: r.amount });
    m.set(r.account.ifrsGroup, g);
  }
  return [...m.values()];
}
const section = (title: string, lines: StatementLine[]): StatementSection => ({ title, lines, total: lines.reduce((s, l) => s + l.amount, 0n) });

const COS = new Set(["Cost of sales"]);
const FIN_COST = new Set(["Finance costs"]);
const FIN_INC = new Set(["Finance income"]);
const OTHER_EXP = new Set(["Other expenses"]);
const TAX = new Set(["Income tax expense"]);

/** Statement of profit or loss for [from, to] (PAS 1 by-function layout). */
export async function incomeStatement(organizationId: string, from: Date, to: Date, f: ReportFilter = {}) {
  const [accounts, m] = await Promise.all([accountsOf(organizationId), sums(organizationId, { ...f, excludeClosing: true }, { gte: from, lte: to })]);
  const amt = (a: Account) => {
    const s = m.get(a.id);
    if (!s) return 0n;
    return a.type === "INCOME" ? s.credit - s.debit : s.debit - s.credit;
  };
  const inc = accounts.filter((a) => a.type === "INCOME").map((a) => ({ account: a, amount: amt(a) }));
  const exp = accounts.filter((a) => a.type === "EXPENSE").map((a) => ({ account: a, amount: amt(a) }));
  const revenue = section("Revenue", groupBy(inc.filter((r) => r.account.ifrsGroup === "Revenue")));
  const cos = section("Cost of sales", groupBy(exp.filter((r) => COS.has(r.account.ifrsGroup))));
  const grossProfit = revenue.total - cos.total;
  const otherIncome = section("Other income", groupBy(inc.filter((r) => r.account.ifrsGroup !== "Revenue" && !FIN_INC.has(r.account.ifrsGroup))));
  const opex = section("Operating expenses", groupBy(exp.filter((r) => !COS.has(r.account.ifrsGroup) && !FIN_COST.has(r.account.ifrsGroup) && !OTHER_EXP.has(r.account.ifrsGroup) && !TAX.has(r.account.ifrsGroup))));
  const otherExp = section("Other expenses", groupBy(exp.filter((r) => OTHER_EXP.has(r.account.ifrsGroup))));
  const operatingProfit = grossProfit + otherIncome.total - opex.total - otherExp.total;
  const finInc = section("Finance income", groupBy(inc.filter((r) => FIN_INC.has(r.account.ifrsGroup))));
  const finCost = section("Finance costs", groupBy(exp.filter((r) => FIN_COST.has(r.account.ifrsGroup))));
  const profitBeforeTax = operatingProfit + finInc.total - finCost.total;
  const tax = section("Income tax expense", groupBy(exp.filter((r) => TAX.has(r.account.ifrsGroup))));
  const netProfit = profitBeforeTax - tax.total;
  return { revenue, cos, grossProfit, otherIncome, opex, otherExp, operatingProfit, finInc, finCost, profitBeforeTax, tax, netProfit };
}

/** Statement of financial position as of `asOf`. Unclosed profit is shown in equity. */
export async function balanceSheet(organizationId: string, asOf: Date, f: ReportFilter = {}) {
  const [accounts, m] = await Promise.all([accountsOf(organizationId), sums(organizationId, f, { lte: asOf })]);
  const bal = (a: Account) => {
    const s = m.get(a.id);
    if (!s) return 0n;
    return a.type === "ASSET" ? s.debit - s.credit : s.credit - s.debit;
  };
  const rows = accounts.map((a) => ({ account: a, amount: bal(a) }));
  const ca = section("Current assets", groupBy(rows.filter((r) => r.account.type === "ASSET" && r.account.isCurrent !== false)));
  const nca = section("Non-current assets", groupBy(rows.filter((r) => r.account.type === "ASSET" && r.account.isCurrent === false)));
  const cl = section("Current liabilities", groupBy(rows.filter((r) => r.account.type === "LIABILITY" && r.account.isCurrent !== false)));
  const ncl = section("Non-current liabilities", groupBy(rows.filter((r) => r.account.type === "LIABILITY" && r.account.isCurrent === false)));
  const pl = rows.filter((r) => r.account.type === "INCOME" || r.account.type === "EXPENSE");
  // Income/expense balances not yet closed to retained earnings (credit positive).
  const unclosed = pl.reduce((s, r) => {
    const x = m.get(r.account.id);
    return s + (x ? x.credit - x.debit : 0n);
  }, 0n);
  const eqLines = groupBy(rows.filter((r) => r.account.type === "EQUITY"));
  if (unclosed !== 0n) eqLines.push({ label: "Profit for the year (not yet closed)", amount: unclosed });
  const equity = section("Equity", eqLines);
  const totalAssets = ca.total + nca.total;
  const totalLiabilities = cl.total + ncl.total;
  return { ca, nca, totalAssets, cl, ncl, totalLiabilities, equity, totalLE: totalLiabilities + equity.total, balanced: totalAssets === totalLiabilities + equity.total };
}

/**
 * Statement of cash flows, indirect method (PAS 7). Every non-cash balance sheet movement is
 * classified, so the statement always reconciles to the change in cash.
 */
export async function cashFlow(organizationId: string, from: Date, to: Date, f: ReportFilter = {}) {
  const ff = { ...f, excludeClosing: true };
  const [accounts, m, open, close, is] = await Promise.all([
    accountsOf(organizationId),
    sums(organizationId, ff, { gte: from, lte: to }),
    sums(organizationId, f, { lt: from }),
    sums(organizationId, f, { lte: to }),
    incomeStatement(organizationId, from, to, f),
  ]);
  const isCash = (a: Account) => a.ifrsGroup === "Cash and cash equivalents";
  const effect = (a: Account) => { const s = m.get(a.id); return s ? s.credit - s.debit : 0n; }; // cash effect of a non-cash account movement
  const isAccumDep = (a: Account) => a.type === "ASSET" && a.normalBalance === "CREDIT" && /depreciation|amortization/i.test(a.name);
  const op: StatementLine[] = [{ label: "Profit for the period", amount: is.netProfit }];
  const inv: StatementLine[] = [], fin: StatementLine[] = [];
  const add = (arr: StatementLine[], label: string, amount: bigint) => {
    if (amount === 0n) return;
    const x = arr.find((l) => l.label === label);
    if (x) x.amount += amount; else arr.push({ label, amount });
  };
  for (const a of accounts) {
    if (a.type === "INCOME" || a.type === "EXPENSE" || isCash(a)) continue;
    const e = effect(a);
    if (e === 0n) continue;
    if (isAccumDep(a)) add(op, "Depreciation and amortization", e);
    else if (a.type === "ASSET" && a.isCurrent !== false) add(op, `(Increase) decrease in ${a.ifrsGroup.toLowerCase()}`, e);
    else if (a.type === "LIABILITY" && a.isCurrent !== false && !/loans|lease/i.test(a.ifrsGroup)) add(op, `Increase (decrease) in ${a.ifrsGroup.toLowerCase()}`, e);
    else if (a.type === "ASSET") add(inv, `Acquisition / disposal of ${a.ifrsGroup.toLowerCase()}`, e);
    else add(fin, a.type === "EQUITY" ? `Movement in ${a.ifrsGroup.toLowerCase()}` : `Proceeds / repayment of ${a.ifrsGroup.toLowerCase()}`, e);
  }
  const operating = section("Cash flows from operating activities", op);
  const investing = section("Cash flows from investing activities", inv);
  const financing = section("Cash flows from financing activities", fin);
  const cashOf = (s: Map<string, { debit: bigint; credit: bigint }>) => accounts.filter(isCash).reduce((t, a) => { const x = s.get(a.id); return t + (x ? x.debit - x.credit : 0n); }, 0n);
  const openingCash = cashOf(open), closingCash = cashOf(close);
  const netChange = operating.total + investing.total + financing.total;
  return { operating, investing, financing, netChange, openingCash, closingCash, reconciles: openingCash + netChange === closingCash };
}

// ---------- Budget vs actual ----------

export async function budgetVsActual(organizationId: string, fiscalYear: number, start: Date, monthFrom: number, monthTo: number, dimensionValueId?: string) {
  const budgets = await prisma.budget.findMany({ where: { organizationId, fiscalYear, dimensionValueId: dimensionValueId ?? null } });
  const accounts = await accountsOf(organizationId);
  const from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + monthFrom - 1, 1));
  const to = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + monthTo, 0));
  let dims: Partial<Record<DimKey, string>> | undefined;
  if (dimensionValueId) {
    const dv = await prisma.dimensionValue.findUnique({ where: { id: dimensionValueId } });
    if (dv) dims = { [DIMENSIONS.find((d) => d.type === dv.type)!.key]: dv.id };
  }
  const act = await sums(organizationId, { excludeClosing: true, dims }, { gte: from, lte: to });
  const rows = [];
  for (const a of accounts) {
    const b = budgets.find((x) => x.accountId === a.id);
    const s = act.get(a.id);
    if (!b && !s) continue;
    let budget = 0n, annual = 0n;
    if (b) for (let i = 1; i <= 12; i++) {
      const v = c((b as unknown as Record<string, { toString(): string }>)[`m${i}`]);
      annual += v;
      if (i >= monthFrom && i <= monthTo) budget += v;
    }
    const natural = a.normalBalance === "DEBIT" ? 1n : -1n;
    const actual = s ? natural * (s.debit - s.credit) : 0n;
    // Favourable variance: income above budget, expense below budget.
    const variance = a.type === "INCOME" ? actual - budget : budget - actual;
    rows.push({ account: a, annual, budget, actual, variance, pct: budget === 0n ? null : Number((variance * 10000n) / (budget < 0n ? -budget : budget)) / 100 });
  }
  return { rows, from, to };
}

// ---------- Consolidation ----------

/**
 * Consolidated trial balance for a group of entities (same base currency). Intercompany lines
 * (tagged with a counterparty inside the group) are eliminated, and group-only consolidation
 * adjustments are added.
 */
export async function consolidatedTrialBalance(orgIds: string[], asOf: Date) {
  const where = (extra: Prisma.JournalLineWhereInput): Prisma.JournalLineWhereInput => ({
    organizationId: { in: orgIds }, journalEntry: { status: "POSTED", date: { lte: asOf }, book: "STATUTORY" }, ...extra,
  });
  const [accounts, all, ic, adj] = await Promise.all([
    prisma.account.findMany({ where: { organizationId: { in: orgIds } } }),
    prisma.journalLine.groupBy({ by: ["accountId"], where: where({}), _sum: { debit: true, credit: true } }),
    prisma.journalLine.groupBy({ by: ["accountId"], where: where({ intercompanyOrgId: { in: orgIds } }), _sum: { debit: true, credit: true } }),
    prisma.journalLine.groupBy({ by: ["accountId"], where: { organizationId: { in: orgIds }, journalEntry: { status: "POSTED", date: { lte: asOf }, book: "CONSOLIDATION" } }, _sum: { debit: true, credit: true } }),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  type Row = { code: string; name: string; type: string; entities: Map<string, bigint>; combined: bigint; elimination: bigint; adjustment: bigint; consolidated: bigint };
  const rows = new Map<string, Row>();
  const get = (accountId: string) => {
    const a = byId.get(accountId)!;
    // Intercompany accounts are per counterparty; roll them up by IFRS group so they net to zero.
    const key = a.ifrsGroup.startsWith("Due ") ? `IC:${a.ifrsGroup}` : a.code;
    let r = rows.get(key);
    if (!r) { r = { code: key.startsWith("IC:") ? "—" : a.code, name: key.startsWith("IC:") ? a.ifrsGroup : a.name, type: a.type, entities: new Map(), combined: 0n, elimination: 0n, adjustment: 0n, consolidated: 0n }; rows.set(key, r); }
    return { r, a };
  };
  for (const s of all) { const { r, a } = get(s.accountId); const v = c(s._sum.debit) - c(s._sum.credit); r.entities.set(a.organizationId, (r.entities.get(a.organizationId) ?? 0n) + v); r.combined += v; }
  for (const s of ic) { const { r } = get(s.accountId); r.elimination -= c(s._sum.debit) - c(s._sum.credit); }
  for (const s of adj) { const { r } = get(s.accountId); r.adjustment += c(s._sum.debit) - c(s._sum.credit); }
  const list = [...rows.values()].map((r) => ({ ...r, consolidated: r.combined + r.elimination + r.adjustment })).sort((a, b) => a.code.localeCompare(b.code));
  return { rows: list, total: list.reduce((s, r) => s + r.consolidated, 0n) };
}

// ---------- KPIs ----------

export async function kpis(organizationId: string, from: Date, to: Date) {
  const [is, bs] = await Promise.all([incomeStatement(organizationId, from, to), balanceSheet(organizationId, to)]);
  const cashLine = bs.ca.lines.find((l) => l.label === "Cash and cash equivalents");
  const ratio = (a: bigint, b: bigint) => (b === 0n ? null : Number((a * 10000n) / b) / 10000);
  return {
    revenue: is.revenue.total,
    grossProfit: is.grossProfit,
    grossMarginPct: is.revenue.total === 0n ? null : Number((is.grossProfit * 10000n) / is.revenue.total) / 100,
    opex: is.opex.total,
    netProfit: is.netProfit,
    netMarginPct: is.revenue.total === 0n ? null : Number((is.netProfit * 10000n) / is.revenue.total) / 100,
    currentRatio: ratio(bs.ca.total, bs.cl.total),
    debtToEquity: ratio(bs.totalLiabilities, bs.equity.total),
    workingCapital: bs.ca.total - bs.cl.total,
    cash: cashLine?.amount ?? 0n,
  };
}

/** Expense by dimension value (e.g. cost per department or project) for a period. */
export async function costByDimension(organizationId: string, key: DimKey, from: Date, to: Date) {
  const rows = await prisma.journalLine.groupBy({
    by: [key],
    where: { organizationId, account: { type: "EXPENSE" }, journalEntry: { status: "POSTED", book: "STATUTORY", source: { not: "CLOSING" }, date: { gte: from, lte: to } } },
    _sum: { debit: true, credit: true },
  });
  const ids = rows.map((r) => (r as Record<string, unknown>)[key] as string | null).filter(Boolean) as string[];
  const vals = await prisma.dimensionValue.findMany({ where: { id: { in: ids } } });
  return rows.map((r) => {
    const id = (r as Record<string, unknown>)[key] as string | null;
    const v = vals.find((x) => x.id === id);
    return { id, label: v ? `${v.code} · ${v.name}` : "(not tagged)", amount: c(r._sum.debit) - c(r._sum.credit) };
  }).sort((a, b) => (b.amount > a.amount ? 1 : -1));
}
