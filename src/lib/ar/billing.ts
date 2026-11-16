// Contract, subscription and project billing. Recurring contracts create one invoice per period
// (draft or submitted for approval); project contracts bill milestones. Invoices go through the
// normal sales invoice approval and post to the GL when issued.
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { LedgerError, asDay, audit, nextNumber } from "../ledger/service";
import { advance, addDays, VAT_TYPES, type VatType } from "./compute";
import { saveInvoiceTx, type InvoiceLineInput } from "./service";

export const CONTRACT_KINDS = { SUBSCRIPTION: "Subscription", CONTRACT: "Service / retainer contract", PROJECT: "Project (milestone billing)" } as const;
export type ContractKind = keyof typeof CONTRACT_KINDS;
export const FREQUENCIES = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", SEMI_ANNUAL: "Semi-annual", ANNUAL: "Annual" } as const;

export type MilestoneInput = { id?: string; description: string; percent?: string | null; amount?: string | null; dueDate?: Date | null; vatType?: VatType; accountId?: string | null };
export type ContractInput = {
  organizationId: string; userId: string; kind: ContractKind; name: string; customerId: string; startDate: Date; endDate?: Date | null;
  frequency?: string | null; nextBillDate?: Date | null; termsDays?: number | null; contractValue?: string | null; pricesIncludeVat?: boolean;
  ewtTaxCodeId?: string | null; lines?: InvoiceLineInput[]; milestones?: MilestoneInput[]; autoSubmit?: boolean; status?: string; memo?: string | null;
};

const cents = (d: Prisma.Decimal | string | null | undefined) => toCentavos(d?.toString() ?? "0");

export async function saveContract(input: ContractInput, id?: string) {
  const errors: string[] = [];
  if (!(input.kind in CONTRACT_KINDS)) errors.push("Choose the billing type");
  if (!input.name?.trim()) errors.push("Enter a name, e.g. Monthly IT support retainer");
  const recurring = input.kind !== "PROJECT";
  if (recurring && !(input.frequency && input.frequency in FREQUENCIES)) errors.push("Choose how often to bill");
  if (input.endDate && asDay(input.endDate) < asDay(input.startDate)) errors.push("The end date is before the start date");
  const lines = (input.lines ?? []).filter((l) => l.description?.trim() || String(l.unitPrice ?? "").trim() || l.productId);
  if (recurring && !lines.length) errors.push("Add the lines to bill every period");
  for (const [i, l] of lines.entries()) {
    if (!/^\d+(\.\d{0,4})?$/.test(String(l.unitPrice ?? "").replace(/,/g, "").trim())) errors.push(`Line ${i + 1}: enter the price`);
    if (!VAT_TYPES.includes(l.vatType)) errors.push(`Line ${i + 1}: choose the VAT type`);
  }
  let value = 0n;
  try { value = toCentavos(input.contractValue ?? "0"); } catch (e) { errors.push(`Contract value: ${(e as Error).message}`); }
  const ms = (input.milestones ?? []).filter((m) => m.description?.trim() || m.amount || m.percent);
  if (input.kind === "PROJECT") {
    if (value <= 0n) errors.push("Enter the contract value (VAT-exclusive unless prices include VAT)");
    if (!ms.length) errors.push("Add the billing milestones (e.g. 30% downpayment, 40% on delivery, 30% on acceptance)");
  }
  const msAmounts = ms.map((m, i) => {
    if (!m.description?.trim()) errors.push(`Milestone ${i + 1}: enter a description`);
    try {
      if (m.amount && String(m.amount).trim()) return toCentavos(m.amount);
      const pct = Number(m.percent);
      if (!(pct > 0 && pct <= 100)) { errors.push(`Milestone ${i + 1}: enter a percent or an amount`); return 0n; }
      return (value * BigInt(Math.round(pct * 10000)) + 500000n) / 1000000n;
    } catch (e) { errors.push(`Milestone ${i + 1}: ${(e as Error).message}`); return 0n; }
  });
  if (input.kind === "PROJECT" && msAmounts.reduce((s, a) => s + a, 0n) > value) errors.push("The milestones add up to more than the contract value");
  const customer = await prisma.customer.findFirst({ where: { id: input.customerId, organizationId: input.organizationId } });
  if (!customer) errors.push("Choose a customer");
  if (errors.length) throw new LedgerError(errors);

  return prisma.$transaction(async (tx) => {
    const cur = id ? await tx.billingContract.findFirst({ where: { id, organizationId: input.organizationId }, include: { milestones: true } }) : null;
    if (id && !cur) throw new LedgerError(["Contract not found"]);
    const start = asDay(input.startDate);
    const data = {
      kind: input.kind, name: input.name.trim(), customerId: customer!.id, startDate: start, endDate: input.endDate ? asDay(input.endDate) : null,
      frequency: recurring ? input.frequency! : null, nextBillDate: recurring ? asDay(input.nextBillDate ?? cur?.nextBillDate ?? start) : null,
      termsDays: input.termsDays ?? null, currencyCode: customer!.currencyCode, contractValue: new Prisma.Decimal(fromCentavos(value)),
      pricesIncludeVat: !!input.pricesIncludeVat, ewtTaxCodeId: input.ewtTaxCodeId || null, lines: lines as unknown as Prisma.InputJsonValue,
      autoSubmit: input.autoSubmit ?? true, status: input.status && ["ACTIVE", "PAUSED", "ENDED"].includes(input.status) ? input.status : "ACTIVE", memo: input.memo?.trim() || null,
    };
    const c = cur
      ? await tx.billingContract.update({ where: { id: cur.id }, data })
      : await tx.billingContract.create({ data: { ...data, organizationId: input.organizationId, number: await nextNumber(tx, input.organizationId, "BC", start.getUTCFullYear()), createdById: input.userId } });
    // Milestones: billed ones stay as they are; the rest are replaced.
    const billed = cur?.milestones.filter((m) => m.invoiceId) ?? [];
    await tx.billingMilestone.deleteMany({ where: { contractId: c.id, invoiceId: null } });
    let n = billed.reduce((s, m) => Math.max(s, m.lineNo), 0);
    for (const [i, m] of ms.entries()) {
      if (m.id && billed.some((b) => b.id === m.id)) continue;
      await tx.billingMilestone.create({ data: {
        contractId: c.id, lineNo: ++n, description: m.description.trim(), percent: m.percent && !String(m.amount ?? "").trim() ? new Prisma.Decimal(m.percent) : null,
        amount: new Prisma.Decimal(fromCentavos(msAmounts[i])), dueDate: m.dueDate ? asDay(m.dueDate) : null, vatType: m.vatType ?? "VATABLE", accountId: m.accountId || null,
      } });
    }
    await audit(tx, input.organizationId, input.userId, "billing.save", c.id, { number: c.number }, cur ? JSON.parse(JSON.stringify(cur)) : null, JSON.parse(JSON.stringify(c)), "billing_contract");
    return c;
  });
}

