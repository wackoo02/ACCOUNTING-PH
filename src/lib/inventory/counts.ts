// Cycle counts and physical inventory counts.
// 1. Create a count sheet: the system quantity on hand per item, location (and lot, for
//    specific-identification items) is captured as of now.
// 2. Enter what was counted (blank = not counted). Items found that were not on the sheet can be added.
// 3. Submit; someone else with approval rights posts it. Variances against the stock on hand at
//    that moment become one IA- adjustment (gains at current cost, losses at the costing method),
//    charged to Inventory Losses and Count Adjustments.
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { LedgerError, assertCanApprove, asDay, audit, nextNumber } from "../ledger/service";
import { can } from "../permissions";
import { createAndPostTx, type InvLineInput } from "./service";
import { averageCost } from "./engine";
import { formatQty, fromQty, toQty, toUnitCost, valueOf } from "./qty";

type Tx = Prisma.TransactionClient;

type Group = { itemId: string; locationId: string | null; lotNo: string | null; qty: bigint };

async function onHandGroups(tx: Tx, organizationId: string, warehouseId: string, itemIds?: string[]) {
  const layers = await tx.inventoryLayer.findMany({
    where: { organizationId, warehouseId, qtyRemaining: { gt: 0 }, ...(itemIds ? { itemId: { in: itemIds } } : {}) },
    include: { item: { select: { costingMethod: true } } },
  });
  const m = new Map<string, Group>();
  for (const l of layers) {
    const lot = l.item.costingMethod === "SPECIFIC" ? l.lotNo : null;
    const k = `${l.itemId}|${l.locationId ?? ""}|${lot ?? ""}`;
    const g = m.get(k) ?? { itemId: l.itemId, locationId: l.locationId, lotNo: lot, qty: 0n };
    g.qty += toQty(l.qtyRemaining);
    m.set(k, g);
  }
  return m;
}

export async function createCount(input: {
  organizationId: string; userId: string; warehouseId: string; type: "CYCLE" | "PHYSICAL"; date: Date; memo?: string | null;
  category?: string | null; itemIds?: string[]; locationId?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, organizationId: input.organizationId } });
    if (!wh) throw new LedgerError(["Choose a warehouse"]);
    const where: Prisma.ProductWhereInput = { organizationId: input.organizationId, isStocked: true, isActive: true };
    if (input.type === "CYCLE") {
      if (input.itemIds?.length) where.id = { in: input.itemIds };
      else if (input.category) where.category = input.category;
      else if (!input.locationId) throw new LedgerError(["A cycle count needs a category, a location or a list of items"]);
    }
    const items = await tx.product.findMany({ where, orderBy: { code: "asc" } });
    const groups = [...(await onHandGroups(tx, input.organizationId, wh.id, items.map((i) => i.id))).values()]
      .filter((g) => !input.locationId || g.locationId === input.locationId);
    // A physical count also lists items normally kept here that show nothing on hand.
    if (input.type === "PHYSICAL" || input.itemIds?.length) {
      for (const i of items) {
        if (!groups.some((g) => g.itemId === i.id) && (input.itemIds?.length || i.defaultWarehouseCode === wh.code)) groups.push({ itemId: i.id, locationId: input.locationId ?? null, lotNo: null, qty: 0n });
      }
    }
    if (!groups.length) throw new LedgerError(["No items to count for that selection"]);
    const code = new Map(items.map((i) => [i.id, i.code]));
    groups.sort((a, b) => (code.get(a.itemId)! + (a.lotNo ?? "")).localeCompare(code.get(b.itemId)! + (b.lotNo ?? "")));
    const number = await nextNumber(tx, input.organizationId, "CNT", asDay(input.date).getUTCFullYear());
    const c = await tx.inventoryCount.create({
      data: {
        organizationId: input.organizationId, number, type: input.type, warehouseId: wh.id, date: asDay(input.date), memo: input.memo?.trim() || null, createdById: input.userId,
        lines: { create: groups.map((g) => ({ itemId: g.itemId, locationId: g.locationId, lotNo: g.lotNo, systemQty: new Prisma.Decimal(fromQty(g.qty)) })) },
      },
    });
    await audit(tx, input.organizationId, input.userId, "count.create", c.id, { number, lines: groups.length }, null, null, "inventory");
    return c;
  });
}

