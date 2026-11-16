// Inventory reports. Quantities are bigint ten-thousandths, values bigint centavos (see qty.ts).
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { asDay } from "../ledger/service";
import { cents, share, toQty, unitCostOf } from "./qty";

const DAY = 86_400_000;
type Filter = { warehouseId?: string; category?: string };

async function itemsAndWarehouses(organizationId: string, f: Filter) {
  const [items, whs] = await Promise.all([
    prisma.product.findMany({ where: { organizationId, isStocked: true, ...(f.category ? { category: f.category } : {}) }, orderBy: { code: "asc" } }),
    prisma.warehouse.findMany({ where: { organizationId }, orderBy: { code: "asc" } }),
  ]);
  return { items, item: new Map(items.map((i) => [i.id, i])), wh: new Map(whs.map((w) => [w.id, w])), whs };
}

async function movesUpTo(organizationId: string, asOf: Date, f: Filter, before = false) {
  return prisma.inventoryMove.groupBy({
    by: ["itemId", "warehouseId"],
    where: { organizationId, date: before ? { lt: asOf } : { lte: asOf }, ...(f.warehouseId ? { warehouseId: f.warehouseId } : {}) },
    _sum: { qty: true, value: true },
  });
}

/** Inventory valuation as of a date, reconciled to the inventory GL accounts. */
export async function valuation(organizationId: string, opts: Filter & { asOf: Date }) {
  const asOf = asDay(opts.asOf);
  const { items, item, wh } = await itemsAndWarehouses(organizationId, opts);
  const groups = await movesUpTo(organizationId, asOf, opts);
  const rows = groups
    .filter((g) => item.has(g.itemId))
    .map((g) => {
      const i = item.get(g.itemId)!, w = wh.get(g.warehouseId);
      const qty = toQty(g._sum.qty ?? 0), value = cents(g._sum.value);
      return { itemId: i.id, code: i.code, name: i.name, category: i.category, unit: i.unit, method: i.costingMethod, warehouseCode: w?.code ?? "", warehouseName: w?.name ?? "", qty, value, unitCost: unitCostOf(value, qty) };
    })
    .filter((r) => r.qty !== 0n || r.value !== 0n)
    .sort((a, b) => a.code.localeCompare(b.code) || a.warehouseCode.localeCompare(b.warehouseCode));
  const total = rows.reduce((s, r) => s + r.value, 0n);

  // GL side: every account an item uses as its inventory account, plus the INVENTORY role account.
  const codes = new Set(items.map((i) => i.inventoryAccountCode).filter(Boolean) as string[]);
  const accts = await prisma.account.findMany({ where: { organizationId, OR: [{ systemRole: "INVENTORY" }, { code: { in: [...codes] } }] }, orderBy: { code: "asc" } });
  const gl = await Promise.all(accts.map(async (a) => {
    const s = await prisma.journalLine.aggregate({ where: { organizationId, accountId: a.id, journalEntry: { status: "POSTED", book: "STATUTORY", date: { lte: asOf } } }, _sum: { debit: true, credit: true } });
    return { code: a.code, name: a.name, balance: cents(s._sum.debit) - cents(s._sum.credit) };
  }));
  const glTotal = gl.reduce((s, a) => s + a.balance, 0n);
  const filtered = !!(opts.warehouseId || opts.category);
  return { rows, total, gl, glTotal, glDifference: filtered ? null : glTotal - total };
}

