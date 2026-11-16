import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { stockStatus } from "@/lib/inventory/reports";
import { COSTING_LABELS } from "@/lib/inventory/engine";
import { formatQty, formatUnitCost } from "@/lib/inventory/qty";

type SP = Promise<Record<string, string | undefined>>;

export default async function StockStatus({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const [whs, cats, pending] = await Promise.all([
    prisma.warehouse.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } }),
    prisma.product.findMany({ where: { organizationId: ctx.org.id, isStocked: true, category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" } }),
    prisma.inventoryTransaction.count({ where: { organizationId: ctx.org.id, status: "PENDING_APPROVAL" } }),
  ]);
  const r = await stockStatus(ctx.org.id, { warehouseId: sp.wh || undefined, category: sp.cat || undefined, q: sp.q, belowOnly: sp.below === "1" });
  const below = r.rows.filter((x) => x.belowReorder).length;
  return (
    <>
      <div className="top"><h1>Stock Status</h1>
        {can(ctx.role, "inventory.transact") && <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}>
          <Link className="btn" href="/inventory/transactions/new?type=RECEIPT">Receive stock</Link>
          <Link className="btn" href="/inventory/transactions/new?type=ISSUE">Issue stock</Link>
          <Link className="btn secondary" href="/inventory/counts">Counts</Link>
        </div>}
      </div>
      {whs.length === 0 && <div className="notice">Start by adding your warehouses (<Link href="/masters/warehouses">Master Lists → Warehouses</Link>) and bins (<Link href="/masters/locations">Warehouse Locations</Link>), then set Track Inventory = TRUE on the goods in <Link href="/masters/products">Products and Prices</Link>.</div>}
      {pending > 0 && <div className="notice">{pending} adjustment(s) waiting for approval. <Link href="/inventory/transactions?status=PENDING_APPROVAL">Review</Link></div>}
      <div className="grid" style={{ marginBottom: 12 }}>
        <div className="card stat"><div className="l">Inventory value</div><div className="n">{formatPeso(r.total)}</div></div>
        <div className="card stat"><div className="l">Item / warehouse lines</div><div className="n">{r.rows.length}</div></div>
        <div className="card stat"><div className="l">At or below reorder point</div><div className="n">{below}</div></div>
      </div>
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="Code, name, barcode" /></div>
        <div><label>Warehouse</label><select name="wh" defaultValue={sp.wh ?? ""}><option value="">All</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.code}</option>)}</select></div>
        <div><label>Category</label><select name="cat" defaultValue={sp.cat ?? ""}><option value="">All</option>{cats.map((c) => <option key={c.category} value={c.category!}>{c.category}</option>)}</select></div>
        <div><label>Show</label><select name="below" defaultValue={sp.below ?? ""}><option value="">All items</option><option value="1">Reorder needed</option></select></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Category</th><th>Warehouse</th><th>Bins / lots</th><th className="num">On hand</th><th>Unit</th><th className="num">Unit cost</th><th className="num">Value</th><th className="num">Reorder point</th><th>Costing</th><th>Last receipt</th><th>Last issue</th></tr></thead>
        <tbody>
          {r.rows.map((x) => (
            <tr key={`${x.itemId}-${x.warehouseCode}`}>
              <td><Link href={`/inventory/items/${x.itemId}`}>{x.code}</Link> {x.name}</td><td>{x.category}</td><td>{x.warehouseCode || "—"}</td>
              <td className="muted">{x.locations.map((l) => `${l.where}: ${formatQty(l.qty)}`).join("; ")}</td>
              <td className="num">{formatQty(x.qty)}</td><td>{x.unit}</td><td className="num">{x.qty ? formatUnitCost(x.unitCost) : ""}</td><td className="num">{formatPeso(x.value)}</td>
              <td className="num">{x.reorderPoint ? formatQty(x.reorderPoint) : ""}{x.belowReorder && <> <span className="badge DRAFT">REORDER{x.reorderQty ? ` ${formatQty(x.reorderQty)}` : ""}</span></>}</td>
              <td>{COSTING_LABELS[x.method]}</td><td>{x.lastReceipt ? fmtDate(x.lastReceipt) : ""}</td><td>{x.lastIssue ? fmtDate(x.lastIssue) : ""}</td>
            </tr>
          ))}
          {r.rows.length === 0 && <tr><td colSpan={12} className="muted">No inventory items found.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