/** Save counted quantities and add lines for items found that were not on the sheet. */
export async function saveCountSheet(organizationId: string, userId: string, id: string, counts: { lineId: string; countedQty: string | null; note?: string | null }[],
  added: { itemId: string; locationId?: string | null; lotNo?: string | null; countedQty: string }[] = []) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.inventoryCount.findFirst({ where: { id, organizationId }, include: { lines: true } });
    if (!c) throw new LedgerError(["Count not found"]);
    if (c.status !== "DRAFT") throw new LedgerError(["Only a draft count sheet can be changed"]);
    const errors: string[] = [];
    for (const u of counts) {
      const l = c.lines.find((x) => x.id === u.lineId);
      if (!l) continue;
      let q: bigint | null = null;
      if (u.countedQty !== null && u.countedQty.trim() !== "") {
        try { q = toQty(u.countedQty); } catch { errors.push(`Invalid count "${u.countedQty}"`); continue; }
        if (q < 0n) { errors.push("A count cannot be negative"); continue; }
      }
      await tx.inventoryCountLine.update({ where: { id: l.id }, data: { countedQty: q === null ? null : new Prisma.Decimal(fromQty(q)), note: u.note?.trim() || null } });
    }
    for (const a of added) {
      const item = await tx.product.findFirst({ where: { id: a.itemId, organizationId, isStocked: true } });
      if (!item) { errors.push("Added line: choose an inventory item"); continue; }
      if (item.costingMethod === "SPECIFIC" && !a.lotNo?.trim()) { errors.push(`${item.code}: enter the lot / serial no.`); continue; }
      if (a.locationId && !(await tx.warehouseLocation.findFirst({ where: { id: a.locationId, warehouseId: c.warehouseId } }))) { errors.push(`${item.code}: the location is not in this warehouse`); continue; }
      let q: bigint;
      try { q = toQty(a.countedQty); } catch { errors.push(`${item.code}: invalid count`); continue; }
      if (q < 0n) { errors.push(`${item.code}: a count cannot be negative`); continue; }
      const lot = item.costingMethod === "SPECIFIC" ? a.lotNo!.trim() : null;
      if (c.lines.some((l) => l.itemId === item.id && (l.locationId ?? null) === (a.locationId || null) && (l.lotNo ?? null) === lot)) { errors.push(`${item.code} is already on the sheet for that location`); continue; }
      await tx.inventoryCountLine.create({ data: { countId: c.id, itemId: item.id, locationId: a.locationId || null, lotNo: lot, systemQty: 0, countedQty: new Prisma.Decimal(fromQty(q)) } });
    }
    if (errors.length) throw new LedgerError(errors);
    await audit(tx, organizationId, userId, "count.update", id, { number: c.number }, null, null, "inventory");
  });
}

export async function submitCount(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.inventoryCount.findFirst({ where: { id, organizationId }, include: { lines: true } });
    if (!c) throw new LedgerError(["Count not found"]);
    if (c.status !== "DRAFT") throw new LedgerError(["Only a draft count can be submitted"]);
    const blank = c.lines.filter((l) => l.countedQty === null).length;
    if (c.type === "PHYSICAL" && blank) throw new LedgerError([`${blank} line(s) have no count. A physical count must cover every line (enter 0 if none were found).`]);
    if (blank === c.lines.length) throw new LedgerError(["Enter at least one count"]);
    await tx.inventoryCount.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedById: userId, submittedAt: new Date(), rejectReason: null } });
    await audit(tx, organizationId, userId, "count.submit", id, { number: c.number }, null, null, "inventory");
  });
}