/** Stock on hand now by item and warehouse, with locations and reorder flags. */
export async function stockStatus(organizationId: string, opts: Filter & { q?: string; belowOnly?: boolean }) {
  const { items, item, wh } = await itemsAndWarehouses(organizationId, opts);
  const [bals, layers, last] = await Promise.all([
    prisma.inventoryBalance.findMany({ where: { organizationId, ...(opts.warehouseId ? { warehouseId: opts.warehouseId } : {}) } }),
    prisma.inventoryLayer.findMany({ where: { organizationId, qtyRemaining: { gt: 0 }, ...(opts.warehouseId ? { warehouseId: opts.warehouseId } : {}) } }),
    prisma.inventoryMove.groupBy({ by: ["itemId", "warehouseId", "type"], where: { organizationId, type: { in: ["RECEIPT", "ISSUE"] } }, _max: { date: true } }),
  ]);
  const locs = await prisma.warehouseLocation.findMany({ where: { organizationId } });
  const loc = new Map(locs.map((l) => [l.id, l.code]));
  const q = opts.q?.toLowerCase();
  const rows = [];
  const seen = new Set<string>();
  for (const b of bals) {
    const i = item.get(b.itemId);
    if (!i) continue;
    seen.add(i.id);
    const qty = toQty(b.qty), value = cents(b.value);
    if (qty === 0n && toQty(i.reorderPoint) === 0n) continue;
    const byLoc = new Map<string, bigint>();
    for (const l of layers.filter((x) => x.itemId === i.id && x.warehouseId === b.warehouseId)) {
      const k = [l.locationId ? loc.get(l.locationId) : "No bin", l.lotNo].filter(Boolean).join(" · ");
      byLoc.set(k, (byLoc.get(k) ?? 0n) + toQty(l.qtyRemaining));
    }
    const lastOf = (t: string) => last.find((x) => x.itemId === i.id && x.warehouseId === b.warehouseId && x.type === t)?._max.date ?? null;
    rows.push(row(i, wh.get(b.warehouseId)?.code ?? "", qty, value, [...byLoc.entries()].map(([k, v]) => ({ where: k, qty: v })), lastOf("RECEIPT"), lastOf("ISSUE")));
  }
  if (!opts.warehouseId) for (const i of items) if (!seen.has(i.id)) rows.push(row(i, "", 0n, 0n, [], null, null));
  const out = rows
    .filter((r) => !q || [r.code, r.name, r.category ?? "", r.barcode ?? ""].some((s) => s.toLowerCase().includes(q)))
    .filter((r) => !opts.belowOnly || r.belowReorder)
    .sort((a, b) => a.code.localeCompare(b.code) || a.warehouseCode.localeCompare(b.warehouseCode));
  return { rows: out, total: out.reduce((s, r) => s + r.value, 0n) };

  function row(i: (typeof items)[number], warehouseCode: string, qty: bigint, value: bigint, locations: { where: string; qty: bigint }[], lastReceipt: Date | null, lastIssue: Date | null) {
    const rp = toQty(i.reorderPoint);
    return {
      itemId: i.id, code: i.code, name: i.name, category: i.category, barcode: i.barcode, unit: i.unit, method: i.costingMethod, warehouseCode,
      qty, value, unitCost: unitCostOf(value, qty), reorderPoint: rp, reorderQty: toQty(i.reorderQty), belowReorder: rp > 0n && qty <= rp,
      locations, lastReceipt, lastIssue, defaultVendorCode: i.defaultVendorCode,
    };
  }
}

export const AGING_BUCKETS = [
  { label: "0-30 days", max: 30 }, { label: "31-60", max: 60 }, { label: "61-90", max: 90 },
  { label: "91-180", max: 180 }, { label: "181-365", max: 365 }, { label: "Over 1 year", max: Infinity },
];

/** Age of the stock on hand by receipt date. Weighted-average items are valued at their average. */
export async function aging(organizationId: string, opts: Filter & { asOf?: Date }) {
  const asOf = asDay(opts.asOf ?? new Date());
  const { item, wh } = await itemsAndWarehouses(organizationId, opts);
  const [layers, bals] = await Promise.all([
    prisma.inventoryLayer.findMany({ where: { organizationId, qtyRemaining: { gt: 0 }, ...(opts.warehouseId ? { warehouseId: opts.warehouseId } : {}) }, orderBy: [{ receivedDate: "asc" }, { createdAt: "asc" }] }),
    prisma.inventoryBalance.findMany({ where: { organizationId } }),
  ]);
  const byKey = new Map<string, typeof layers>();
  for (const l of layers) {
    if (!item.has(l.itemId)) continue;
    const k = `${l.itemId}|${l.warehouseId}`;
    byKey.set(k, [...(byKey.get(k) ?? []), l]);
  }
  const rows: { itemId: string; code: string; name: string; category: string | null; warehouseCode: string; qty: bigint; value: bigint; buckets: { qty: bigint; value: bigint }[]; oldestDays: number }[] = [];
  for (const [k, ls] of byKey) {
    const [itemId, warehouseId] = k.split("|");
    const i = item.get(itemId)!;
    const buckets = AGING_BUCKETS.map(() => ({ qty: 0n, value: 0n }));
    const totalQty = ls.reduce((s, l) => s + toQty(l.qtyRemaining), 0n);
    const b = bals.find((x) => x.itemId === itemId && x.warehouseId === warehouseId);
    const balValue = b ? cents(b.value) : 0n;
    let allocated = 0n, qtyDone = 0n, oldest = 0;
    for (const l of ls) {
      const q = toQty(l.qtyRemaining);
      qtyDone += q;
      let v = cents(l.valueRemaining);
      if (i.costingMethod === "WEIGHTED_AVERAGE") { v = qtyDone === totalQty ? balValue - allocated : share(balValue, q, totalQty); allocated += v; }
      const age = Math.max(0, Math.floor((asOf.getTime() - l.receivedDate.getTime()) / DAY));
      oldest = Math.max(oldest, age);
      const bi = AGING_BUCKETS.findIndex((x) => age <= x.max);
      buckets[bi].qty += q; buckets[bi].value += v;
    }
    rows.push({ itemId, code: i.code, name: i.name, category: i.category, warehouseCode: wh.get(warehouseId)?.code ?? "", qty: totalQty, value: buckets.reduce((s, x) => s + x.value, 0n), buckets, oldestDays: oldest });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code) || a.warehouseCode.localeCompare(b.warehouseCode));
  const totals = AGING_BUCKETS.map((_, j) => rows.reduce((s, r) => s + r.buckets[j].value, 0n));
  return { asOf, rows, totals, total: totals.reduce((s, x) => s + x, 0n) };
}

