import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { peso, statusText } from "@/lib/ap/view";

export default async function PoList({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; vendor?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const where: Prisma.PurchaseOrderWhereInput = { organizationId: ctx.org.id };
  if (sp.status) where.status = sp.status as Prisma.PurchaseOrderWhereInput["status"];
  if (sp.vendor) where.vendorId = sp.vendor;
  if (sp.q) where.OR = [{ number: { contains: sp.q, mode: "insensitive" } }, { description: { contains: sp.q, mode: "insensitive" } }, { vendorName: { contains: sp.q, mode: "insensitive" } }];
  const [rows, vendors] = await Promise.all([
    prisma.purchaseOrder.findMany({ where, include: { receipts: { where: { status: "POSTED" }, select: { id: true } }, lines: { select: { id: true } } }, orderBy: [{ poDate: "desc" }, { number: "desc" }], take: 300 }),
    prisma.vendor.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: "asc" } }),
  ]);
  return (
    <>
      <div className="top"><h1>Purchase Orders</h1>{can(ctx.role, "journal.create") && <Link className="btn" href="/purchasing/orders/new">New purchase order</Link>}</div>
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="PO no., supplier, description" /></div>
        <div><label>Supplier</label><select name="vendor" defaultValue={sp.vendor ?? ""}><option value="">All</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option>{["DRAFT", "PENDING_APPROVAL", "APPROVED", "CLOSED", "CANCELLED"].map((s) => <option key={s} value={s}>{statusText(s)}</option>)}</select></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>PO no.</th><th>Supplier</th><th>Description</th><th>Delivery</th><th>Receiving</th><th>Status</th><th className="num">Total</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.id}><td>{fmtDate(r.poDate)}</td><td><Link href={`/purchasing/orders/${r.id}`}>{r.number}</Link></td><td>{r.vendorName}</td><td>{r.description}</td><td>{r.deliveryDate ? fmtDate(r.deliveryDate) : ""}</td>
            <td>{!r.lines.length ? <span className="muted">petty cash PO</span> : r.receipts.length ? `${r.receipts.length} receipt(s)` : r.status === "APPROVED" ? "awaiting delivery" : ""}</td>
            <td><span className={`badge ${r.status}`}>{statusText(r.status)}</span></td><td className="num">{r.currencyCode !== "PHP" ? r.currencyCode + " " : ""}{peso(r.amount)}</td></tr>)}
          {!rows.length && <tr><td colSpan={8} className="muted">No purchase orders yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
