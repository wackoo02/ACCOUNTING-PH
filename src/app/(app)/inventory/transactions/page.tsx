import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { INV_LABELS, INV_TYPES, type InvType } from "@/lib/inventory/service";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

type SP = Promise<Record<string, string | undefined>>;

export default async function InventoryDocs({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const where: Prisma.InventoryTransactionWhereInput = { organizationId: ctx.org.id };
  if (sp.status) where.status = sp.status;
  if (sp.type) where.type = sp.type;
  if (sp.wh) where.OR = [{ warehouseId: sp.wh }, { toWarehouseId: sp.wh }];
  if (sp.q) where.AND = [{ OR: [{ number: { contains: sp.q, mode: "insensitive" } }, { memo: { contains: sp.q, mode: "insensitive" } }, { reference: { contains: sp.q, mode: "insensitive" } }, { partyId: { contains: sp.q, mode: "insensitive" } }] }];
  if (sp.from || sp.to) where.date = { ...(sp.from ? { gte: new Date(sp.from) } : {}), ...(sp.to ? { lte: new Date(sp.to) } : {}) };
  const [rows, whs] = await Promise.all([
    prisma.inventoryTransaction.findMany({ where, orderBy: [{ date: "desc" }, { number: "desc" }], take: 300, include: { _count: { select: { lines: true } } } }),
    prisma.warehouse.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } }),
  ]);
  const wh = new Map(whs.map((w) => [w.id, w.code]));
  const create = can(ctx.role, "inventory.transact");
  return (
    <>
      <div className="top"><h1>Inventory Transactions</h1>
        {create && <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "wrap" }}>
          <Link className="btn" href="/inventory/transactions/new?type=RECEIPT">Receive</Link>
          <Link className="btn" href="/inventory/transactions/new?type=ISSUE">Issue</Link>
          <Link className="btn secondary" href="/inventory/transactions/new?type=TRANSFER">Transfer</Link>
          <Link className="btn secondary" href="/inventory/transactions/new?type=ADJUSTMENT">Adjust</Link>
          <Link className="btn secondary" href="/inventory/transactions/new?type=RETURN_IN">Customer return</Link>
          <Link className="btn secondary" href="/inventory/transactions/new?type=RETURN_OUT">Return to vendor</Link>
        </div>}
      </div>
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="No., reference, particulars" /></div>
        <div><label>Type</label><select name="type" defaultValue={sp.type ?? ""}><option value="">All</option>{INV_TYPES.map((t) => <option key={t} value={t}>{INV_LABELS[t]}</option>)}</select></div>
        <div><label>Warehouse</label><MasterPicker name="wh" ariaLabel="Warehouse" defaultValue={sp.wh ?? ""} emptyLabel="All" placeholder="All" options={idOpts(whs)} /></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option><option>DRAFT</option><option value="PENDING_APPROVAL">FOR APPROVAL</option><option>POSTED</option><option>VOID</option></select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={sp.from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={sp.to} /></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Type</th><th>Warehouse</th><th>Party</th><th>Particulars</th><th>Reference</th><th className="num">Lines</th><th>Status</th><th className="num">Cost</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{fmtDate(r.date)}</td><td><Link href={`/inventory/transactions/${r.id}`}>{r.number}</Link></td><td>{INV_LABELS[r.type as InvType]}{r.sourceModule && r.sourceModule !== "COUNT" ? <span className="muted"> · {r.sourceModule.toLowerCase()}</span> : null}</td>
              <td>{wh.get(r.warehouseId)}{r.toWarehouseId ? ` → ${wh.get(r.toWarehouseId)}` : ""}</td><td>{r.partyId}</td><td>{r.memo}</td><td>{r.reference}</td><td className="num">{r._count.lines}</td>
              <td><span className={`badge ${r.status}`}>{r.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : r.status}</span></td>
              <td className="num">{r.status === "POSTED" ? formatPeso(toCentavos(r.totalValue.toString())) : ""}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={10} className="muted">No inventory documents found.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
