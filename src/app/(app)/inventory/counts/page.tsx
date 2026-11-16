import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate, today } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { newCount } from "../../inventory-actions";

export default async function Counts() {
  const ctx = await requireCtx("reports.view");
  const [counts, whs, locs, cats] = await Promise.all([
    prisma.inventoryCount.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ date: "desc" }, { number: "desc" }], take: 200, include: { _count: { select: { lines: true } } } }),
    prisma.warehouse.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { code: "asc" } }),
    prisma.warehouseLocation.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { code: "asc" }, include: { warehouse: { select: { code: true } } } }),
    prisma.product.findMany({ where: { organizationId: ctx.org.id, isStocked: true, category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" } }),
  ]);
  const wh = new Map(whs.map((w) => [w.id, w.code]));
  return (
    <>
      <div className="top"><h1>Cycle Counts and Physical Inventory</h1></div>
      {can(ctx.role, "inventory.transact") && (
        <ActionForm action={newCount} className="card">
          <h2 style={{ marginTop: 0 }}>Start a count</h2>
          <div className="row">
            <div><label>Type</label><select name="type" defaultValue="CYCLE"><option value="CYCLE">Cycle count (part of the stock)</option><option value="PHYSICAL">Physical inventory (whole warehouse)</option></select></div>
            <div><label>Warehouse</label><select name="warehouseId" required>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></div>
            <div><label>Count date</label><input type="date" name="date" defaultValue={today()} required /></div>
            <div><label>Cycle count: category</label><select name="category" defaultValue=""><option value="">—</option>{cats.map((c) => <option key={c.category} value={c.category!}>{c.category}</option>)}</select></div>
            <div><label>or bin / location</label><select name="locationId" defaultValue=""><option value="">—</option>{locs.map((l) => <option key={l.id} value={l.id}>{l.warehouse.code} {l.code}</option>)}</select></div>
          </div>
          <div style={{ marginTop: 10 }}><label>Notes</label><input name="memo" placeholder="e.g. Year-end count, team A" /></div>
          <p className="muted">The count sheet lists what the system shows on hand by item, bin and lot. Count blind if you prefer: print the sheet without the system column. Variances post as one adjustment after approval.</p>
          <button>Create count sheet</button>
        </ActionForm>
      )}
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Type</th><th>Warehouse</th><th>Notes</th><th className="num">Lines</th><th>Status</th></tr></thead>
        <tbody>
          {counts.map((c) => (
            <tr key={c.id}><td>{fmtDate(c.date)}</td><td><Link href={`/inventory/counts/${c.id}`}>{c.number}</Link></td><td>{c.type === "PHYSICAL" ? "Physical inventory" : "Cycle count"}</td>
              <td>{wh.get(c.warehouseId)}</td><td>{c.memo}</td><td className="num">{c._count.lines}</td><td><span className={`badge ${c.status}`}>{c.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : c.status}</span></td></tr>
          ))}
          {counts.length === 0 && <tr><td colSpan={7} className="muted">No counts yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
