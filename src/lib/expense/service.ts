// Expense & Mobility: setup for the app, GL mapping, corporate statement reconciliation and reports.
// Vouchers themselves live in ../pettycash/service.ts (one record per receipt for every module).
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { can } from "../permissions";
import { LedgerError, asDay, audit, nextNumber } from "../ledger/service";
import { confirmMatches, workbench } from "../bank/recon";
import { employeeOfUser, mappedAccount } from "../pettycash/service";
import { setupData } from "../pettycash/service";
import { DETAIL_FIELDS, AMOUNT_FIELDS, MODULES, PAYMENTS, PROVIDERS, TRANSACTION_TYPES, walletMatches, type ModuleKey, type PaymentKey } from "./catalog";

const cents = (d: Prisma.Decimal | null | undefined) => toCentavos(d?.toString() ?? "0");
const m2 = (d: Prisma.Decimal | null | undefined) => fromCentavos(cents(d));
const empName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`;

/** Everything the Veritus Mobility app needs to show the module tiles and forms. */
export async function mobilitySetup(organizationId: string, userId: string) {
  const base = await setupData(organizationId);
  return prisma.$transaction(async (tx) => {
    const [me, employees, banks, currencies, customers] = await Promise.all([
      employeeOfUser(tx, organizationId, userId),
      tx.employee.findMany({ where: { organizationId, isActive: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }] }),
      tx.bankAccount.findMany({ where: { organizationId, isActive: true, kind: { in: ["EWALLET", "CREDIT_CARD", "CURRENT", "SAVINGS"] } }, orderBy: { code: "asc" } }),
      tx.currency.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
      tx.customer.findMany({ where: { organizationId, isActive: true }, orderBy: { name: "asc" }, select: { id: true, code: true, name: true, tin: true } }),
    ]);
    const types = await Promise.all(TRANSACTION_TYPES.map(async (t) => {
      const a = await mappedAccount(tx, organizationId, t.key);
      return { key: t.key, label: t.label, module: t.module, account: a ? { id: a.id, code: a.code, name: a.name } : null };
    }));
    const payments = (Object.keys(PAYMENTS) as PaymentKey[]).map((k) => ({
      key: k, label: PAYMENTS[k].label, corporate: PAYMENTS[k].corporate,
      accounts: banks.filter((b) => PAYMENTS[k].kinds.includes(b.kind) && (b.kind !== "EWALLET" || walletMatches(k, b.name)))
        .map((b) => ({ id: b.id, code: b.code, name: b.name, kind: b.kind })),
    }));
    return {
      ...base,
      me: me ? { id: me.id, code: me.code, name: empName(me), department: me.department, costCenter: me.costCenter, projectCode: me.projectCode, businessUnit: me.businessUnit, supervisorCode: me.supervisorCode } : null,
      employees: employees.map((e) => ({ id: e.id, code: e.code, name: empName(e), department: e.department, isPartner: e.isPartner })),
      modules: (Object.keys(MODULES) as ModuleKey[]).map((k) => ({ key: k, ...MODULES[k], providers: PROVIDERS[k], detailFields: DETAIL_FIELDS[k], amountFields: AMOUNT_FIELDS[k] })),
      transactionTypes: types,
      payments,
      customers,
      currencies: currencies.map((c) => ({ code: c.code, name: c.name, rate: c.rateToBase.toString() })),
    };
  });
}

// ---------- GL mapping ----------

export async function mappingTable(organizationId: string) {
  return prisma.$transaction(async (tx) => Promise.all(TRANSACTION_TYPES.map(async (t) => {
    const a = await mappedAccount(tx, organizationId, t.key);
    const custom = await tx.expenseMapping.findUnique({ where: { organizationId_transactionType: { organizationId, transactionType: t.key } } });
    return { ...t, account: a ? { id: a.id, code: a.code, name: a.name } : null, custom: !!custom };
  })));
}

export async function saveMapping(organizationId: string, userId: string, transactionType: string, accountId: string | null) {
  return prisma.$transaction(async (tx) => {
    const t = TRANSACTION_TYPES.find((x) => x.key === transactionType);
    if (!t) throw new LedgerError(["Unknown transaction type"]);
    if (!accountId) {
      await tx.expenseMapping.deleteMany({ where: { organizationId, transactionType } });
    } else {
      const a = await tx.account.findFirst({ where: { id: accountId, organizationId, isActive: true, isPostable: true } });
      if (!a) throw new LedgerError(["Choose an active posting account"]);
      if (a.type !== "EXPENSE" && a.systemRole !== "INVENTORY_IN_TRANSIT") throw new LedgerError([`${a.code} ${a.name} is not an expense account`]);
      await tx.expenseMapping.upsert({ where: { organizationId_transactionType: { organizationId, transactionType } }, create: { organizationId, transactionType, accountId }, update: { accountId } });
    }
    await audit(tx, organizationId, userId, "expense.mapping", transactionType, { transactionType, accountId }, null, null, "expense_mapping");
  });
}

// ---------- Corporate statement reconciliation ----------

const MOBILITY_RE = /\b(grab|indrive|in drive|joyride|angkas|move ?it|lalamove|transportify|deliveree|borzo|mr\.? ?speedy|lbc|j&t|toll|easytrip|autosweep|parking|taxi|uber|airline|cebu pacific|philippine airlines|airasia|hotel|agoda|booking\.com)\b/i;

/** Corporate payment accounts (GCash, Maya, cards, bank for debit cards) with claim and statement status. */
export async function reconciliationStatus(organizationId: string) {
  const usedBy = await prisma.pettyCashVoucher.groupBy({ by: ["paymentAccountId"], where: { organizationId, paymentAccountId: { not: null } }, _count: true });
  const accounts = await prisma.bankAccount.findMany({ where: { organizationId, isActive: true, OR: [{ kind: { in: ["EWALLET", "CREDIT_CARD"] } }, { id: { in: usedBy.map((u) => u.paymentAccountId!) } }] }, orderBy: { code: "asc" } });
  const out = [];
  for (const b of accounts) {
    const claims = await prisma.pettyCashVoucher.findMany({ where: { organizationId, paymentAccountId: b.id, journalEntryId: { not: null } }, orderBy: { receiptDate: "desc" }, take: 300 });
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: { in: claims.map((c) => c.journalEntryId!) }, accountId: b.glAccountId } });
    const byEntry = new Map(lines.map((l) => [l.journalEntryId, l]));
    const rows = claims.map((c) => {
      const l = byEntry.get(c.journalEntryId!);
      return { id: c.id, number: c.number, date: c.receiptDate.toISOString().slice(0, 10), provider: c.provider, bookingNumber: c.bookingNumber, description: c.description, amount: m2(c.totalPaid), reconciled: !!l?.clearedAt, clearedAt: l?.clearedAt ?? null };
    });
    const open = await prisma.bankStatementLine.findMany({ where: { organizationId, bankAccountId: b.id, matchId: null, amount: { lt: 0 } }, orderBy: { date: "asc" } });
    const linked = new Set((await prisma.pettyCashVoucher.findMany({ where: { organizationId, statementLineId: { in: open.map((o) => o.id) }, status: { not: "REJECTED" } }, select: { statementLineId: true } })).map((x) => x.statementLineId));
    // For wallets and cards every unmatched charge is an exception; for a bank, only ones that look like mobility.
    const exceptions = open.filter((o) => (b.kind === "EWALLET" || b.kind === "CREDIT_CARD" || MOBILITY_RE.test(o.description)) && !linked.has(o.id)).map((o) => ({
      id: o.id, date: o.date.toISOString().slice(0, 10), description: o.description, reference: o.reference, amount: fromCentavos(-cents(o.amount)), mobility: MOBILITY_RE.test(o.description),
    }));
    out.push({
      account: { id: b.id, code: b.code, name: b.name, kind: b.kind },
      claims: rows, reconciled: rows.filter((r) => r.reconciled).length, unreconciled: rows.filter((r) => !r.reconciled).length,
      exceptions, statementLinesOpen: open.length,
    });
  }
  return out;
}

/** Clear corporate-paid claims against statement lines where the match is clear (amount + booking no. / date). */
export async function autoReconcile(organizationId: string, userId: string, bankAccountId: string) {
  const wb = await workbench(organizationId, bankAccountId);
  const claimEntryIds = new Set(wb.bookRows.filter((r) => r.source === "EXPENSE_CLAIM").map((r) => r.id));
  const groups = wb.suggestions.filter((s) => s.confidence === "high" && s.bookIds.every((id) => claimEntryIds.has(id))).map((s) => ({ bankIds: s.bankIds, bookIds: s.bookIds }));
  if (!groups.length) return 0;
  return confirmMatches(organizationId, userId, bankAccountId, groups, "SUGGESTED");
}

/**
 * Exception: a GCash / Maya / card charge with no claim. Finance sends it to the employee as a returned claim
 * to add the receipt, purpose and trip details; once cleared it posts and clears against this statement line.
 */
export async function claimFromStatementLine(organizationId: string, userId: string, input: { statementLineId: string; employeeId: string; module: ModuleKey; note?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
    if (!m || !can(m.role, "expense.finance")) throw new LedgerError(["Only finance can do this"]);
    const sl = await tx.bankStatementLine.findFirst({ where: { id: input.statementLineId, organizationId, matchId: null } });
    if (!sl) throw new LedgerError(["Statement line not found or already matched"]);
    if (cents(sl.amount) >= 0n) throw new LedgerError(["Only charges (money out) can become claims"]);
    if (await tx.pettyCashVoucher.findFirst({ where: { organizationId, statementLineId: sl.id, status: { not: "REJECTED" } } })) throw new LedgerError(["A claim already exists for this charge"]);
    const emp = await tx.employee.findFirst({ where: { id: input.employeeId, organizationId } });
    if (!emp) throw new LedgerError(["Choose the employee who made this charge"]);
    if (!MODULES[input.module] || input.module === "PETTY_CASH") throw new LedgerError(["Choose Travel, Transport or Sent Package"]);
    const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: sl.bankAccountId } });
    const payment: PaymentKey = bank.kind === "CREDIT_CARD" ? "CREDIT_CARD" : bank.kind === "EWALLET" ? (/maya/i.test(bank.name) ? "MAYA" : /g\s?cash/i.test(bank.name) ? "GCASH" : "CORPORATE_WALLET") : "DEBIT_CARD";
    const empUser = emp.email ? await tx.user.findFirst({ where: { email: { equals: emp.email, mode: "insensitive" } } }) : null;
    const member = empUser ? await tx.membership.findUnique({ where: { userId_organizationId: { userId: empUser.id, organizationId } } }) : null;
    const amount = fromCentavos(-cents(sl.amount));
    const provider = PROVIDERS[input.module].find((p) => new RegExp(p.name.replace(/[^a-z]/gi, ".?"), "i").test(sl.description))?.key ?? "OTHER";
    const account = await mappedAccount(tx, organizationId, input.module === "TRANSPORT" ? "RIDE" : input.module === "DELIVERY" ? "DELIVERY" : "TRAVEL_LOCAL");
    if (!account) throw new LedgerError(["Map the GL account for this transaction type in Mobility Settings first"]);
    const number = await nextNumber(tx, organizationId, "PCV", sl.date.getUTCFullYear());
    const v = await tx.pettyCashVoucher.create({ data: {
      organizationId, number, createdById: member ? empUser!.id : userId, status: "RETURNED",
      rejectedReason: `Charge on ${bank.name} on ${sl.date.toISOString().slice(0, 10)} (${sl.description}) has no claim. Add the receipt, purpose and details, then submit.${input.note?.trim() ? ` ${input.note.trim()}` : ""}`,
      module: input.module, paymentMethod: payment, paymentAccountId: bank.id, employeeId: emp.id, provider, bookingNumber: sl.reference || null,
      transactionType: input.module === "TRANSPORT" ? "RIDE" : input.module === "DELIVERY" ? "DELIVERY" : "TRAVEL_LOCAL",
      statementLineId: sl.id, receiptDate: sl.date, docType: "OTHER", vendorName: PROVIDERS[input.module].find((p) => p.key === provider)?.name ?? sl.description.slice(0, 80),
      vendorVatRegistered: false, description: sl.description.slice(0, 250), grossAmount: new Prisma.Decimal(amount), totalPaid: new Prisma.Decimal(amount),
      lines: { create: [{ lineNo: 1, description: sl.description.slice(0, 250), quantity: new Prisma.Decimal(1), unitPrice: new Prisma.Decimal(amount), amount: new Prisma.Decimal(amount), accountId: account.id }] },
    } });
    await audit(tx, organizationId, userId, "expense.claim_from_statement", v.id, { number, statementLineId: sl.id, employee: emp.code }, null, null, "pettycash_voucher");
    return { id: v.id, number };
  });
}

// ---------- Reports and KPIs ----------

const RECORDED = ["CLEARED", "BATCHED", "REPLENISHED", "REIMBURSED"] as const;
const PENDING = ["SUBMITTED", "APPROVED", "HOLD", "RETURNED"] as const;

export type Range = { from?: string | null; to?: string | null };
function rangeWhere(r: Range): Prisma.PettyCashVoucherWhereInput {
  return r.from || r.to ? { receiptDate: { ...(r.from ? { gte: asDay(r.from) } : {}), ...(r.to ? { lte: asDay(r.to) } : {}) } } : {};
}
/** Expense cost of a voucher: net of input VAT, plus tips. */
const cost = (v: { grossAmount: Prisma.Decimal; vatAmount: Prisma.Decimal; tipAmount: Prisma.Decimal }) => cents(v.grossAmount) - cents(v.vatAmount) + cents(v.tipAmount);

type Agg = { key: string; label: string; amount: bigint; count: number };
function group<T>(rows: T[], key: (r: T) => string, label: (r: T) => string, amt: (r: T) => bigint): Agg[] {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    const k = key(r);
    const g = m.get(k) ?? { key: k, label: label(r), amount: 0n, count: 0 };
    g.amount += amt(r); g.count++;
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}
const out = (a: Agg[]) => a.map((g) => ({ ...g, amount: fromCentavos(g.amount) }));

/** Dashboard KPIs for management. */
export async function mobilityDashboard(organizationId: string, r: Range) {
  const [rows, pending, emps, dims, recon] = await Promise.all([
    prisma.pettyCashVoucher.findMany({ where: { organizationId, status: { in: [...RECORDED] }, ...rangeWhere(r) } }),
    prisma.pettyCashVoucher.findMany({ where: { organizationId, status: { in: [...PENDING] }, ...rangeWhere(r) } }),
    prisma.employee.findMany({ where: { organizationId } }),
    prisma.dimensionValue.findMany({ where: { organizationId, type: { in: ["DEPARTMENT", "PROJECT", "COST_CENTER"] } } }),
    reconciliationStatus(organizationId),
  ]);
  const emp = new Map(emps.map((e) => [e.id, e]));
  const dim = new Map(dims.map((d) => [d.id, d]));
  const eLabel = (id: string | null) => (id && emp.get(id) ? empName(emp.get(id)!) : "Not assigned");
  const dLabel = (id: string | null) => (id && dim.get(id) ? `${dim.get(id)!.code} ${dim.get(id)!.name}` : "Not assigned");
  const sum = (xs: typeof rows) => xs.reduce((s, v) => s + cost(v), 0n);
  const transport = rows.filter((v) => v.module === "TRANSPORT" || v.module === "TRAVEL");
  const delivery = rows.filter((v) => v.module === "DELIVERY");
  const mob = rows.filter((v) => v.module !== "PETTY_CASH");

  // Budget vs actual travel cost: budgets on the accounts mapped to transport / travel types.
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const year = (r.to ? new Date(r.to) : new Date()).getUTCFullYear();
  const travelAccts = await prisma.$transaction(async (tx) => {
    const ids = new Set<string>();
    for (const t of TRANSACTION_TYPES.filter((x) => x.module !== "DELIVERY")) { const a = await mappedAccount(tx, organizationId, t.key); if (a) ids.add(a.id); }
    return [...ids];
  });
  const budgets = await prisma.budget.findMany({ where: { organizationId, fiscalYear: year, accountId: { in: travelAccts }, dimensionValueId: null } });
  const months = ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12"] as const;
  const budget = budgets.reduce((s, b) => s + months.reduce((t, k) => t + cents(b[k]), 0n), 0n);
  const actualTravel = sum(transport);

  return {
    range: r,
    totals: {
      transportation: fromCentavos(actualTravel), delivery: fromCentavos(sum(delivery)), pettyCash: fromCentavos(sum(rows.filter((v) => v.module === "PETTY_CASH"))),
      corporatePaid: fromCentavos(sum(mob.filter((v) => v.paymentMethod !== "EMPLOYEE"))), employeePaid: fromCentavos(sum(mob.filter((v) => v.paymentMethod === "EMPLOYEE"))),
      claims: rows.length,
    },
    byModule: out(group(rows, (v) => v.module, (v) => MODULES[v.module].label, cost)),
    byDepartment: out(group(mob, (v) => v.departmentId ?? "-", (v) => dLabel(v.departmentId), cost)),
    byProject: out(group(mob, (v) => v.projectId ?? "-", (v) => dLabel(v.projectId), cost)),
    byEmployee: out(group(mob, (v) => v.employeeId ?? "-", (v) => eLabel(v.employeeId), cost)),
    byProvider: out(group(mob, (v) => v.provider ?? "-", (v) => (v.provider ? PROVIDERS[v.module].find((p) => p.key === v.provider)?.name ?? v.provider : "Not given"), cost)),
    byPayment: out(group(mob, (v) => v.paymentMethod, (v) => PAYMENTS[v.paymentMethod].label, cost)),
    topTravelers: out(group(transport, (v) => v.employeeId ?? "-", (v) => eLabel(v.employeeId), cost).slice(0, 5)),
    topDeliveryUsers: out(group(delivery, (v) => v.employeeId ?? "-", (v) => eLabel(v.employeeId), cost).slice(0, 5)),
    unapproved: { count: pending.length, amount: fromCentavos(pending.reduce((s, v) => s + cost(v), 0n)), byStatus: out(group(pending, (v) => v.status, (v) => v.status, cost)) },
    unreconciled: { claims: recon.reduce((s, a) => s + a.unreconciled, 0), exceptions: recon.reduce((s, a) => s + a.exceptions.length, 0) },
    budgetVsActual: { year, budget: fromCentavos(budget), actual: fromCentavos(actualTravel), variance: fromCentavos(budget - actualTravel), hasBudget: budgets.length > 0, baseCurrency: org.baseCurrency },
  };
}

/** Expense summary per employee / partner, by module, with the detail lines. */
export async function employeeExpenseReport(organizationId: string, r: Range & { employeeId?: string | null; includePending?: boolean }) {
  const statuses = r.includePending ? [...RECORDED, ...PENDING] : [...RECORDED];
  const rows = await prisma.pettyCashVoucher.findMany({
    where: { organizationId, status: { in: statuses }, ...rangeWhere(r), ...(r.employeeId ? { employeeId: r.employeeId } : {}) },
    orderBy: [{ receiptDate: "asc" }, { number: "asc" }],
  });
  const emps = await prisma.employee.findMany({ where: { organizationId, id: { in: [...new Set(rows.map((v) => v.employeeId).filter(Boolean) as string[])] } } });
  const people = [...emps.map((e) => ({ id: e.id as string | null, code: e.code, name: empName(e), department: e.department, isPartner: e.isPartner })), ...(rows.some((v) => !v.employeeId) ? [{ id: null, code: "", name: "Not assigned (petty cash fund)", department: null, isPartner: false }] : [])];
  return people.map((p) => {
    const mine = rows.filter((v) => v.employeeId === p.id);
    const byModule = Object.fromEntries((Object.keys(MODULES) as ModuleKey[]).map((k) => [k, fromCentavos(mine.filter((v) => v.module === k).reduce((s, v) => s + cost(v), 0n))]));
    return {
      employee: p, count: mine.length, total: fromCentavos(mine.reduce((s, v) => s + cost(v), 0n)), byModule,
      reimbursable: fromCentavos(mine.filter((v) => v.paymentMethod === "EMPLOYEE" && v.status === "CLEARED").reduce((s, v) => s + cents(v.totalPaid), 0n)),
      lines: mine.map((v) => ({ id: v.id, number: v.number, date: v.receiptDate.toISOString().slice(0, 10), module: v.module, provider: v.provider, purpose: v.purpose, description: v.description, payment: v.paymentMethod, status: v.status, vat: m2(v.vatAmount), cost: fromCentavos(cost(v)), paid: m2(v.totalPaid) })),
    };
  }).sort((a, b) => Number(b.total) - Number(a.total));
}
