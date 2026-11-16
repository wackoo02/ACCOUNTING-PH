// Saving draft returns, recording a filing (confirmation no., payment) and the VAT closing entry.
import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit, LedgerError, recordJournalTx, voidOrReverseTx } from "@/lib/ledger/service";
import { fromCentavos, toCentavos } from "@/lib/money";
import { computeReturn, figuresOf, savedReturn } from "./returns";
import { periodFor, type FormCode } from "./periods";

function cleanInputs(raw: Record<string, string>) {
  const out: Record<string, string> = {};
  const errs: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const s = String(v ?? "").replace(/,/g, "").trim();
    if (!s) continue;
    try { out[k] = fromCentavos(toCentavos(s)); } catch { errs.push(`${k}: enter an amount like 1234.56`); }
  }
  if (errs.length) throw new LedgerError(errs);
  return out;
}

export async function saveReturnInputs(organizationId: string, userId: string, form: FormCode, year: number, n: number, raw: Record<string, string>) {
  const period = periodFor(form, year, n);
  const inputs = cleanInputs(raw);
  const cur = await savedReturn(organizationId, form, period);
  if (cur?.status === "FILED") throw new LedgerError(["This return is already filed. Reopen it to change the figures."]);
  const r = await prisma.taxReturn.upsert({
    where: { organizationId_form_periodFrom_amended: { organizationId, form, periodFrom: period.from, amended: false } },
    create: { organizationId, form, periodFrom: period.from, periodTo: period.to, inputs, createdById: userId },
    update: { inputs, updatedById: userId },
  });
  const res = await computeReturn(organizationId, form, year, n);
  await prisma.taxReturn.update({ where: { id: r.id }, data: { taxDue: new Prisma.Decimal(fromCentavos(res.taxDue)) } });
  return res;
}

export async function fileReturn(organizationId: string, userId: string, form: FormCode, year: number, n: number, f: {
  filedAt: Date; filingRef?: string | null; amountPaid?: string | null; paymentRef?: string | null; postClosing?: boolean;
}) {
  const res = await computeReturn(organizationId, form, year, n);
  const period = res.period;
  return prisma.$transaction(async (tx) => {
    const cur = await tx.taxReturn.findUnique({ where: { organizationId_form_periodFrom_amended: { organizationId, form, periodFrom: period.from, amended: false } } });
    if (cur?.status === "FILED") throw new LedgerError(["This return is already filed"]);
    let paid = res.taxDue;
    if (f.amountPaid?.trim()) { try { paid = toCentavos(f.amountPaid); } catch { throw new LedgerError(["Amount paid: enter an amount like 1234.56"]); } }
    let journalEntryId: string | null = null;
    if (f.postClosing && form === "2550Q") journalEntryId = await vatClosingEntry(tx, organizationId, userId, res);
    const data = {
      status: "FILED", figures: figuresOf(res), taxDue: new Prisma.Decimal(fromCentavos(res.taxDue)), filedAt: f.filedAt,
      filingRef: f.filingRef?.trim() || null, amountPaid: new Prisma.Decimal(fromCentavos(paid)), paymentRef: f.paymentRef?.trim() || null,
      journalEntryId, filedById: userId, updatedById: userId,
    };
    const r = cur
      ? await tx.taxReturn.update({ where: { id: cur.id }, data })
      : await tx.taxReturn.create({ data: { ...data, organizationId, form, periodFrom: period.from, periodTo: period.to, createdById: userId } });
    await audit(tx, organizationId, userId, "tax.file", r.id, { form, period: period.label, taxDue: fromCentavos(res.taxDue), filingRef: r.filingRef } as Prisma.InputJsonValue, null, null, "tax");
    return r;
  });
}

/**
 * Close output and input VAT for the quarter into VAT Payable:
 *   Dr Output VAT (output tax)   Cr Input VAT (input applied)   Cr Creditable VAT Withheld (credits applied)   Cr VAT Payable (balance)
 * Excess input VAT stays in the Input VAT account and carries over. Deductions from input tax
 * (exempt sales, government sales) need their own entry to expense.
 */
async function vatClosingEntry(tx: Prisma.TransactionClient, organizationId: string, userId: string, res: Awaited<ReturnType<typeof computeReturn>>) {
  const get = (k: string) => res.sections.flatMap((s) => s.rows).find((r) => r.key === k)?.tax ?? 0n;
  const output = get("out.adjusted"), allowable = get("allowable"), withheld = get("vatWithheld");
  const role = async (r: string) => {
    const a = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: r } } });
    if (!a) throw new LedgerError([`Assign the ${r.replace(/_/g, " ").toLowerCase()} account in the chart of accounts first`]);
    return a.id;
  };
  const inputApplied = allowable < output ? allowable : output;
  const before = output - inputApplied;
  const credit = withheld < before ? withheld : before;
  const payable = before - credit;
  if (output <= 0n) return null;
  const lines = [
    { accountId: await role("OUTPUT_VAT"), debit: fromCentavos(output), description: "Close output VAT" },
    ...(inputApplied > 0n ? [{ accountId: await role("INPUT_VAT"), credit: fromCentavos(inputApplied), description: "Apply input VAT" }] : []),
    ...(credit > 0n ? [{ accountId: await role("CVAT_WITHHELD"), credit: fromCentavos(credit), description: "Apply creditable VAT withheld" }] : []),
    ...(payable > 0n ? [{ accountId: await role("VAT_PAYABLE"), credit: fromCentavos(payable), description: "VAT payable per 2550Q" }] : []),
  ];
  const e = await recordJournalTx(tx, {
    organizationId, userId, date: res.period.to, memo: `VAT closing per BIR 2550Q ${res.period.label}`, reference: `2550Q ${res.period.label}`,
    lines, source: "TAX", sourceId: `2550Q:${res.period.from.toISOString().slice(0, 10)}`, action: "post",
  });
  return e.id;
}

/** Owner/admin: undo a filing record (e.g. it was recorded by mistake). Reverses the VAT closing entry. */
export async function reopenReturn(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.taxReturn.findFirst({ where: { id, organizationId } });
    if (!r || r.status !== "FILED") throw new LedgerError(["Filed return not found"]);
    if (r.journalEntryId) await voidOrReverseTx(tx, organizationId, userId, r.journalEntryId, undefined, true);
    await tx.taxReturn.update({ where: { id }, data: { status: "DRAFT", filedAt: null, filingRef: null, paymentRef: null, amountPaid: 0, journalEntryId: null, updatedById: userId } });
    await audit(tx, organizationId, userId, "tax.reopen", id, { form: r.form }, null, null, "tax");
  });
}