/** Items on hand with no issue (sale or use) in the last `days` days. */
export async function slowMoving(organizationId: string, opts: Filter & { asOf?: Date; days: number }) {
  const asOf = asDay(opts.asOf ?? new Date());
  const cutoff = new Date(asOf.getTime() - opts.days * DAY);
  const { item, wh } = await itemsAndWarehouses(organizationId, opts);
  const bals = await prisma.inventoryBalance.findMany({ where: { organizationId, qty: { gt: 0 }, ...(opts.warehouseId ? { warehouseId: opts.warehouseId } : {}) } });
  const issues = await issueMoves(organizationId, new Date(0), asOf, opts.warehouseId);
  const receipts = await prisma.inventoryMove.groupBy({ by: ["itemId", "warehouseId"], where: { organizationId, type: "RECEIPT", date: { lte: asOf } }, _max: { date: true } });
  const rows = [];
  for (const b of bals) {
    const i = item.get(b.itemId);
    if (!i) continue;
    const mine = issues.filter((m) => m.itemId === b.itemId && m.warehouseId === b.warehouseId);
    const lastIssue = mine.reduce<Date | null>((d, m) => (!d || m.date > d ? m.date : d), null);
    const usedInWindow = mine.filter((m) => m.date > cutoff).reduce((s, m) => s + m.qty, 0n);
    if (usedInWindow > 0n) continue;
    rows.push({
      itemId: i.id, code: i.code, name: i.name, category: i.category, warehouseCode: wh.get(b.warehouseId)?.code ?? "",
      qty: toQty(b.qty), value: cents(b.value), lastIssue, lastReceipt: receipts.find((r) => r.itemId === b.itemId && r.warehouseId === b.warehouseId)?._max.date ?? null,
      daysIdle: lastIssue ? Math.floor((asOf.getTime() - lastIssue.getTime()) / DAY) : null,
    });
  }
  rows.sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  return { asOf, days: opts.days, rows, total: rows.reduce((s, r) => s + r.value, 0n) };
}

/** Net stock used by issues (less customer returns), void documents excluded. Positive = used. */
async function issueMoves(organizationId: string, from: Date, to: Date, warehouseId?: string) {
  const rows = await prisma.$queryRaw<{ itemId: string; warehouseId: string; date: Date; qty: Prisma.Decimal; value: Prisma.Decimal }[]>`
    SELECT m."itemId", m."warehouseId", m."date", -SUM(m."qty") AS qty, -SUM(m."value") AS value
    FROM "InventoryMove" m JOIN "InventoryTransaction" t ON t."id" = m."transactionId"
    WHERE m."organizationId" = ${organizationId} AND m."date" >= ${from} AND m."date" <= ${to}
      AND t."type" IN ('ISSUE', 'RETURN_IN') AND t."status" <> 'VOID'
      ${warehouseId ? Prisma.sql`AND m."warehouseId" = ${warehouseId}` : Prisma.empty}
    GROUP BY m."itemId", m."warehouseId", m."date"`;
  return rows.map((r) => ({ itemId: r.itemId, warehouseId: r.warehouseId, date: r.date, qty: toQty(r.qty), value: cents(r.value) }));
}

