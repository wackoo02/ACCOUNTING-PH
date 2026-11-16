import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { canApproveNow, type DocType } from "@/lib/approvals";
import { cents, q4of } from "@/lib/ap/common";
import { roundDiv } from "@/lib/ap/compute";
import { formatPeso } from "@/lib/money";

const TYPE: Record<DocType, string> = { PR: "Purchase request", PO: "Purchase order", BILL: "Supplier bill", PAYMENT: "Payment voucher" };
type Item = { type: DocType; id: string; number: string; date: Date; who: string; what: string; total: bigint; href: string; preparers: (string | null)[] };

/** Everything waiting for approval in purchasing and payables, and whether it is the viewer's turn. */
export default async function MyApprovals() {
  const ctx = await requireCtx("reports.view");
  const o = ctx.org.id;
  const [prs, pos, bills, pays, vendors] = await Promise.all([
    prisma.purchaseRequest.findMany({ where: { organizationId: o, status: "PENDING_APPROVAL" } }),
    prisma.purchaseOrder.findMany({ where: { organizationId: o, status: "PENDING_APPROVAL" } }),
    prisma.apBill.findMany({ where: { organizationId: o, status: "PENDING_APPROVAL" } }),
    prisma.apPayment.findMany({ where: { organizationId: o, status: "PENDING_APPROVAL" } }),
    prisma.vendor.findMany({ where: { organizationId: o }, select: { id: true, name: true } }),
  ]);
  const v = new Map(vendors.map((x) => [x.id, x.name]));
  const base = (amt: { toString(): string }, rate: { toString(): string }) => roundDiv(cents(amt.toString()) * q4of(rate.toString()), 10000n);
  const items: Item[] = [
    ...prs.map((x) => ({ type: "PR" as const, id: x.id, number: x.number, date: x.date, who: "", what: x.purpose, total: cents(x.estimatedTotal), href: `/purchasing/requests/${x.id}`, preparers: [x.requestedById] })),
    ...pos.map((x) => ({ type: "PO" as const, id: x.id, number: x.number, date: x.poDate, who: x.vendorName ?? "", what: x.description, total: base(x.amount, x.fxRate), href: `/purchasing/orders/${x.id}`, preparers: [x.createdById, x.submittedById, x.updatedById] })),
    ...bills.map((x) => ({ type: "BILL" as const, id: x.id, number: x.number, date: x.date, who: v.get(x.vendorId) ?? "", what: `Invoice ${x.supplierInvoiceNo}: ${x.memo}`, total: base(x.total, x.fxRate), href: `/ap/bills/${x.id}`, preparers: [x.createdById, x.submittedById, x.updatedById] })),
    ...pays.map((x) => ({ type: "PAYMENT" as const, id: x.id, number: x.number, date: x.date, who: v.get(x.vendorId) ?? "", what: x.memo, total: base(x.amount, x.fxRate), href: `/ap/payments/${x.id}`, preparers: [x.createdById, x.submittedById, x.updatedById] })),
  ];
  const checked = await Promise.all(items.map(async (i) => ({ i, r: await canApproveNow(o, i.type, i.id, ctx.user.id, i.total, i.preparers) })));
  const mine = checked.filter((c) => c.r.ok);
  const others = checked.filter((c) => !c.r.ok);
  const table = (rows: typeof checked, showWhy: boolean) => (
    <div className="table-wrap"><table>
      <thead><tr><th>Type</th><th>Date</th><th>No.</th><th>Supplier</th><th>Details</th><th>Waiting for</th><th className="num">Amount (PHP)</th></tr></thead>
      <tbody>{rows.map(({ i, r }) => <tr key={i.id}><td>{TYPE[i.type]}</td><td>{fmtDate(i.date)}</td><td><Link href={i.href}>{i.number}</Link></td><td>{i.who}</td><td>{i.what}</td><td>{r.state.next?.name}{showWhy && <div className="muted">{r.why}</div>}</td><td className="num">{formatPeso(i.total)}</td></tr>)}
        {!rows.length && <tr><td colSpan={7} className="muted">Nothing.</td></tr>}</tbody>
    </table></div>
  );
  return (<>
    <div className="top"><h1>Approvals: Purchasing and Payables</h1></div>
    <h2>Waiting for you ({mine.length})</h2>{table(mine, false)}
    <h2>Waiting for others ({others.length})</h2>{table(others, true)}
  </>);
}
