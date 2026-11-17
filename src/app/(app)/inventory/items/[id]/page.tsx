import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatPeso } from "@/lib/money";
import { fmtDate, firstOfYear, parseDateParam, today } from "@/lib/format";
import { stockCard } from "@/lib/inventory/reports";
import { COSTING_LABELS } from "@/lib/inventory/engine";
import { INV_LABELS, type InvType } from "@/lib/inventory/service";
import { formatQty } from "@/lib/inventory/qty";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

type SP = Promise<Record<string, string | undefined>>;

export default async function StockCard({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const whs = await prisma.warehouse.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } });
  const c = await stockCard(ctx.org.id, { itemId: id, warehouseId: sp.wh || undefined, from: new Date(from), to: new Date(to) });
  if (!c.item) notFound();
  const i = c.item;
  return (
    <>
      <div className="top"><h1>Stock Card: {i.code} {i.name}</h1>
        <div className="row noprint" style={{ gap: 8, flex: 0 }}><Link className="btn secondary" href={`/inventory/labels?items=${i.id}`}>Print barcode label</Link></div></div>
      <div className="card grid">
        <div><label>Category</label>{i.category || "—"}</div><div><label>Unit</label>{i.unit || "—"}</div>
        <div><label>Costing method</label>{COSTING_LABELS[i.costingMethod]}</div><div><label>Barcode</label>{i.barcode || "—"}</div>
        <div><label>Reorder point</label>{i.reorderPoint.toString()}</div><div><label>Default vendor</label>{i.defaultVendorCode || "—"}</div>
      </div>
      <form className="card row noprint">
        <div><label>Warehouse</label><MasterPicker name="wh" ariaLabel="Warehouse" defaultValue={sp.wh ?? ""} emptyLabel="All" placeholder="All" options={idOpts(whs)} /></div>
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Document</th><th>Type</th><th>Warehouse</th><th>Bin</th><th>Lot</th><th className="num">In</th><th className="num">Out</th><th className="num">Cost</th><th className="num">Balance qty</th><th className="num">Balance value</th></tr></thead>
        <tbody>
          <tr className="total"><td colSpan={9}>Opening balance {from}</td><td className="num">{formatQty(c.openingQty)}</td><td className="num">{formatPeso(c.openingValue)}</td></tr>
          {c.rows.map((r) => (
            <tr key={r.id}>
              <td>{fmtDate(r.date)}</td><td><Link href={`/inventory/transactions/${r.transactionId}`}>{r.number}</Link> <span className="muted">{r.memo}</span></td>
              <td>{r.type === "VOID" ? "Void" : INV_LABELS[r.type as InvType]}</td><td>{r.warehouseCode}</td><td>{r.location}</td><td>{r.lotNo}</td>
              <td className="num">{r.qtyIn ? formatQty(r.qtyIn) : ""}</td><td className="num">{r.qtyOut ? formatQty(r.qtyOut) : ""}</td><td className="num">{formatPeso(r.value)}</td>
              <td className="num">{formatQty(r.balanceQty)}</td><td className="num">{formatPeso(r.balanceValue)}</td>
            </tr>
          ))}
          <tr className="total"><td colSpan={9}>Closing balance {to}</td><td className="num">{formatQty(c.closingQty)}</td><td className="num">{formatPeso(c.closingValue)}</td></tr>
        </tbody>
      </table></div>
    </>
  );
}
