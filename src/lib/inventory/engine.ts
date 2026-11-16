// Stock ledger and PAS 2 costing. Runs inside the caller's database transaction.
//
// In:  every inbound quantity becomes a cost layer (receipt date, location, lot, unit cost).
// Out: FIFO takes the oldest layers first; SPECIFIC identification takes the named lot/serial;
//      WEIGHTED_AVERAGE costs at the warehouse's running average (value / qty) and only uses the
//      layers to keep quantity by location and by age.
// Taking everything that is left always takes the exact remaining value, so no centavo is ever
// stranded in the books. Stock can never go negative.
import { Prisma } from "@prisma/client";
import { LedgerError } from "../ledger/service";
import { cents, formatQty, fromQty, fromUnitCost, share, toQty, unitCostOf } from "./qty";
import { fromCentavos } from "../money";

type Tx = Prisma.TransactionClient;
const dec = (c: bigint) => new Prisma.Decimal(fromCentavos(c));
const qdec = (q: bigint) => new Prisma.Decimal(fromQty(q));

export type CostingMethod = "FIFO" | "WEIGHTED_AVERAGE" | "SPECIFIC";
export const COSTING_LABELS: Record<string, string> = { FIFO: "FIFO", WEIGHTED_AVERAGE: "Weighted average", SPECIFIC: "Specific identification" };

type Item = { id: string; code: string; name: string; costingMethod: string };
type Ref = { organizationId: string; transactionId: string; lineId: string; date: Date; type: string };

/** Serialize all stock changes of one item in one warehouse (two users posting at once). */
export async function lockStock(tx: Tx, itemId: string, warehouseId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inv:${itemId}:${warehouseId}`}))`;
}

export async function balanceOf(tx: Tx, itemId: string, warehouseId: string) {
  const b = await tx.inventoryBalance.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } } });
  return { qty: b ? toQty(b.qty) : 0n, value: b ? cents(b.value) : 0n };
}

async function bump(tx: Tx, organizationId: string, itemId: string, warehouseId: string, qty: bigint, value: bigint) {
  const cur = await balanceOf(tx, itemId, warehouseId);
  const q = cur.qty + qty, v = cur.value + value;
  if (q < 0n) throw new LedgerError(["Stock would go negative"]);
  const data = { qty: qdec(q), value: dec(v) };
  await tx.inventoryBalance.upsert({ where: { itemId_warehouseId: { itemId, warehouseId } }, create: { organizationId, itemId, warehouseId, ...data }, update: data });
}

/** Current average unit cost in a warehouse (6 dp), or null if nothing is on hand. */
export async function averageCost(tx: Tx, itemId: string, warehouseId: string) {
  const b = await balanceOf(tx, itemId, warehouseId);
  return b.qty > 0n ? unitCostOf(b.value, b.qty) : null;
}

export type StockIn = { item: Item; warehouseId: string; locationId: string | null; lotNo: string | null; qty: bigint; value: bigint; receivedDate?: Date };

/** Add stock as a new cost layer. */
export async function addStock(tx: Tx, ref: Ref, s: StockIn) {
  if (s.qty <= 0n) throw new LedgerError([`${s.item.code}: quantity must be more than zero`]);
  if (s.value < 0n) throw new LedgerError([`${s.item.code}: cost cannot be negative`]);
  if (s.item.costingMethod === "SPECIFIC" && !s.lotNo) throw new LedgerError([`${s.item.code} uses specific identification: enter the lot or serial no.`]);
  const layer = await tx.inventoryLayer.create({
    data: {
      organizationId: ref.organizationId, itemId: s.item.id, warehouseId: s.warehouseId, locationId: s.locationId, lotNo: s.lotNo,
      receivedDate: s.receivedDate ?? ref.date, unitCost: new Prisma.Decimal(fromUnitCost(unitCostOf(s.value, s.qty))),
      qtyIn: qdec(s.qty), qtyRemaining: qdec(s.qty), valueIn: dec(s.value), valueRemaining: dec(s.value), sourceLineId: ref.lineId,
    },
  });
  await tx.inventoryMove.create({
    data: { organizationId: ref.organizationId, itemId: s.item.id, warehouseId: s.warehouseId, locationId: s.locationId, layerId: layer.id, date: ref.date, qty: qdec(s.qty), value: dec(s.value), type: ref.type, transactionId: ref.transactionId, lineId: ref.lineId },
  });
  await bump(tx, ref.organizationId, s.item.id, s.warehouseId, s.qty, s.value);
  return layer;
}

export type StockOut = { item: Item; warehouseId: string; locationId?: string | null; lotNo?: string | null; qty: bigint };
export type Consumed = { layerId: string; locationId: string | null; lotNo: string | null; receivedDate: Date; qty: bigint; value: bigint };

