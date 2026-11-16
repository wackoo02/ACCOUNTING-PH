import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { peso, statusText, userNames } from "@/lib/ap/view";

export default async function PrList({ searchParams }: { searchParams: Promise<{ status?: string; q?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const rows = await prisma.purchaseRequest.findMany({
    where: { organizationId: ctx.org.id, ...(sp.status ? { status: sp.status } : {}), ...(sp.q ? { OR: [{ number: { contains: sp.q, mode: "insensitive" } }, { purpose: { contains: sp.q, mode: "insensitive" } }] } : {}) },
    orderBy: [{ date: "desc" }, { number: "desc" }], take: 300,
  });
  const who = await userNames(rows.map((r) => r.requestedById));
  return (
    <>
      <div className="top"><h1>Purchase Requests</h1>{can(ctx.role, "journal.create") && <Link className="btn" href="/purchasing/requests/new">New purchase request</Link>}</div>
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="No. or purpose" /></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option>{["DRAFT", "PENDING_APPROVAL", "APPROVED", "ORDERED", "CLOSED", "CANCELLED"].map((s) => <option key={s} value={s}>{statusText(s)}</option>)}</select></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Purpose</th><th>Requested by</th><th>Needed by</th><th>Status</th><th className="num">Estimate</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.id}><td>{fmtDate(r.date)}</td><td><Link href={`/purchasing/requests/${r.id}`}>{r.number}</Link></td><td>{r.purpose}</td><td>{who(r.requestedById)}</td><td>{r.neededBy ? fmtDate(r.neededBy) : ""}</td><td><span className={`badge ${r.status}`}>{statusText(r.status)}</span></td><td className="num">{peso(r.estimatedTotal)}</td></tr>)}
          {!rows.length && <tr><td colSpan={7} className="muted">No purchase requests yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
