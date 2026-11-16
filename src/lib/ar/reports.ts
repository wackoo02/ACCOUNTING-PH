// Customer aging (summary and detail) and statements of account, computed from the receivables
// documents and reconciled to the GL control accounts.
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { toCentavos } from "../money";
import { convert, parseRate } from "../ledger/validate";
import { asDay } from "../ledger/service";
import { AGING_BUCKETS, bucketOf, daysPastDue } from "./compute";

const cents = (d: Prisma.Decimal | string | null | undefined) => toCentavos(d?.toString() ?? "0");
const base = (amount: bigint, rate: Prisma.Decimal) => convert(amount, parseRate(rate.toString()) ?? 1_000_000n);

export type AgingRow = {
  invoiceId: string; number: string | null; date: Date; dueDate: Date; reference: string | null; currencyCode: string;
  total: bigint; open: bigint; openBase: bigint; days: number; bucket: number;
};
export type CreditRow = { type: "RECEIPT" | "CREDIT_MEMO"; id: string; number: string | null; date: Date; currencyCode: string; open: bigint; openBase: bigint };
export type AgingCustomer = {
  customerId: string; code: string; name: string; creditLimit: bigint; buckets: bigint[]; invoices: bigint; credits: bigint; net: bigint;
  rows: AgingRow[]; creditRows: CreditRow[];
};

/**
 * Open invoices as of a date, aged by days past due (or by invoice date). Amounts in base currency
 * at the invoice's own rate, so the total ties to the AR control account.
 */
export async function customerAging(organizationId: string, asOf: Date, opts: { customerId?: string; basis?: "due" | "invoice" } = {}) {
  const day = asDay(asOf);
  const cust = opts.customerId ? { customerId: opts.customerId } : {};
  const [invoices, receipts, memos, customers] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { organizationId, kind: "INVOICE", status: "POSTED", date: { lte: day }, ...cust }, orderBy: [{ dueDate: "asc" }, { number: "asc" }] }),
    prisma.arReceipt.findMany({ where: { organizationId, status: "POSTED", date: { lte: day }, ...cust } }),
    prisma.salesInvoice.findMany({ where: { organizationId, kind: "CREDIT_MEMO", status: "POSTED", date: { lte: day }, ...cust } }),
    prisma.customer.findMany({ where: { organizationId, ...(opts.customerId ? { id: opts.customerId } : {}) } }),
  ]);
  const apps = await prisma.arApplication.findMany({ where: { organizationId, date: { lte: day }, ...(opts.customerId ? { invoiceId: { in: invoices.map((i) => i.id) } } : {}) } });
  const sumBy = (key: "invoiceId" | "receiptId" | "creditMemoId") => {
    const m = new Map<string, bigint>();
    for (const a of apps) { const k = a[key]; if (k) m.set(k, (m.get(k) ?? 0n) + cents(a.amount)); }
    return m;
  };
  const byInv = sumBy("invoiceId"), byRec = sumBy("receiptId"), byCm = sumBy("creditMemoId");

  const out = new Map<string, AgingCustomer>();
  const row = (customerId: string) => {
    let r = out.get(customerId);
    if (!r) {
      const c = customers.find((x) => x.id === customerId);
      r = { customerId, code: c?.code ?? "", name: c?.name ?? "(deleted customer)", creditLimit: cents(c?.creditLimit), buckets: AGING_BUCKETS.map(() => 0n), invoices: 0n, credits: 0n, net: 0n, rows: [], creditRows: [] };
      out.set(customerId, r);
    }
    return r;
  };
  for (const i of invoices) {
    const open = cents(i.totalAmount) - (byInv.get(i.id) ?? 0n);
    if (open <= 0n) continue;
    const days = daysPastDue(opts.basis === "invoice" ? i.date : i.dueDate, day);
    const b = opts.basis === "invoice" ? (days <= 30 ? 0 : bucketOf(days - 30)) : bucketOf(days);
    const openBase = base(open, i.fxRate);
    const r = row(i.customerId);
    r.rows.push({ invoiceId: i.id, number: i.number, date: i.date, dueDate: i.dueDate, reference: i.reference, currencyCode: i.currencyCode, total: cents(i.totalAmount), open, openBase, days, bucket: b });
    r.buckets[b] += openBase;
    r.invoices += openBase;
  }
  let advances = 0n, memoCredits = 0n;
  for (const rc of receipts) {
    const open = cents(rc.cashAmount) + cents(rc.withholdingAmount) - (byRec.get(rc.id) ?? 0n);
    if (open <= 0n) continue;
    const openBase = base(open, rc.fxRate);
    advances += openBase;
    row(rc.customerId).creditRows.push({ type: "RECEIPT", id: rc.id, number: rc.number, date: rc.date, currencyCode: rc.currencyCode, open, openBase });
  }
  for (const cm of memos) {
    const open = cents(cm.totalAmount) - (byCm.get(cm.id) ?? 0n);
    if (open <= 0n) continue;
    const openBase = base(open, cm.fxRate);
    memoCredits += openBase;
    row(cm.customerId).creditRows.push({ type: "CREDIT_MEMO", id: cm.id, number: cm.number, date: cm.date, currencyCode: cm.currencyCode, open, openBase });
  }
  const list = [...out.values()];
  for (const r of list) { r.credits = r.creditRows.reduce((s, c) => s + c.openBase, 0n); r.net = r.invoices - r.credits; }
  list.sort((a, b) => a.name.localeCompare(b.name));
  const totals = { buckets: AGING_BUCKETS.map((_, k) => list.reduce((s, r) => s + r.buckets[k], 0n)), invoices: list.reduce((s, r) => s + r.invoices, 0n), credits: advances + memoCredits, net: 0n };
  totals.net = totals.invoices - totals.credits;

  // Tie-out to the GL: AR control = open invoices less unapplied credit memos; advances = unapplied payments.
  const gl = async (role: string) => {
    const a = await prisma.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: role } } });
    if (!a) return null;
    const agg = await prisma.journalLine.aggregate({ where: { organizationId, accountId: a.id, journalEntry: { status: "POSTED", book: "STATUTORY", date: { lte: day } } }, _sum: { debit: true, credit: true } });
    return { account: `${a.code} ${a.name}`, balance: cents(agg._sum.debit) - cents(agg._sum.credit) };
  };
  const [arGl, advGl] = opts.customerId ? [null, null] : await Promise.all([gl("AR_CONTROL"), gl("CUSTOMER_ADVANCES")]);
  return {
    asOf: day, customers: list, totals,
    tieOut: opts.customerId ? null : {
      ar: { subledger: totals.invoices - memoCredits, gl: arGl },
      advances: { subledger: advances, gl: advGl ? { ...advGl, balance: -advGl.balance } : null },
    },
  };
}

