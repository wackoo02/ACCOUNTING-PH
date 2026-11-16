import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { fmtDate } from "@/lib/format";

export default async function RfqList() {
  const ctx = await requireCtx("reports.view");
  const rows = await prisma.rfq.findMany({ where: { organizationId: ctx.org.id }, include: { quotes: true, request: true }, orderBy: [{ date: "desc" }, { number: "desc" }], take: 300 });
  return (<>
    <div className="top"><h1>Requests for Quotation (Canvass)</h1></div>
    <p className="muted">Create an RFQ from an approved purchase request, record each supplier&apos;s quote, and award the PO.</p>
    <div className="table-wrap"><table>
      <thead><tr><th>Date</th><th>No.</th><th>Purchase request</th><th>Reply due</th><th className="num">Quotes</th><th>Status</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td>{fmtDate(r.date)}</td><td><Link href={`/purchasing/rfq/${r.id}`}>{r.number}</Link></td><td>{r.request ? `${r.request.number} · ${r.request.purpose}` : ""}</td><td>{r.dueDate ? fmtDate(r.dueDate) : ""}</td><td className="num">{r.quotes.length}</td><td><span className={`badge ${r.status === "OPEN" ? "PENDING_APPROVAL" : r.status === "AWARDED" ? "POSTED" : "VOID"}`}>{r.status}</span></td></tr>)}
        {!rows.length && <tr><td colSpan={6} className="muted">No RFQs yet.</td></tr>}</tbody>
    </table></div>
  </>);
}
