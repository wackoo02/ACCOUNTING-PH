// Accounts payable aging (summary per supplier and detail per invoice) as of a date,
// plus the tie-out of the AP sub-ledger to the Accounts Payable control account in the GL.
import { prisma } from "../db";
import { toCentavos } from "../money";
import { BUCKETS, bucketOf, daysBetween, roundDiv, type Bucket } from "./compute";
import { cents, q4of } from "./common";

export type AgingRow = {
  billId: string; number: string; vendorId: string; vendorCode: string; vendorName: string; supplierInvoiceNo: string;
  invoiceDate: Date; dueDate: Date; currencyCode: string; total: bigint; ewt: bigint; netPayable: bigint; paid: bigint; open: bigint; openBase: bigint;
  daysPastDue: number; bucket: Bucket; scheduledPayDate: Date | null; onHold: boolean;
};

/** Open posted bills as of `asOf`. Aged by due date (default) or invoice date. */
export async function apAging(organizationId: string, asOf: Date, opts: { vendorId?: string | null; basis?: "due" | "invoice" } = {}) {
  const bills = await prisma.apBill.findMany({
    where: { organizationId, status: "POSTED", date: { lte: asOf }, ...(opts.vendorId ? { vendorId: opts.vendorId } : {}) },
    orderBy: [{ dueDate: "asc" }, { number: "asc" }],
  });
  const pays = await prisma.apPaymentLine.groupBy({
    by: ["billId"], where: { billId: { in: bills.map((b) => b.id) }, payment: { status: "POSTED", date: { lte: asOf } } }, _sum: { amount: true },
  });
  const paid = new Map(pays.map((p) => [p.billId, cents(p._sum.amount)]));
  const vendors = await prisma.vendor.findMany({ where: { organizationId, id: { in: [...new Set(bills.map((b) => b.vendorId))] } } });
  const vmap = new Map(vendors.map((v) => [v.id, v]));
  const rows: AgingRow[] = [];
  for (const b of bills) {
    const p = paid.get(b.id) ?? 0n;
    const open = cents(b.netPayable) - p;
    if (open === 0n) continue;
    const v = vmap.get(b.vendorId)!;
    const days = daysBetween(opts.basis === "invoice" ? b.invoiceDate : b.dueDate, asOf);
    rows.push({
      billId: b.id, number: b.number, vendorId: b.vendorId, vendorCode: v.code, vendorName: v.name, supplierInvoiceNo: b.supplierInvoiceNo,
      invoiceDate: b.invoiceDate, dueDate: b.dueDate, currencyCode: b.currencyCode, total: cents(b.total), ewt: cents(b.ewtAmount), netPayable: cents(b.netPayable),
      paid: p, open, openBase: roundDiv(open * q4of(b.fxRate), 10000n), daysPastDue: days, bucket: bucketOf(days),
      scheduledPayDate: b.scheduledPayDate, onHold: b.onHold,
    });
  }
  const zero = () => Object.fromEntries(BUCKETS.map((k) => [k, 0n])) as Record<Bucket, bigint>;
  const summary = new Map<string, { vendorId: string; vendorCode: string; vendorName: string; buckets: Record<Bucket, bigint>; total: bigint; count: number }>();
  const totals = zero();
  for (const r of rows) {
    const s = summary.get(r.vendorId) ?? { vendorId: r.vendorId, vendorCode: r.vendorCode, vendorName: r.vendorName, buckets: zero(), total: 0n, count: 0 };
    s.buckets[r.bucket] += r.openBase; s.total += r.openBase; s.count++;
    totals[r.bucket] += r.openBase;
    summary.set(r.vendorId, s);
  }
  const subledger = rows.reduce((s, r) => s + r.openBase, 0n);
  // GL balance of the AP control account (credit balance positive).
  const ap = await prisma.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: "AP_CONTROL" } } });
  let gl: bigint | null = null;
  if (ap && !opts.vendorId) {
    const agg = await prisma.journalLine.aggregate({ where: { organizationId, accountId: ap.id, journalEntry: { status: "POSTED", book: "STATUTORY", date: { lte: asOf } } }, _sum: { debit: true, credit: true } });
    gl = toCentavos(agg._sum.credit?.toString() ?? "0") - toCentavos(agg._sum.debit?.toString() ?? "0");
  }
  return {
    rows, totals, subledger, gl,
    summary: [...summary.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.vendorName.localeCompare(b.vendorName))),
  };
}