/** Inventory turnover for a period: cost of goods issued / average inventory (opening + closing) / 2. */
export async function turnover(organizationId: string, opts: Filter & { from: Date; to: Date }) {
  const from = asDay(opts.from), to = asDay(opts.to);
  const days = Math.round((to.getTime() - from.getTime()) / DAY) + 1;
  const { items } = await itemsAndWarehouses(organizationId, opts);
  const [open, close, used] = await Promise.all([movesUpTo(organizationId, from, opts, true), movesUpTo(organizationId, to, opts), issueMoves(organizationId, from, to, opts.warehouseId)]);
  const sum = (gs: typeof open, id: string) => gs.filter((g) => g.itemId === id).reduce((s, g) => s + cents(g._sum.value), 0n);
  const rows = items.map((i) => {
    const opening = sum(open, i.id), closing = sum(close, i.id);
    const cogs = used.filter((u) => u.itemId === i.id).reduce((s, u) => s + u.value, 0n);
    const qtyUsed = used.filter((u) => u.itemId === i.id).reduce((s, u) => s + u.qty, 0n);
    const avg = (opening + closing) / 2n;
    const turns = avg > 0n ? Number(cogs) / Number(avg) : null;
    return { itemId: i.id, code: i.code, name: i.name, category: i.category, opening, closing, average: avg, cogs, qtyUsed, turns, daysOnHand: turns && turns > 0 ? days / turns : null };
  }).filter((r) => r.opening || r.closing || r.cogs);
  const t = rows.reduce((s, r) => ({ opening: s.opening + r.opening, closing: s.closing + r.closing, cogs: s.cogs + r.cogs }), { opening: 0n, closing: 0n, cogs: 0n });
  const avg = (t.opening + t.closing) / 2n;
  const turns = avg > 0n ? Number(t.cogs) / Number(avg) : null;
  return { from, to, days, rows, totals: { ...t, average: avg, turns, daysOnHand: turns && turns > 0 ? days / turns : null } };
}

/** Stock card (item ledger): every movement with running quantity and value. */
export async function stockCard(organizationId: string, opts: { itemId: string; warehouseId?: string; from: Date; to: Date }) {
  const from = asDay(opts.from), to = asDay(opts.to);
  const where = { organizationId, itemId: opts.itemId, ...(opts.warehouseId ? { warehouseId: opts.warehouseId } : {}) };
  const [item, open, moves, whs, locs] = await Promise.all([
    prisma.product.findFirst({ where: { id: opts.itemId, organizationId } }),
    prisma.inventoryMove.aggregate({ where: { ...where, date: { lt: from } }, _sum: { qty: true, value: true } }),
    prisma.inventoryMove.findMany({ where: { ...where, date: { gte: from, lte: to } }, orderBy: [{ date: "asc" }, { seq: "asc" }] }),
    prisma.warehouse.findMany({ where: { organizationId } }),
    prisma.warehouseLocation.findMany({ where: { organizationId } }),
  ]);
  const docs = await prisma.inventoryTransaction.findMany({ where: { id: { in: [...new Set(moves.map((m) => m.transactionId))] } }, select: { id: true, number: true, type: true, memo: true, reference: true } });
  const layers = await prisma.inventoryLayer.findMany({ where: { id: { in: moves.map((m) => m.layerId).filter(Boolean) as string[] } }, select: { id: true, lotNo: true } });
  let q = toQty(open._sum.qty ?? 0), v = cents(open._sum.value);
  const openingQty = q, openingValue = v;
  const rows = moves.map((m) => {
    const mq = toQty(m.qty), mv = cents(m.value);
    q += mq; v += mv;
    const doc = docs.find((d) => d.id === m.transactionId);
    return {
      id: m.id, date: m.date, transactionId: m.transactionId, number: doc?.number ?? "", type: m.type, memo: doc?.memo ?? "", reference: doc?.reference ?? null,
      warehouseCode: whs.find((w) => w.id === m.warehouseId)?.code ?? "", location: m.locationId ? locs.find((l) => l.id === m.locationId)?.code ?? "" : "",
      lotNo: layers.find((l) => l.id === m.layerId)?.lotNo ?? null, qtyIn: mq > 0n ? mq : 0n, qtyOut: mq < 0n ? -mq : 0n, value: mv, balanceQty: q, balanceValue: v,
    };
  });
  return { item, openingQty, openingValue, rows, closingQty: q, closingValue: v };
}
