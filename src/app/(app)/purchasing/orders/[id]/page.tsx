import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate, today } from "@/lib/format";
import { cents, q4of } from "@/lib/ap/common";
import { CATEGORY_LABELS, fromQ4, roundDiv, type Category } from "@/lib/ap/compute";
import { peso, qty, statusText, userNames } from "@/lib/ap/view";
import { poProgress } from "@/lib/purchasing/service";
import { canApproveNow } from "@/lib/approvals";
import { Workflow } from "@/components/ap/Workflow";
import { ApprovalPanel } from "@/components/ap/ApprovalPanel";
import { ActionForm } from "@/components/ActionForm";
import { receiveAction } from "../../../ap-actions";

export default async function PoView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const po = await prisma.purchaseOrder.findFirst({ where: { id, organizationId: ctx.org.id }, include: { receipts: { orderBy: { date: "asc" } }, request: true } });
  if (!po) notFound();
  const [org, vendor, progress, bills] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    po.vendorId ? prisma.vendor.findUnique({ where: { id: po.vendorId } }) : null,
    poProgress(prisma, po.id),
    prisma.apBill.findMany({ where: { purchaseOrderId: po.id, status: { not: "VOID" } }, orderBy: { date: "asc" } }),
  ]);
  const accounts = new Map((await prisma.account.findMany({ where: { id: { in: progress.map((p) => p.line.accountId) } } })).map((a) => [a.id, a]));
  const who = await userNames([po.createdById, po.approvedById]);
  const total = roundDiv(cents(po.amount) * q4of(po.fxRate), 10000n);
  const create = can(ctx.role, "journal.create");
  const preparers = [po.createdById, po.submittedById, po.updatedById];
  const appr = po.status === "PENDING_APPROVAL" ? await canApproveNow(ctx.org.id, "PO", po.id, ctx.user.id, total, preparers) : null;
  const ops = [
    ...(po.status === "DRAFT" && create && progress.length ? ["submit" as const] : []),
    ...(appr?.ok ? ["approve" as const, "return" as const] : []),
    ...(po.status === "APPROVED" && can(ctx.role, "journal.void") ? ["close" as const] : []),
    ...(["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(po.status) && can(ctx.role, "journal.void") && !po.receipts.some((r) => r.status === "POSTED") ? ["cancel" as const] : []),
  ];
  const canReceive = po.status === "APPROVED" && create && progress.some((p) => p.received < p.ordered);
  return (
    <>
      <div className="top">
        <h1>Purchase Order {po.number} <span className={`badge ${po.status}`}>{statusText(po.status)}</span></h1>
        <div className="row" style={{ gap: 8, flex: 0 }}>
          {po.status === "DRAFT" && create && progress.length > 0 && <Link className="btn secondary" href={`/purchasing/orders/${po.id}/edit`}>Edit</Link>}
          {["APPROVED", "CLOSED"].includes(po.status) && create && <Link className="btn secondary" href={`/ap/bills/new?po=${po.id}`}>Record supplier invoice</Link>}
          <Workflow doc="PO" id={po.id} ops={ops} />
        </div>
      </div>
      <div className="print-only"><strong>{org.name}</strong>{org.tin ? ` · TIN ${org.tin}` : ""}<br />{org.registeredAddress}<h2>PURCHASE ORDER {po.number}</h2></div>
      {po.rejectReason && po.status === "DRAFT" && <div className="errors">Returned: {po.rejectReason}</div>}
      {po.closeReason && <div className="notice">{po.status === "CANCELLED" ? "Cancelled" : "Closed"}: {po.closeReason}</div>}
      {!progress.length && <div className="notice">This is a petty cash PO (amount only, no item lines). It was created from the mobile app.</div>}
      <div className="card grid">
        <div><label>Supplier</label>{vendor?.name ?? po.vendorName}{vendor?.tin && <div className="muted">TIN {vendor.tin}</div>}{vendor?.address && <div className="muted">{vendor.address}</div>}</div>
        <div><label>PO date</label>{fmtDate(po.poDate)}</div>
        <div><label>Delivery date</label>{po.deliveryDate ? fmtDate(po.deliveryDate) : "—"}</div>
        <div><label>Deliver to</label>{po.deliverTo || "—"}</div>
        <div><label>Terms</label>{po.paymentTermsDays ?? vendor?.paymentTermsDays ?? "—"} days</div>
        {po.request && <div><label>Purchase request</label><Link href={`/purchasing/requests/${po.request.id}`}>{po.request.number}</Link></div>}
        {po.rfqId && <div><label>Canvass</label><Link href={`/purchasing/rfq/${po.rfqId}`}>view RFQ</Link></div>}
      </div>
      <p><strong>{po.description}</strong>{po.notes && <> · {po.notes}</>}</p>
      {progress.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Item</th><th>Type / account</th><th className="num">Ordered</th><th className="num">Unit price{po.vatInclusive ? " (VAT incl.)" : ""}</th><th className="num">Amount</th><th className="num noprint">Received</th><th className="num noprint">Billed</th></tr></thead>
        <tbody>
          {progress.map(({ line: l, received, billed, ordered }) => { const a = accounts.get(l.accountId); return (
            <tr key={l.id}><td>{l.lineNo}</td><td>{l.description}</td><td>{CATEGORY_LABELS[l.category as Category]}<div className="muted">{a?.code} {a?.name}</div></td><td className="num">{qty(l.quantity)} {l.unit}</td><td className="num">{peso(fromQ4(q4of(l.unitPrice)).replace(/(\.\d{2})\d+$/, "$1"))}</td><td className="num">{peso((cents(l.netAmount) + cents(l.vatAmount)).toString().replace(/(\d{2})$/, ".$1"))}</td>
              <td className={`num noprint ${received >= ordered ? "diff-ok" : ""}`}>{fromQ4(received)}</td><td className="num noprint">{fromQ4(billed)}</td></tr>); })}
          <tr><td colSpan={5} className="num">Net of VAT</td><td className="num">{peso(po.subtotal)}</td><td colSpan={2} className="noprint" /></tr>
          <tr><td colSpan={5} className="num">VAT</td><td className="num">{peso(po.vatAmount)}</td><td colSpan={2} className="noprint" /></tr>
          <tr className="total"><td colSpan={5} className="num">Total {po.currencyCode}</td><td className="num">{peso(po.amount)}</td><td colSpan={2} className="noprint" /></tr>
        </tbody>
      </table></div>}
      <div className="card grid sign">
        <div><label>Prepared by</label>{who(po.createdById)}</div>
        <div><label>Approved by</label>{po.approvedById ? who(po.approvedById) : "—"}<div className="muted">{po.approvedAt?.toISOString().slice(0, 10)}</div></div>
        <div className="print-only"><label>Conforme (supplier)</label><br /><br />______________________</div>
      </div>
      {po.status !== "DRAFT" && progress.length > 0 && <ApprovalPanel organizationId={ctx.org.id} docType="PO" docId={po.id} total={total} preparerIds={preparers} userId={ctx.user.id} status={po.status} />}

      {canReceive && <ActionForm action={receiveAction} className="card noprint">
        <strong>Receive items (receiving report / service acceptance)</strong>
        <input type="hidden" name="purchaseOrderId" value={po.id} />
        <div className="row" style={{ marginTop: 8 }}>
          <div><label>Date received</label><input type="date" name="date" defaultValue={today()} required /></div>
          <div><label>Supplier&apos;s delivery receipt no.</label><input name="deliveryRef" /></div>
          <div style={{ flex: 2 }}><label>Notes</label><input name="notes" /></div>
        </div>
        <table style={{ marginTop: 8 }}><thead><tr><th>Item</th><th className="num">Still to receive</th><th className="num" style={{ width: 140 }}>Received now</th><th>Remarks (damaged, short)</th></tr></thead>
          <tbody>{progress.filter((p) => p.received < p.ordered).map((p) => <tr key={p.line.id}><td>{p.line.description}</td><td className="num">{fromQ4(p.ordered - p.received)} {p.line.unit}</td><td><input name={`qty_${p.line.id}`} className="num" defaultValue={fromQ4(p.ordered - p.received)} /></td><td><input name={`rem_${p.line.id}`} /></td></tr>)}</tbody></table>
        <p className="muted">Posting books the cost as received and not yet invoiced (Dr expense / inventory / asset, Cr Goods Received Not Yet Invoiced). The supplier&apos;s invoice clears it.</p>
        <button>Post receiving report</button>
      </ActionForm>}

      {(po.receipts.length > 0 || bills.length > 0) && <>
        <h2>Receiving reports and supplier invoices</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Document</th><th>Reference</th><th>Status</th></tr></thead>
          <tbody>
            {po.receipts.map((r) => <tr key={r.id}><td>{fmtDate(r.date)}</td><td><Link href={`/purchasing/receipts/${r.id}`}>{r.number}</Link> receiving report</td><td>{r.deliveryRef}</td><td><span className={`badge ${r.status}`}>{r.status}</span></td></tr>)}
            {bills.map((b) => <tr key={b.id}><td>{fmtDate(b.date)}</td><td><Link href={`/ap/bills/${b.id}`}>{b.number}</Link> supplier invoice</td><td>{b.supplierInvoiceNo} · {peso(b.total)}</td><td><span className={`badge ${b.status}`}>{statusText(b.status)}</span></td></tr>)}
          </tbody>
        </table></div>
      </>}
    </>
  );
}