export type StatementLine = { date: Date; type: "INVOICE" | "CREDIT_MEMO" | "PAYMENT"; id: string; number: string | null; description: string; charges: bigint; credits: bigint; balance: bigint; dueDate?: Date };

/** Statement of account for one customer, in the customer's currency. */
export async function customerStatement(organizationId: string, customerId: string, from: Date, to: Date) {
  const f = asDay(from), t = asDay(to);
  const customer = await prisma.customer.findFirst({ where: { id: customerId, organizationId } });
  if (!customer) return null;
  const [docs, receipts] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { organizationId, customerId, status: "POSTED", date: { lte: t } }, orderBy: [{ date: "asc" }, { number: "asc" }] }),
    prisma.arReceipt.findMany({ where: { organizationId, customerId, status: "POSTED", date: { lte: t } }, orderBy: [{ date: "asc" }, { number: "asc" }] }),
  ]);
  const items: Omit<StatementLine, "balance">[] = [
    ...docs.map((d) => d.kind === "INVOICE"
      ? { date: d.date, type: "INVOICE" as const, id: d.id, number: d.number, description: `Sales invoice${d.reference ? ` (ref. ${d.reference})` : ""}${d.memo ? ` - ${d.memo}` : ""}`, charges: cents(d.totalAmount), credits: 0n, dueDate: d.dueDate }
      : { date: d.date, type: "CREDIT_MEMO" as const, id: d.id, number: d.number, description: `Credit memo${d.reason ? ` - ${d.reason}` : ""}`, charges: 0n, credits: cents(d.totalAmount) }),
    ...receipts.map((r) => ({
      date: r.date, type: "PAYMENT" as const, id: r.id, number: r.number,
      description: `Payment${r.checkNo ? ` - check ${r.checkNo}` : ""}${cents(r.withholdingAmount) > 0n ? ` (incl. tax withheld ${(Number(cents(r.withholdingAmount)) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })}, BIR 2307)` : ""}`,
      charges: 0n, credits: cents(r.cashAmount) + cents(r.withholdingAmount),
    })),
  ].sort((a, b) => a.date.getTime() - b.date.getTime() || (a.type === "INVOICE" ? -1 : 1));
  let opening = 0n;
  const lines: StatementLine[] = [];
  let bal = 0n;
  for (const i of items) {
    if (i.date < f) { opening += i.charges - i.credits; continue; }
    if (!lines.length) bal = opening;
    bal += i.charges - i.credits;
    lines.push({ ...i, balance: bal });
  }
  const closing = opening + lines.reduce((s, l) => s + l.charges - l.credits, 0n);
  const aging = await customerAging(organizationId, t, { customerId });
  const a = aging.customers[0];
  return { customer, from: f, to: t, opening, lines, closing, aging: a ? { buckets: a.buckets, rows: a.rows, credits: a.credits } : null };
}
