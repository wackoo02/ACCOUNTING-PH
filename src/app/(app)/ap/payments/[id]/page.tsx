import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { formatPeso } from "@/lib/money";
import { cents } from "@/lib/ap/common";
import { paymentBaseTotal } from "@/lib/ap/payments";
import { peso, statusText, userNames } from "@/lib/ap/view";
import { canApproveNow } from "@/lib/approvals";
import { Workflow } from "@/components/ap/Workflow";
import { ApprovalPanel } from "@/components/ap/ApprovalPanel";

export default async function PayView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const p = await prisma.apPayment.findFirst({ where: { id, organizationId: ctx.org.id }, include: { lines: { include: { bill: true } } } });
  if (!p) notFound();
  const [vendor, bank, cash, org] = await Promise.all([
    prisma.vendor.findUniqueOrThrow({ where: { id: p.vendorId } }),
    prisma.bankAccount.findUniqueOrThrow({ where: { id: p.bankAccountId } }),
    p.cashTransactionId ? prisma.cashTransaction.findUnique({ where: { id: p.cashTransactionId } }) : null,
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
  ]);
  const who = await userNames([p.createdById, p.approvedById, p.voidedById]);
  const preparers = [p.createdById, p.submittedById, p.updatedById];
  const total = paymentBaseTotal(p);
  const appr = p.status === "PENDING_APPROVAL" ? await canApproveNow(ctx.org.id, "PAYMENT", p.id, ctx.user.id, total, preparers) : null;
  const create = can(ctx.role, "journal.create");
  const ewt = p.lines.reduce((s, l) => s + (cents(l.bill.ewtAmount) * cents(l.amount)) / (cents(l.bill.netPayable) || 1n), 0n);
  const ops = [
    ...(p.status === "DRAFT" && create ? ["submit" as const] : []),
    ...(appr?.ok ? ["approve" as const, "return" as const] : []),
    ...(p.status !== "VOID" && can(ctx.role, "journal.void") ? ["void" as const] : []),
  ];
  return (
    <>
      <div className="top">
        <h1>Payment Voucher {p.number} <span className={`badge ${p.status}`}>{p.status === "POSTED" ? "RELEASED" : statusText(p.status)}</span></h1>
        <div className="row" style={{ gap: 8, flex: "0 0 auto", maxWidth: "70%", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "flex-start" }}>
          {p.status === "DRAFT" && create && <Link className="btn secondary" href={`/ap/payments/${p.id}/edit`}>Edit</Link>}
          {p.status === "POSTED" && p.method === "CHECK" && <Link className="btn secondary" href={`/ap/payments/${p.id}/check`}>Print check</Link>}
          {ewt > 0n && <Link className="btn secondary" href={`/ap/payments/${p.id}/2307`}>BIR 2307</Link>}
          <Workflow doc="PAYMENT" id={p.id} ops={ops} approveLabel={appr?.state.next?.level === appr?.state.levels.at(-1)?.level ? "Approve and release" : "Approve"} voidNote="The disbursement is voided, its GL entry reversed, and the bills become unpaid again. A voided check keeps its number." />
        </div>
      </div>
      <div className="print-only"><strong>{org.name}</strong>{org.tin ? ` · TIN ${org.tin}` : ""}<br />{org.registeredAddress}<h2>PAYMENT VOUCHER {p.number}</h2></div>
      {p.rejectReason && p.status === "DRAFT" && <div className="errors">Returned: {p.rejectReason}</div>}
      {p.status === "VOID" && <div className="notice">Voided by {who(p.voidedById)}: {p.voidReason}</div>}
      <div className="card grid">
        <div><label>Payee</label>{vendor.name}<div className="muted">{vendor.tin ? `TIN ${vendor.tin}` : ""}</div></div>
        <div><label>Date</label>{fmtDate(p.date)}</div>
        <div><label>Pay from</label>{bank.code} · {bank.name}</div>
        <div><label>Method</label>{p.method.replace("_", " ").toLowerCase()}{p.checkNo && <div>Check no. <strong>{p.checkNo}</strong>{p.checkDate && ` dated ${fmtDate(p.checkDate)}`}</div>}</div>
        {cash && <div><label>Disbursement</label><Link href={`/cash/${cash.id}`}>{cash.number}</Link><div className="muted">{cash.status === "VOID" ? "void" : cash.checkReleasedAt ? `check released ${fmtDate(cash.checkReleasedAt)}` : p.method === "CHECK" ? "check not yet released" : ""}</div></div>}
        <div><label>Amount</label><strong>{p.currencyCode} {peso(p.amount)}</strong></div>
      </div>
      <p><strong>{p.memo}</strong></p>
      <div className="table-wrap"><table>
        <thead><tr><th>Bill</th><th>Supplier invoice</th><th>Invoice date</th><th className="num">Invoice total</th><th className="num">EWT withheld</th><th className="num">Paid now</th></tr></thead>
        <tbody>
          {p.lines.map((l) => <tr key={l.id}><td><Link href={`/ap/bills/${l.billId}`}>{l.bill.number}</Link></td><td>{l.bill.supplierInvoiceNo}</td><td>{fmtDate(l.bill.invoiceDate)}</td><td className="num">{peso(l.bill.total)}</td><td className="num">{peso(l.bill.ewtAmount)}</td><td className="num">{peso(l.amount)}</td></tr>)}
          <tr className="total"><td colSpan={5} className="num">Total paid</td><td className="num">{peso(p.amount)}</td></tr>
          {ewt > 0n && <tr><td colSpan={5} className="num muted">Tax withheld on the bills paid (BIR 2307)</td><td className="num muted">{formatPeso(ewt)}</td></tr>}
        </tbody>
      </table></div>
      <div className="card grid sign">
        <div><label>Prepared by</label>{who(p.createdById)}</div>
        <div><label>Approved by</label>{p.approvedById ? who(p.approvedById) : "—"}<div className="muted">{p.approvedAt?.toISOString().slice(0, 10)}</div></div>
        <div className="print-only"><label>Received payment (signature over printed name, date)</label><br /><br />______________________</div>
      </div>
      {p.status !== "DRAFT" && <ApprovalPanel organizationId={ctx.org.id} docType="PAYMENT" docId={p.id} total={total} preparerIds={preparers} userId={ctx.user.id} status={p.status} />}
    </>
  );
}
