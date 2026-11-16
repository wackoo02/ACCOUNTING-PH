import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDate } from "@/lib/format";
import { userNames } from "@/lib/ap/view";

export default async function RrList() {
  const ctx = await requireCtx("reports.view");
  const rows = await prisma.goodsReceipt.findMany({ where: { organizationId: ctx.org.id }, include: { purchaseOrder: true, lines: true }, orderBy: [{ date: "desc" }, { number: "desc" }], take: 300 });
  const who = await userNames(rows.map((r) => r.receivedById));
  return (<>
    <div className="top"><h1>Receiving Reports</h1></div>
    <p className="muted">Receive items from an approved PO (open the PO, then &quot;Receive items&quot;).</p>
    <div className="table-wrap"><table>
      <thead><tr><th>Date</th><th>No.</th><th>PO</th><th>Supplier</th><th>Delivery receipt</th><th className="num">Items</th><th>Received by</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td>{fmtDate(r.date)}</td><td><Link href={`/purchasing/receipts/${r.id}`}>{r.number}</Link></td><td><Link href={`/purchasing/orders/${r.purchaseOrderId}`}>{r.purchaseOrder.number}</Link></td><td>{r.purchaseOrder.vendorName}</td><td>{r.deliveryRef}</td><td className="num">{r.lines.length}</td><td>{who(r.receivedById)}</td><td><span className={`badge ${r.status}`}>{r.status}</span></td></tr>)}
        {!rows.length && <tr><td colSpan={8} className="muted">Nothing received yet.</td></tr>}</tbody>
    </table></div>
  </>);
}
