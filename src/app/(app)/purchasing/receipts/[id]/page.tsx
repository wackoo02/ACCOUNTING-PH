import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { qty, userNames } from "@/lib/ap/view";
import { Workflow } from "@/components/ap/Workflow";

export default async function RrView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const rr = await prisma.goodsReceipt.findFirst({ where: { id, organizationId: ctx.org.id }, include: { purchaseOrder: true, lines: { include: { poLine: true } } } });
  if (!rr) notFound();
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const who = await userNames([rr.receivedById, rr.voidedById]);
  const stockDocs = await prisma.inventoryTransaction.findMany({ where: { organizationId: ctx.org.id, sourceModule: "PURCHASES", sourceId: rr.id }, orderBy: { createdAt: "asc" } });
  const whs = new Map((await prisma.warehouse.findMany({ where: { id: { in: stockDocs.map((d) => d.warehouseId) } } })).map((w) => [w.id, w.code]));
  const je = rr.journalEntryId ? await prisma.journalEntry.findUnique({ where: { id: rr.journalEntryId } }) : null;
  return (<>
    <div className="top"><h1>Receiving Report {rr.number} <span className={`badge ${rr.status}`}>{rr.status}</span></h1>
      <Workflow doc="RR" id={rr.id} ops={rr.status === "POSTED" && can(ctx.role, "journal.void") ? ["void"] : []} voidNote="The GL entry is reversed. Not allowed once the supplier's invoice for these items is recorded." /></div>
    <div className="print-only"><strong>{org.name}</strong><br />{org.registeredAddress}</div>
    {rr.status === "VOID" && <div className="notice">Voided by {who(rr.voidedById)}: {rr.voidReason}</div>}
    <div className="card grid">
      <div><label>Date received</label>{fmtDate(rr.date)}</div>
      <div><label>Purchase order</label><Link href={`/purchasing/orders/${rr.purchaseOrderId}`}>{rr.purchaseOrder.number}</Link></div>
      <div><label>Supplier</label>{rr.purchaseOrder.vendorName}</div>
      <div><label>Delivery receipt no.</label>{rr.deliveryRef || "—"}</div>
      {je && <div><label>GL entry</label><Link href={`/journals/${je.id}`}>{je.number}</Link></div>}
      {stockDocs.map((d) => <div key={d.id}><label>Stock received into {whs.get(d.warehouseId)}</label><Link href={`/inventory/transactions/${d.id}`}>{d.number}</Link>{d.status === "VOID" && " (void)"}</div>)}
    </div>
    {rr.notes && <p>{rr.notes}</p>}
    <div className="table-wrap"><table>
      <thead><tr><th>#</th><th>Item</th><th className="num">Quantity received</th><th>Remarks</th></tr></thead>
      <tbody>{rr.lines.map((l) => <tr key={l.id}><td>{l.poLine.lineNo}</td><td>{l.poLine.description}</td><td className="num">{qty(l.quantity)} {l.poLine.unit}</td><td>{l.remarks}</td></tr>)}</tbody>
    </table></div>
    <div className="card grid sign"><div><label>Received by</label>{who(rr.receivedById)}</div><div className="print-only"><label>Inspected by</label><br /><br />______________________</div></div>
  </>);
}