/** Remove stock using the item's costing method. Returns the cost taken and the layers used. */
export async function removeStock(tx: Tx, ref: Ref, s: StockOut): Promise<{ value: bigint; consumed: Consumed[] }> {
  const { item } = s;
  if (s.qty <= 0n) throw new LedgerError([`${item.code}: quantity must be more than zero`]);
  if (item.costingMethod === "SPECIFIC" && !s.lotNo) throw new LedgerError([`${item.code} uses specific identification: choose the lot or serial no. to issue`]);
  const layers = await tx.inventoryLayer.findMany({
    where: {
      itemId: item.id, warehouseId: s.warehouseId, qtyRemaining: { gt: 0 },
      ...(s.locationId ? { locationId: s.locationId } : {}), ...(s.lotNo ? { lotNo: s.lotNo } : {}),
    },
    orderBy: [{ receivedDate: "asc" }, { createdAt: "asc" }],
  });
  const available = layers.reduce((t, l) => t + toQty(l.qtyRemaining), 0n);
  if (available < s.qty) {
    const where = [s.lotNo ? `lot ${s.lotNo}` : null, s.locationId ? "that location" : null].filter(Boolean).join(" in ");
    throw new LedgerError([`${item.code} ${item.name}: only ${formatQty(available)} on hand${where ? ` (${where})` : ""}, cannot take out ${formatQty(s.qty)}`]);
  }

  // Weighted average: the cost comes from the warehouse balance, not the layers.
  let avgTotal: bigint | null = null;
  if (item.costingMethod === "WEIGHTED_AVERAGE") {
    const b = await balanceOf(tx, item.id, s.warehouseId);
    avgTotal = share(b.value, s.qty, b.qty);
  }

  let left = s.qty, taken = 0n;
  const consumed: Consumed[] = [];
  for (const l of layers) {
    if (left === 0n) break;
    const rem = toQty(l.qtyRemaining), remV = cents(l.valueRemaining);
    const q = rem < left ? rem : left;
    left -= q;
    // FIFO / specific: the layer's own cost. Average: spread the average cost over the layers used.
    let v = share(remV, q, rem);
    if (avgTotal !== null) v = left === 0n ? avgTotal - taken : share(avgTotal, q, s.qty);
    taken += v;
    const newQ = rem - q;
    await tx.inventoryLayer.update({ where: { id: l.id }, data: { qtyRemaining: qdec(newQ), valueRemaining: dec(newQ === 0n ? 0n : remV - v < 0n ? 0n : remV - v) } });
    await tx.inventoryMove.create({
      data: { organizationId: ref.organizationId, itemId: item.id, warehouseId: s.warehouseId, locationId: l.locationId, layerId: l.id, date: ref.date, qty: qdec(-q), value: dec(-v), type: ref.type, transactionId: ref.transactionId, lineId: ref.lineId },
    });
    consumed.push({ layerId: l.id, locationId: l.locationId, lotNo: l.lotNo, receivedDate: l.receivedDate, qty: q, value: v });
  }
  await bump(tx, ref.organizationId, item.id, s.warehouseId, -s.qty, -taken);
  return { value: taken, consumed };
}

/**
 * Undo every stock movement of a document (void). Stock taken out goes back to the layers it came
 * from; stock brought in is removed, which is only possible while that stock is untouched.
 */
export async function reverseMoves(tx: Tx, organizationId: string, transactionId: string, date: Date, label: string) {
  const moves = await tx.inventoryMove.findMany({ where: { transactionId, NOT: { type: "VOID" } }, orderBy: { seq: "desc" }, include: { item: true } });
  for (const m of moves) await lockStock(tx, m.itemId, m.warehouseId);
  for (const m of moves) {
    const q = toQty(m.qty), v = cents(m.value);
    if (!m.layerId) continue;
    const l = await tx.inventoryLayer.findUniqueOrThrow({ where: { id: m.layerId } });
    const rem = toQty(l.qtyRemaining), remV = cents(l.valueRemaining);
    if (q > 0n) {
      // This move created stock. It can only be taken back if none of it has been used since.
      if (rem < q) throw new LedgerError([`${label}: ${m.item.code} received here has already been issued or moved (${formatQty(q - rem)} used). Void those documents first, or record a return to vendor or an adjustment instead.`]);
      await tx.inventoryLayer.update({ where: { id: l.id }, data: { qtyRemaining: qdec(rem - q), valueRemaining: dec(rem - q === 0n ? 0n : remV - v) } });
    } else {
      await tx.inventoryLayer.update({ where: { id: l.id }, data: { qtyRemaining: qdec(rem - q), valueRemaining: dec(remV - v) } });
    }
    await tx.inventoryMove.create({
      data: { organizationId, itemId: m.itemId, warehouseId: m.warehouseId, locationId: m.locationId, layerId: m.layerId, date, qty: qdec(-q), value: dec(-v), type: "VOID", transactionId, lineId: m.lineId },
    });
    await bump(tx, organizationId, m.itemId, m.warehouseId, -q, -v);
  }
}