const periodLabel = (from: Date, to: Date) => `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`;

/**
 * Create the invoices of every active recurring contract that is due on or before `asOf`
 * (catching up missed periods). Safe to run again: a period already billed is skipped.
 */
export async function runBilling(organizationId: string, userId: string, asOf: Date, contractId?: string) {
  const until = asDay(asOf);
  const contracts = await prisma.billingContract.findMany({
    where: { organizationId, status: "ACTIVE", kind: { not: "PROJECT" }, nextBillDate: { lte: until }, ...(contractId ? { id: contractId } : {}) },
  });
  const created: { contract: string; invoiceId: string; period: string }[] = [];
  const errors: string[] = [];
  for (const c of contracts) {
    try {
      await prisma.$transaction(async (tx) => {
        let next = c.nextBillDate!;
        let count = 0;
        const anchor = c.startDate.getUTCDate();
        while (next <= until && (!c.endDate || next <= c.endDate) && count < 24) {
          const periodEnd = addDays(advance(next, c.frequency!, anchor), -1);
          const sourceRef = `${c.id}:${next.toISOString().slice(0, 10)}`;
          const already = await tx.salesInvoice.findFirst({ where: { organizationId, sourceRef, status: { not: "VOID" } } });
          if (!already) {
            const inv = await saveInvoiceTx(tx, {
              organizationId, userId, customerId: c.customerId, date: next, termsDays: c.termsDays, pricesIncludeVat: c.pricesIncludeVat, ewtTaxCodeId: c.ewtTaxCodeId,
              reference: c.number, memo: `${c.name} - billing period ${periodLabel(next, periodEnd)}`, lines: c.lines as unknown as InvoiceLineInput[],
              source: "CONTRACT", sourceRef, contractId: c.id, action: c.autoSubmit ? "submit" : "draft",
            });
            created.push({ contract: c.number, invoiceId: inv.id, period: periodLabel(next, periodEnd) });
            count++;
          }
          next = advance(next, c.frequency!, anchor);
        }
        const ended = !!c.endDate && next > c.endDate;
        await tx.billingContract.update({ where: { id: c.id }, data: { nextBillDate: next, invoiceCount: { increment: count }, lastBilledAt: count ? new Date() : c.lastBilledAt, status: ended ? "ENDED" : c.status } });
        if (count) await audit(tx, organizationId, userId, "billing.run", c.id, { number: c.number, invoices: count }, null, null, "billing_contract");
      });
    } catch (e) {
      errors.push(`${c.number} ${c.name}: ${e instanceof LedgerError ? e.errors.join("; ") : (e as Error).message}`);
    }
  }
  return { created, errors };
}

/** Bill one project milestone as a sales invoice. */
export async function billMilestone(organizationId: string, userId: string, milestoneId: string, date: Date, action: "draft" | "submit" = "submit") {
  return prisma.$transaction(async (tx) => {
    const m = await tx.billingMilestone.findUnique({ where: { id: milestoneId }, include: { contract: true } });
    if (!m || m.contract.organizationId !== organizationId) throw new LedgerError(["Milestone not found"]);
    if (m.invoiceId) throw new LedgerError(["This milestone is already billed"]);
    if (m.contract.status !== "ACTIVE") throw new LedgerError(["The contract is not active"]);
    const c = m.contract;
    const pct = m.percent ? ` (${Number(m.percent)}% of ${fromCentavos(cents(c.contractValue))})` : "";
    const inv = await saveInvoiceTx(tx, {
      organizationId, userId, customerId: c.customerId, date, termsDays: c.termsDays, pricesIncludeVat: c.pricesIncludeVat, ewtTaxCodeId: c.ewtTaxCodeId,
      reference: c.number, memo: `${c.name} - ${m.description}`,
      lines: [{ description: `${m.description}${pct}`, quantity: "1", unitPrice: m.amount.toString(), vatType: m.vatType as VatType, accountId: m.accountId }],
      source: "CONTRACT", sourceRef: `${c.id}:M${m.lineNo}`, contractId: c.id, action,
    });
    await tx.billingMilestone.update({ where: { id: m.id }, data: { invoiceId: inv.id, billedAt: new Date() } });
    await tx.billingContract.update({ where: { id: c.id }, data: { invoiceCount: { increment: 1 }, lastBilledAt: new Date() } });
    await audit(tx, organizationId, userId, "billing.run", c.id, { number: c.number, milestone: m.description }, null, null, "billing_contract");
    return inv;
  });
}
