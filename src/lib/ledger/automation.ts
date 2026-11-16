// Recurring journal entries and percentage allocations. Both create normal journal entries
// through recordJournal, so approval controls and the audit trail still apply.
import { Prisma, type DimensionType } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { LedgerError, asDay, recordJournal } from "./service";
import { DIMENSIONS, DIM_KEYS } from "./dimensions";
import type { LineInput } from "./validate";

const STEP: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 };

export function addMonths(d: Date, n: number) {
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  // Month-end stays month-end (Jun 30 -> Jul 31), so accruals don't drift.
  const isMonthEnd = day === new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  if (isMonthEnd) return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), last));
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(day, last)));
}

/** Save an existing entry's lines as a recurring template. */
export async function createRecurringFromEntry(organizationId: string, userId: string, entryId: string, opts: { name: string; frequency: string; nextRunDate: Date; endDate?: Date | null; autoSubmit: boolean }) {
  if (!STEP[opts.frequency]) throw new LedgerError(["Choose a frequency"]);
  const e = await prisma.journalEntry.findFirst({ where: { id: entryId, organizationId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!e) throw new LedgerError(["Entry not found"]);
  if (e.source !== "MANUAL") throw new LedgerError(["Only manual journals can be made recurring"]);
  const lines: LineInput[] = e.lines.map((l) => ({
    accountId: l.accountId, description: l.description, debit: l.fxDebit.isZero() ? "" : l.fxDebit.toString(), credit: l.fxCredit.isZero() ? "" : l.fxCredit.toString(),
    currencyCode: l.currencyCode, fxRate: l.fxRate.toString(), dims: Object.fromEntries(DIM_KEYS.map((k) => [k, l[k]])),
  }));
  const r = await prisma.recurringJournal.create({ data: {
    organizationId, name: opts.name.trim() || e.memo, frequency: opts.frequency, nextRunDate: asDay(opts.nextRunDate), endDate: opts.endDate ? asDay(opts.endDate) : null,
    memo: e.memo, reference: e.reference, lines: lines as unknown as Prisma.InputJsonValue, autoSubmit: opts.autoSubmit, createdById: userId,
  } });
  await prisma.auditLog.create({ data: { organizationId, userId, action: "recurring.create", entity: "recurring", entityId: r.id, after: JSON.parse(JSON.stringify(r)) } });
  return r;
}

/** Generate every recurring entry due on or before `asOf`. Returns the created entries. */
export async function runRecurring(organizationId: string, userId: string, asOf: Date) {
  const due = await prisma.recurringJournal.findMany({ where: { organizationId, isActive: true, nextRunDate: { lte: asDay(asOf) } } });
  const created = [];
  for (const r of due) {
    let next = r.nextRunDate;
    while (next <= asDay(asOf) && (!r.endDate || next <= r.endDate)) {
      const label = next.toISOString().slice(0, 7);
      const e = await recordJournal({
        organizationId, userId, date: next, memo: `${r.memo} (${label})`, reference: r.reference,
        lines: r.lines as unknown as LineInput[], source: "MANUAL", sourceId: r.id, action: r.autoSubmit ? "submit" : "draft",
      });
      created.push(e);
      next = addMonths(next, STEP[r.frequency]);
    }
    await prisma.recurringJournal.update({ where: { id: r.id }, data: {
      nextRunDate: next, lastRunAt: new Date(), runCount: { increment: created.filter((c) => c.sourceId === r.id).length },
      isActive: !r.endDate || next <= r.endDate,
    } });
  }
  return created;
}

export type Split = { dimensionValueId: string; pct: string };

export async function createAllocationRule(organizationId: string, userId: string, input: { name: string; sourceAccountId: string; targetAccountId?: string | null; dimensionType: DimensionType; splits: Split[] }) {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("Give the rule a name");
  const splits = input.splits.filter((s) => s.dimensionValueId && s.pct);
  if (splits.length < 2) errors.push("Add at least two splits");
  const total = splits.reduce((t, s) => t + toCentavos(s.pct), 0n);
  if (total !== 10000n) errors.push(`Percentages must add up to 100 (now ${fromCentavos(total)})`);
  const vals = await prisma.dimensionValue.count({ where: { organizationId, type: input.dimensionType, id: { in: splits.map((s) => s.dimensionValueId) } } });
  if (vals !== new Set(splits.map((s) => s.dimensionValueId)).size || vals !== splits.length) errors.push("Each split needs a different, valid value of the chosen dimension");
  if (errors.length) throw new LedgerError(errors);
  const r = await prisma.allocationRule.create({ data: {
    organizationId, name: input.name.trim(), sourceAccountId: input.sourceAccountId, targetAccountId: input.targetAccountId || null,
    dimensionType: input.dimensionType, splits: splits as unknown as Prisma.InputJsonValue, createdById: userId,
  } });
  await prisma.auditLog.create({ data: { organizationId, userId, action: "allocation.create", entity: "allocation", entityId: r.id, after: JSON.parse(JSON.stringify(r)) } });
  return r;
}

/**
 * Allocate the untagged balance of the rule's source account for [from, to]: credit the source
 * (untagged) and debit the target account split by dimension value. Creates an entry for approval.
 */
export async function runAllocation(organizationId: string, userId: string, ruleId: string, from: Date, to: Date, postingDate: Date) {
  const rule = await prisma.allocationRule.findFirst({ where: { id: ruleId, organizationId } });
  if (!rule) throw new LedgerError(["Allocation rule not found"]);
  const key = DIMENSIONS.find((d) => d.type === rule.dimensionType)!.key;
  const agg = await prisma.journalLine.aggregate({
    where: { organizationId, accountId: rule.sourceAccountId, [key]: null, journalEntry: { status: "POSTED", book: "STATUTORY", source: { not: "CLOSING" }, date: { gte: asDay(from), lte: asDay(to) } } },
    _sum: { debit: true, credit: true },
  });
  const amount = toCentavos(agg._sum.debit?.toString() ?? "0") - toCentavos(agg._sum.credit?.toString() ?? "0");
  if (amount === 0n) throw new LedgerError(["Nothing to allocate: the source account has no untagged balance in this period"]);
  const abs = amount < 0n ? -amount : amount;
  const splits = rule.splits as unknown as Split[];
  let used = 0n;
  const parts = splits.map((s, i) => {
    const share = i === splits.length - 1 ? abs - used : (abs * toCentavos(s.pct)) / 10000n;
    used += share;
    return { s, share };
  });
  const debitSide = amount > 0n; // a debit balance (expense) is moved to the tagged lines as debits
  const target = rule.targetAccountId ?? rule.sourceAccountId;
  const lines: LineInput[] = [
    { accountId: rule.sourceAccountId, description: `Allocate out: ${rule.name}`, [debitSide ? "credit" : "debit"]: fromCentavos(abs) },
    ...parts.filter((p) => p.share > 0n).map((p) => ({
      accountId: target, description: `${rule.name} ${p.s.pct}%`, [debitSide ? "debit" : "credit"]: fromCentavos(p.share), dims: { [key]: p.s.dimensionValueId },
    })),
  ];
  return recordJournal({
    organizationId, userId, date: postingDate, memo: `Allocation: ${rule.name} (${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)})`,
    lines, source: "MANUAL", sourceId: rule.id, action: "submit",
  });
}
