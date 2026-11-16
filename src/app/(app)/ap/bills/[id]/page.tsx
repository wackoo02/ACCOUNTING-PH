import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { formatPeso, toCentavos } from "@/lib/money";
import { cents, q4of } from "@/lib/ap/common";
import { CATEGORY_LABELS, VAT_LABELS, fromQ4, type Category, type VatType } from "@/lib/ap/compute";
import { billBaseTotal, openBalances } from "@/lib/ap/bills";
import { peso, qty, statusText, userNames } from "@/lib/ap/view";
import { canApproveNow } from "@/lib/approvals";
import { Workflow } from "@/components/ap/Workflow";
import { ApprovalPanel } from "@/components/ap/ApprovalPanel";

export default async function BillView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const b = await prisma.apBill.findFirst({ where: { id, organizationId: ctx.org.id }, include: { lines: { orderBy: { lineNo: "asc" }, include: { poLine: true } }, paymentLines: { include: { payment: true } } } });
  if (!b) notFound();
  const [vendor, po, journal, taxCodes] = await Promise.all([
    prisma.vendor.findUniqueOrThrow({ where: { id: b.vendorId } }),
    b.purchaseOrderId ? prisma.purchaseOrder.findUnique({ where: { id: b.purchaseOrderId } }) : null,
    b.journalEntryId ? prisma.journalEntry.findUnique({ where: { id: b.journalEntryId }, include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } }, reversedBy: true } }) : null,
    prisma.taxCode.findMany({ where: { organizationId: ctx.org.id, taxType: "EWT" } }),
  ]);
  const accounts = new Map((await prisma.account.findMany({ where: { id: { in: b.lines.map((l) => l.accountId) } } })).map((a) => [a.id, a]));
  const who = await userNames([b.createdById, b.approvedById, b.voidedById]);
  const preparers = [b.createdById, b.submittedById, b.updatedById];
  const total = billBaseTotal(b);
  const appr = b.status === "PENDING_APPROVAL" ? await canApproveNow(ctx.org.id, "BILL", b.id, ctx.user.id, total, preparers) : null;
  const create = can(ctx.role, "journal.create");
  const paid = (await openBalances(prisma, ctx.org.id, [b.id])).get(b.id) ?? 0n;
  const open = cents(b.netPayable) - paid;
  const notes = (b.matchNotes as string[] | null) ?? [];
  const ops = [
    ...(b.status === "DRAFT" && create ? ["submit" as const] : []),
    ...(appr?.ok ? ["approve" as const, "return" as const] : []),
    ...(b.status !== "VOID" && can(ctx.role, "journal.void") ? ["void" as const] : []),
  ];
  return (
    <>
      <div className="top">
        <h1>Bill {b.number} <span className={`badge ${b.status}`}>{statusText(b.status)}</span>{b.onHold && <span className="badge DRAFT"> ON HOLD</span>}</h1>
        <div className="row" style={{ gap: 8, flex: "0 0 auto", maxWidth: "70%", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "flex-start" }}>
          {b.status === "DRAFT" && create && <Link className="btn secondary" href={`/ap/bills/${b.id}/edit`}>Edit</Link>}
          {b.status === "POSTED" && open > 0n && create && !b.onHold && <Link className="btn secondary" href={`/ap/payments/new?vendor=${b.vendorId}&bill=${b.id}`}>Pay this bill</Link>}
          <Workflow doc="BILL" id={b.id} ops={ops} approveLabel={appr?.state.levels.length && appr.state.next?.level === appr.state.levels[appr.state.levels.length - 1].level ? "Approve and post" : "Approve"} voidNote="A posted bill's GL entry is reversed. Bills with payments cannot be voided until the payment is voided." />
        </div>
      </div>
      {b.rejectReason && b.status === "DRAFT" && <div className="errors">Returned: {b.rejectReason}</div>}
      {b.status === "VOID" && <div className="notice">Voided by {who(b.voidedById)}: {b.voidReason}</div>}
      {notes.length > 0 && b.status !== "VOID" && <div className="notice"><strong>3-way match notes</strong><ul style={{ margin: "4px 0 0" }}>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>}
      <div className="card grid">
        <div><label>Supplier</label>{vendor.name}<div className="muted">{vendor.tin ? `TIN ${vendor.tin}` : "no TIN on file"}{vendor.vatRegistered ? " · VAT" : " · non-VAT"}</div></div>
        <div><label>Supplier invoice</label>{b.supplierInvoiceNo}<div className="muted">dated {fmtDate(b.invoiceDate)}</div></div>
        <div><label>Posting date</label>{fmtDate(b.date)}</div>
        <div><label>Due date</label>{fmtDate(b.dueDate)}{b.scheduledPayDate && <div className="muted">scheduled {fmtDate(b.scheduledPayDate)}</div>}</div>
        <div><label>PO</label>{po ? <Link href={`/purchasing/orders/${po.id}`}>{po.number}</Link> : "none"}</div>
        {b.inboxDocumentId && <div><label>Source document</label><Link href={`/ap/inbox/${b.inboxDocumentId}`}>from AP inbox</Link></div>}
        <div><label>Unpaid</label><strong>{b.currencyCode} {formatPeso(b.status === "POSTED" ? open : cents(b.netPayable))}</strong></div>
      </div>
      <p><strong>{b.memo}</strong></p>
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Description</th><th>Type / account</th><th className="num">Qty</th><th className="num">Unit price</th><th>VAT</th><th className="num">Net</th><th className="num">VAT</th><th>EWT</th></tr></thead>
        <tbody>
          {b.lines.map((l) => { const a = accounts.get(l.accountId); const tc = taxCodes.find((t) => t.id === l.ewtTaxCodeId); return (
            <tr key={l.id}><td>{l.lineNo}</td><td>{l.description}{l.poLine && <div className="muted">PO line {l.poLine.lineNo}</div>}{l.prepaidStart && <div className="muted">covers {fmtDate(l.prepaidStart)} to {l.prepaidEnd ? fmtDate(l.prepaidEnd) : "?"}</div>}</td>
              <td>{CATEGORY_LABELS[l.category as Category]}<div className="muted">{a?.code} {a?.name}</div></td><td className="num">{qty(l.quantity)}</td><td className="num">{fromQ4(q4of(l.unitPrice))}</td>
              <td>{VAT_LABELS[l.vatType as VatType]}</td><td className="num">{peso(l.netAmount)}</td><td className="num">{peso(l.vatAmount)}</td><td>{tc ? `${tc.atcCode ?? tc.code} ${peso(l.ewtAmount)}` : ""}</td></tr>); })}
          <tr><td colSpan={6} className="num">Net of VAT / VAT</td><td className="num">{peso(b.subtotal)}</td><td className="num">{peso(b.vatAmount)}</td><td /></tr>
          <tr className="total"><td colSpan={6} className="num">Invoice total ({b.currencyCode})</td><td colSpan={2} className="num">{peso(b.total)}</td><td /></tr>
          <tr><td colSpan={6} className="num">Less expanded withholding tax</td><td colSpan={2} className="num">({peso(b.ewtAmount)})</td><td /></tr>
          <tr className="total"><td colSpan={6} className="num">Net payable to supplier</td><td colSpan={2} className="num">{peso(b.netPayable)}</td><td /></tr>
        </tbody>
      </table></div>
      <div className="card grid sign">
        <div><label>Prepared by</label>{who(b.createdById)}</div>
        <div><label>Approved and posted by</label>{b.approvedById ? who(b.approvedById) : "—"}<div className="muted">{b.approvedAt?.toISOString().slice(0, 10)}</div></div>
      </div>
      {b.status !== "DRAFT" && <ApprovalPanel organizationId={ctx.org.id} docType="BILL" docId={b.id} total={total} preparerIds={preparers} userId={ctx.user.id} status={b.status} />}
      {b.paymentLines.length > 0 && <>
        <h2>Payments</h2>
        <div className="table-wrap"><table><thead><tr><th>Date</th><th>Payment voucher</th><th>Status</th><th className="num">Amount</th></tr></thead>
          <tbody>{b.paymentLines.map((l) => <tr key={l.id}><td>{fmtDate(l.payment.date)}</td><td><Link href={`/ap/payments/${l.paymentId}`}>{l.payment.number}</Link></td><td><span className={`badge ${l.payment.status}`}>{statusText(l.payment.status)}</span></td><td className="num">{peso(l.amount)}</td></tr>)}</tbody></table></div>
      </>}
      {journal && <>
        <h2>General ledger entry <Link href={`/journals/${journal.id}`}>{journal.number}</Link>{journal.reversedBy && <> · reversed by <Link href={`/journals/${journal.reversedBy.id}`}>{journal.reversedBy.number}</Link></>}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>{journal.lines.map((l) => <tr key={l.id}><td>{l.account.code} · {l.account.name}</td><td>{l.description}</td><td className="num">{formatPeso(toCentavos(l.debit.toString()), { blankZero: true })}</td><td className="num">{formatPeso(toCentavos(l.credit.toString()), { blankZero: true })}</td></tr>)}</tbody>
        </table></div>
      </>}
    </>
  );
}