export async function rejectCount(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.inventoryCount.findFirst({ where: { id, organizationId } });
    if (!c || c.status !== "PENDING_APPROVAL") throw new LedgerError(["Only a count waiting for approval can be returned"]);
    const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
    if (!m || !can(m.role, "inventory.approve")) throw new LedgerError(["You do not have rights to approve counts"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason"]);
    await tx.inventoryCount.update({ where: { id }, data: { status: "DRAFT", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "count.reject", id, { number: c.number, reason }, null, null, "inventory");
  });
}

/** Variances of a count against what is on hand right now. */
export async function countVariances(tx: Tx, organizationId: string, id: string) {
  const c = await tx.inventoryCount.findFirst({ where: { id, organizationId }, include: { lines: { include: { item: true } } } });
  if (!c) throw new LedgerError(["Count not found"]);
  const now = await onHandGroups(tx, organizationId, c.warehouseId, [...new Set(c.lines.map((l) => l.itemId))]);
  return {
    count: c,
    lines: c.lines.map((l) => {
      const onHand = now.get(`${l.itemId}|${l.locationId ?? ""}|${l.lotNo ?? ""}`)?.qty ?? 0n;
      const counted = l.countedQty === null ? null : toQty(l.countedQty);
      return { line: l, onHand, counted, variance: counted === null ? 0n : counted - onHand, changedSinceSheet: onHand !== toQty(l.systemQty) };
    }),
  };
}

/** Approve: book all variances as one adjustment. Same approval rules as a stock adjustment. */
export async function postCount(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const { count: c, lines } = await countVariances(tx, organizationId, id);
    if (c.status === "POSTED" || c.status === "VOID") throw new LedgerError([`Count is already ${c.status.toLowerCase()}`]);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (c.status === "DRAFT" && org.requireApproval) throw new LedgerError(["Submit the count for approval first"]);
    let est = 0n;
    for (const v of lines.filter((x) => x.variance !== 0n)) {
      const avg = (await averageCost(tx, v.line.itemId, c.warehouseId)) ?? toUnitCost(v.line.item.standardCost);
      est += valueOf(v.variance < 0n ? -v.variance : v.variance, avg);
    }
    await assertCanApprove(tx, organizationId, userId, [c.createdById, c.submittedById], est);
    const adj: InvLineInput[] = lines.filter((v) => v.variance !== 0n).map((v) => ({
      itemId: v.line.itemId, qty: fromQty(v.variance), locationId: v.line.locationId, lotNo: v.line.lotNo,
      description: `Counted ${formatQty(v.counted!)} vs ${formatQty(v.onHand)} on hand`,
    }));
    let adjustmentId: string | null = null;
    if (adj.length) {
      const r = await createAndPostTx(tx, {
        organizationId, userId, type: "ADJUSTMENT", date: c.date, warehouseId: c.warehouseId, reference: c.number,
        memo: `${c.type === "PHYSICAL" ? "Physical inventory count" : "Cycle count"} ${c.number} variances`, lines: adj, sourceModule: "COUNT", sourceId: c.id, countId: c.id,
      });
      adjustmentId = r.id;
    }
    await tx.inventoryCount.update({ where: { id }, data: { status: "POSTED", postedById: userId, postedAt: new Date(), adjustmentId } });
    await audit(tx, organizationId, userId, "count.post", id, { number: c.number, adjustments: adj.length }, null, null, "inventory");
    return { adjustmentId, variances: adj.length };
  }, { timeout: 60_000 });
}

export async function voidCountDraft(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.inventoryCount.findFirst({ where: { id, organizationId } });
    if (!c) throw new LedgerError(["Count not found"]);
    if (c.status === "POSTED") throw new LedgerError(["This count is posted. Void its adjustment document instead."]);
    await tx.inventoryCount.update({ where: { id }, data: { status: "VOID" } });
    await audit(tx, organizationId, userId, "count.void", id, { number: c.number }, null, null, "inventory");
  });
}
