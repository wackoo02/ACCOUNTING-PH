// Inventory documents: receipts, issues, transfers, adjustments, customer returns and returns to vendor.
// Posting moves stock through the costing engine and posts the cost to the GL (source INVENTORY)
// through recordJournalTx, so the stock ledger and the inventory GL accounts always agree.
//
//   Receipt (RR)          Dr Inventory              Cr Goods received not invoiced (or chosen account)
//   Issue (IS)            Dr COGS / expense         Cr Inventory
//   Transfer (ST)         no GL entry (same inventory account), cost and age move with the stock
//   Adjustment (IA)       +: Dr Inventory  Cr Inventory losses and adjustments;  -: the reverse
//   Customer return (CRT) Dr Inventory              Cr COGS
//   Return to vendor (VRT) Dr GRNI / AP             Cr Inventory
//
// Adjustments (and count variances) need approval with segregation of duties; the other documents
// are posted by warehouse staff with the inventory.transact permission.
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos } from "../money";
import { PH_IFRS_TEMPLATE, normalBalanceFor } from "../coa-template";
import { DIM_KEYS, type DimKey } from "../ledger/dimensions";
import type { Dims, LineInput } from "../ledger/validate";
import { LedgerError, assertCanApprove, assertPeriodOpen, asDay, audit, nextNumber, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import { can } from "../permissions";
import { addStock, averageCost, lockStock, removeStock, reverseMoves } from "./engine";
import { cents, formatQty, fromQty, fromUnitCost, toQty, toUnitCost, valueOf } from "./qty";

type Tx = Prisma.TransactionClient;

export const INV_TYPES = ["RECEIPT", "ISSUE", "TRANSFER", "ADJUSTMENT", "RETURN_IN", "RETURN_OUT"] as const;
export type InvType = (typeof INV_TYPES)[number];
export const INV_LABELS: Record<InvType, string> = {
  RECEIPT: "Receipt", ISSUE: "Issue", TRANSFER: "Transfer", ADJUSTMENT: "Adjustment", RETURN_IN: "Customer return", RETURN_OUT: "Return to vendor",
};
const PREFIX: Record<InvType, string> = { RECEIPT: "RR", ISSUE: "IS", TRANSFER: "ST", ADJUSTMENT: "IA", RETURN_IN: "CRT", RETURN_OUT: "VRT" };
/** Does the line bring stock in? (Adjustments: by the sign of the quantity.) */
export const isInbound = (type: string, qty: bigint) => type === "RECEIPT" || type === "RETURN_IN" || (type === "ADJUSTMENT" && qty > 0n);
export const needsApproval = (type: string) => type === "ADJUSTMENT";

export type InvLineInput = {
  itemId: string; qty: string; unitCost?: string | null; locationId?: string | null; toLocationId?: string | null;
  lotNo?: string | null; accountId?: string | null; dims?: Dims; description?: string | null;
};
export type InvInput = {
  organizationId: string; userId: string; type: InvType; date: Date; warehouseId: string; toWarehouseId?: string | null;
  partyType?: string | null; partyId?: string | null; reference?: string | null; memo: string; offsetAccountId?: string | null;
  lines: InvLineInput[]; action?: "draft" | "submit" | "post";
  sourceModule?: string | null; sourceId?: string | null; countId?: string | null;
};

const dec = (c: bigint) => new Prisma.Decimal(fromCentavos(c));
const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const cleanDims = (d?: Dims) => {
  const o = Object.fromEntries(DIM_KEYS.map((k) => [k, d?.[k] || null]).filter(([, v]) => v)) as Dims;
  return Object.keys(o).length ? o : null;
};

// ---------- GL accounts ----------

/** The account with a system role; creates it from the PH template if an older company lacks it. */
export async function ensureRoleAccount(tx: Tx, organizationId: string, role: string) {
  const found = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: role } } });
  if (found) return found;
  const t = PH_IFRS_TEMPLATE.find((a) => a.systemRole === role);
  if (!t) throw new LedgerError([`No account is assigned the role ${role}`]);
  const byCode = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: t.code } } });
  if (byCode) {
    if (byCode.systemRole) throw new LedgerError([`Assign an account to the role ${role} in the chart of accounts first`]);
    return tx.account.update({ where: { id: byCode.id }, data: { systemRole: role } });
  }
  const parent = t.parent ? await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: t.parent } } }) : null;
  return tx.account.create({
    data: { organizationId, code: t.code, name: t.name, type: t.type, ifrsGroup: t.ifrsGroup, isCurrent: t.isCurrent ?? null, normalBalance: normalBalanceFor(t), systemRole: role, parentId: parent?.id ?? null },
  });
}

type ItemRow = Prisma.ProductGetPayload<object>;

function accountResolver(tx: Tx, organizationId: string) {
  const byCode = new Map<string, string>();
  const byRole = new Map<string, string>();
  const code = async (c: string, what: string) => {
    if (!byCode.has(c)) {
      const a = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: c } } });
      if (!a) throw new LedgerError([`${what}: account ${c} is not in the chart of accounts`]);
      byCode.set(c, a.id);
    }
    return byCode.get(c)!;
  };
  const role = async (r: string) => {
    if (!byRole.has(r)) byRole.set(r, (await ensureRoleAccount(tx, organizationId, r)).id);
    return byRole.get(r)!;
  };
  return {
    inventory: (i: ItemRow) => (i.inventoryAccountCode ? code(i.inventoryAccountCode, `${i.code} inventory account`) : role("INVENTORY")),
    cogs: (i: ItemRow) => {
      const c = i.cogsAccountCode || i.expenseAccountCode;
      return c ? code(c, `${i.code} COGS account`) : role("COGS");
    },
    role,
  };
}

// ---------- validation ----------

async function prepare(tx: Tx, input: InvInput) {
  const errors: string[] = [];
  const org = input.organizationId;
  if (!INV_TYPES.includes(input.type)) throw new LedgerError(["Unknown inventory document type"]);
  if (!input.memo?.trim()) errors.push("Enter the particulars / purpose");
  const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, organizationId: org } });
  if (!wh) throw new LedgerError(["Choose a warehouse"]);
  if (!wh.isActive) errors.push(`${wh.name} is inactive`);
  let toWh = null;
  if (input.type === "TRANSFER") {
    toWh = input.toWarehouseId ? await tx.warehouse.findFirst({ where: { id: input.toWarehouseId, organizationId: org } }) : null;
    if (!toWh) errors.push("Choose the warehouse to transfer to");
    else if (!toWh.isActive) errors.push(`${toWh.name} is inactive`);
  }
  if (input.offsetAccountId) {
    const a = await tx.account.findFirst({ where: { id: input.offsetAccountId, organizationId: org } });
    if (!a || !a.isPostable || !a.isActive) errors.push("The offset account must be an active, postable account of this company");
  }
  if (!input.lines.length) errors.push("Add at least one item");

  const items = await tx.product.findMany({ where: { organizationId: org, id: { in: input.lines.map((l) => l.itemId) } } });
  const locIds = [...new Set(input.lines.flatMap((l) => [l.locationId, l.toLocationId]).filter(Boolean) as string[])];
  const locs = await tx.warehouseLocation.findMany({ where: { organizationId: org, id: { in: locIds } } });
  const defaultLocs = await tx.warehouseLocation.findMany({ where: { warehouseId: { in: [wh.id, toWh?.id].filter(Boolean) as string[] }, isActive: true } });

  const lines = input.lines.map((l, i) => {
    const n = i + 1;
    const item = items.find((x) => x.id === l.itemId);
    if (!item) { errors.push(`Line ${n}: choose an item`); return null; }
    if (!item.isStocked) errors.push(`Line ${n}: ${item.code} is not an inventory item (turn on Track Inventory in Products)`);
    if (!item.isActive) errors.push(`Line ${n}: ${item.code} is inactive`);
    let qty = 0n;
    try { qty = toQty(l.qty); } catch { errors.push(`Line ${n}: enter a valid quantity`); }
    if (input.type === "ADJUSTMENT" ? qty === 0n : qty <= 0n) errors.push(`Line ${n}: ${input.type === "ADJUSTMENT" ? "enter a quantity to add (+) or remove (-)" : "quantity must be more than zero"}`);
    let unitCost: bigint | null = null;
    if (clean(l.unitCost)) {
      try { unitCost = toUnitCost(l.unitCost); } catch { errors.push(`Line ${n}: enter a valid unit cost`); }
      if (unitCost !== null && unitCost < 0n) errors.push(`Line ${n}: unit cost cannot be negative`);
    }
    const inbound = isInbound(input.type, qty);
    // Receipts default to the standard (or last purchase) cost; returns and gains to the current cost at posting.
    if (inbound && unitCost === null && input.type === "RECEIPT") unitCost = toUnitCost(item.standardCost.toString()) || toUnitCost(item.purchaseCost.toString());
    const defLoc = (whId: string) => (item.defaultLocationCode ? defaultLocs.find((x) => x.warehouseId === whId && x.code === item.defaultLocationCode)?.id ?? null : null);
    let locationId = l.locationId || null;
    if (locationId && !locs.some((x) => x.id === locationId && x.warehouseId === wh.id)) errors.push(`Line ${n}: the location is not in ${wh.code}`);
    if (!locationId && inbound) locationId = defLoc(wh.id);
    let toLocationId = l.toLocationId || null;
    if (input.type === "TRANSFER" && toWh) {
      if (toLocationId && !locs.some((x) => x.id === toLocationId && x.warehouseId === toWh!.id)) errors.push(`Line ${n}: the destination location is not in ${toWh.code}`);
      if (!toLocationId) toLocationId = defLoc(toWh.id);
      if (toWh.id === wh.id && (toLocationId ?? null) === (locationId ?? null)) errors.push(`Line ${n}: a transfer within ${wh.code} needs a different destination location`);
    } else toLocationId = null;
    const lotNo = clean(l.lotNo);
    if (item.costingMethod === "SPECIFIC" && !lotNo) errors.push(`Line ${n}: ${item.code} uses specific identification; enter the lot / serial no.`);
    return {
      lineNo: n, itemId: item.id, qty: new Prisma.Decimal(fromQty(qty)), unitCost: unitCost === null ? null : new Prisma.Decimal(fromUnitCost(unitCost)),
      locationId, toLocationId, lotNo, accountId: l.accountId || null, dims: (cleanDims(l.dims) ?? undefined) as Prisma.InputJsonValue | undefined,
      description: clean(l.description),
    };
  });
  const acctIds = [...new Set(input.lines.map((l) => l.accountId).filter(Boolean) as string[])];
  if (acctIds.length) {
    const n = await tx.account.count({ where: { organizationId: org, id: { in: acctIds }, isPostable: true, isActive: true } });
    if (n !== acctIds.length) errors.push("A line account is inactive, a header account, or not in this company");
  }
  if (errors.length) throw new LedgerError(errors);
  return {
    header: {
      type: input.type, date: asDay(input.date), warehouseId: wh.id, toWarehouseId: input.type === "TRANSFER" ? toWh!.id : null,
      partyType: clean(input.partyType), partyId: clean(input.partyId), reference: clean(input.reference), memo: input.memo.trim(),
      offsetAccountId: input.offsetAccountId || null,
    },
    lines: lines.filter(Boolean) as NonNullable<(typeof lines)[number]>[],
  };
}

// ---------- posting ----------

type Doc = Prisma.InventoryTransactionGetPayload<{ include: { lines: { include: { item: true } } } }>;

async function loadDoc(tx: Tx, organizationId: string, id: string) {
  const t = await tx.inventoryTransaction.findFirst({ where: { id, organizationId }, include: { lines: { orderBy: { lineNo: "asc" }, include: { item: true } } } });
  if (!t) throw new LedgerError(["Inventory document not found"]);
  return t;
}

/** Cost of stock coming in without a unit cost: current average, then last cost, then standard cost. */
async function currentCost(tx: Tx, item: ItemRow, warehouseId: string) {
  const avg = await averageCost(tx, item.id, warehouseId);
  if (avg !== null) return avg;
  const last = await tx.inventoryLayer.findFirst({ where: { itemId: item.id }, orderBy: [{ receivedDate: "desc" }, { createdAt: "desc" }] });
  if (last) return toUnitCost(last.unitCost);
  return toUnitCost(item.standardCost) || toUnitCost(item.purchaseCost);
}

async function postDoc(tx: Tx, t: Doc, userId: string) {
  if (t.status === "POSTED" || t.status === "VOID") throw new LedgerError([`${t.number} is already ${t.status.toLowerCase()}`]);
  const org = t.organizationId;
  await assertPeriodOpen(tx, org, t.date);
  const pairs = [...new Set(t.lines.flatMap((l) => [`${l.itemId}|${t.warehouseId}`, t.toWarehouseId ? `${l.itemId}|${t.toWarehouseId}` : ""]).filter(Boolean))].sort();
  for (const p of pairs) { const [i, w] = p.split("|"); await lockStock(tx, i, w); }

  const acct = accountResolver(tx, org);
  const whs = await tx.warehouse.findMany({ where: { id: { in: [t.warehouseId, t.toWarehouseId].filter(Boolean) as string[] } } });
  const wh = whs.find((w) => w.id === t.warehouseId)!;
  const branch = wh.branchCode ? await tx.dimensionValue.findUnique({ where: { organizationId_type_code: { organizationId: org, type: "BRANCH", code: wh.branchCode } } }) : null;

  type Key = string;
  const gl = new Map<Key, { accountId: string; side: "debit" | "credit"; amount: bigint; dims: Dims; items: string[] }>();
  const add = (accountId: string, side: "debit" | "credit", amount: bigint, dims: Dims, label: string) => {
    if (amount === 0n) return;
    const k = `${accountId}|${side}|${JSON.stringify(dims)}`;
    const g = gl.get(k) ?? { accountId, side, amount: 0n, dims, items: [] };
    g.amount += amount; g.items.push(label); gl.set(k, g);
  };

  let total = 0n;
  for (const l of t.lines) {
    const item = l.item;
    const qty = toQty(l.qty);
    const ref = { organizationId: org, transactionId: t.id, lineId: l.id, date: t.date, type: t.type };
    let value: bigint;
    if (t.type === "TRANSFER") {
      const out = await removeStock(tx, ref, { item, warehouseId: t.warehouseId, locationId: l.locationId, lotNo: l.lotNo, qty });
      for (const c of out.consumed) {
        await addStock(tx, ref, { item, warehouseId: t.toWarehouseId!, locationId: l.toLocationId, lotNo: c.lotNo, qty: c.qty, value: c.value, receivedDate: c.receivedDate });
      }
      value = out.value;
    } else if (isInbound(t.type, qty)) {
      const q = qty < 0n ? -qty : qty;
      const uc = l.unitCost !== null ? toUnitCost(l.unitCost) : await currentCost(tx, item, t.warehouseId);
      value = valueOf(q, uc);
      await addStock(tx, ref, { item, warehouseId: t.warehouseId, locationId: l.locationId, lotNo: l.lotNo, qty: q, value });
      if (l.unitCost === null) await tx.inventoryTransactionLine.update({ where: { id: l.id }, data: { unitCost: new Prisma.Decimal(fromUnitCost(uc)) } });
    } else {
      value = (await removeStock(tx, ref, { item, warehouseId: t.warehouseId, locationId: l.locationId, lotNo: l.lotNo, qty: qty < 0n ? -qty : qty })).value;
    }
    await tx.inventoryTransactionLine.update({ where: { id: l.id }, data: { value: dec(value) } });
    total += value;
    if (t.type === "TRANSFER") continue;

    const dims: Dims = { ...((l.dims as Dims | null) ?? {}) };
    if (branch && !dims.branchId) dims.branchId = branch.id;
    const inv = await acct.inventory(item);
    let off = l.accountId ?? t.offsetAccountId;
    if (!off) {
      if (t.type === "RECEIPT" || t.type === "RETURN_OUT") off = await acct.role("GRNI");
      else if (t.type === "ISSUE" || t.type === "RETURN_IN") off = await acct.cogs(item);
      else off = await acct.role("INVENTORY_ADJUSTMENT");
    }
    const label = `${item.code} x ${formatQty(qty < 0n ? -qty : qty)}`;
    if (isInbound(t.type, qty)) { add(inv, "debit", value, dims, label); add(off, "credit", value, dims, label); }
    else { add(off, "debit", value, dims, label); add(inv, "credit", value, dims, label); }
  }

  let journalEntryId: string | null = null;
  const lines: LineInput[] = [...gl.values()].map((g) => ({
    accountId: g.accountId, [g.side]: fromCentavos(g.amount), dims: g.dims, partyType: t.partyType, partyId: t.partyId,
    description: g.items.length <= 3 ? g.items.join(", ") : `${g.items.slice(0, 3).join(", ")} and ${g.items.length - 3} more`,
  }));
  if (lines.length) {
    const e = await recordJournalTx(tx, {
      organizationId: org, userId, date: t.date, memo: `${t.number}: ${t.memo}`, reference: t.reference || t.number,
      lines, source: "INVENTORY", sourceId: t.id, action: "post",
    });
    journalEntryId = e.id;
  }
  const now = new Date();
  const r = await tx.inventoryTransaction.updateMany({
    where: { id: t.id, status: t.status },
    data: { status: "POSTED", totalValue: dec(total), journalEntryId, postedById: userId, postedAt: now, submittedById: t.submittedById ?? userId, submittedAt: t.submittedAt ?? now, rejectReason: null },
  });
  if (r.count !== 1) throw new LedgerError(["This document was changed by someone else; refresh and try again"]);
  await audit(tx, org, userId, "inventory.post", t.id, { number: t.number, total: fromCentavos(total) }, null, null, "inventory");
  return { id: t.id, number: t.number, total, journalEntryId };
}

// ---------- public API ----------

/** Create a document and post it straight away, skipping approval. For other modules (see hooks.ts) and counts. */
export async function createAndPostTx(tx: Tx, input: InvInput) {
  const p = await prepare(tx, input);
  const number = await nextNumber(tx, input.organizationId, PREFIX[input.type], p.header.date.getUTCFullYear());
  const t = await tx.inventoryTransaction.create({
    data: {
      ...p.header, organizationId: input.organizationId, number, createdById: input.userId,
      sourceModule: input.sourceModule ?? null, sourceId: input.sourceId ?? null, countId: input.countId ?? null,
      lines: { create: p.lines },
    },
  });
  await audit(tx, input.organizationId, input.userId, "inventory.create", t.id, { number, source: input.sourceModule ?? null }, null, null, "inventory");
  const posted = await postDoc(tx, await loadDoc(tx, input.organizationId, t.id), input.userId);
  const lines = await tx.inventoryTransactionLine.findMany({ where: { transactionId: t.id }, orderBy: { lineNo: "asc" } });
  return { ...posted, lines: lines.map((l) => ({ lineNo: l.lineNo, itemId: l.itemId, qty: l.qty.toString(), value: cents(l.value) })) };
}

/** Save (create or update a draft), then optionally submit or post. */
export async function saveInventoryTransaction(input: InvInput, id?: string) {
  return prisma.$transaction(async (tx) => {
    const p = await prepare(tx, input);
    const action = input.action ?? "draft";
    let tid: string;
    if (id) {
      const cur = await tx.inventoryTransaction.findFirst({ where: { id, organizationId: input.organizationId } });
      if (!cur) throw new LedgerError(["Inventory document not found"]);
      if (cur.status !== "DRAFT") throw new LedgerError(["Only drafts can be edited. Void a posted document and record a new one."]);
      if (cur.sourceModule) throw new LedgerError(["This document was created by another module and cannot be edited here"]);
      if (cur.type !== input.type) throw new LedgerError(["The document type cannot change"]);
      await tx.inventoryTransactionLine.deleteMany({ where: { transactionId: id } });
      await tx.inventoryTransaction.update({ where: { id }, data: { ...p.header, updatedById: input.userId, lines: { create: p.lines } } });
      await audit(tx, input.organizationId, input.userId, "inventory.update", id, { number: cur.number }, null, null, "inventory");
      tid = id;
    } else {
      const number = await nextNumber(tx, input.organizationId, PREFIX[input.type], p.header.date.getUTCFullYear());
      const t = await tx.inventoryTransaction.create({ data: { ...p.header, organizationId: input.organizationId, number, createdById: input.userId, lines: { create: p.lines } } });
      await audit(tx, input.organizationId, input.userId, "inventory.create", t.id, { number }, null, null, "inventory");
      tid = t.id;
    }
    if (action === "submit") await submitTx(tx, input.organizationId, input.userId, tid);
    if (action === "post") {
      const t = await loadDoc(tx, input.organizationId, tid);
      if (needsApproval(t.type)) {
        const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
        if (org.requireApproval) throw new LedgerError(["Stock adjustments need approval: submit it for approval instead"]);
        await assertCanApprove(tx, input.organizationId, input.userId, org.segregationOfDuties ? [input.userId] : [], await estimate(tx, t));
      }
      await postDoc(tx, t, input.userId);
    }
    return tx.inventoryTransaction.findUniqueOrThrow({ where: { id: tid } });
  }, { timeout: 60_000 });
}

/** Rough peso value of a draft, for approval limits (actual cost is known only when posted). */
async function estimate(tx: Tx, t: Doc) {
  let s = 0n;
  for (const l of t.lines) {
    const q = toQty(l.qty);
    const uc = l.unitCost !== null ? toUnitCost(l.unitCost) : await currentCost(tx, l.item, t.warehouseId);
    s += valueOf(q < 0n ? -q : q, uc);
  }
  return s;
}

async function submitTx(tx: Tx, organizationId: string, userId: string, id: string) {
  const t = await loadDoc(tx, organizationId, id);
  if (t.status !== "DRAFT") throw new LedgerError(["Only drafts can be submitted"]);
  await tx.inventoryTransaction.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedById: userId, submittedAt: new Date(), rejectReason: null } });
  await audit(tx, organizationId, userId, "inventory.submit", id, { number: t.number }, null, null, "inventory");
}

export async function submitInventory(organizationId: string, userId: string, id: string) {
  return prisma.$transaction((tx) => submitTx(tx, organizationId, userId, id));
}

/** Post a draft or approve a submitted adjustment. */
export async function approveInventory(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const t = await loadDoc(tx, organizationId, id);
    if (t.sourceModule && t.status !== "DRAFT") throw new LedgerError(["This document belongs to another module"]);
    if (needsApproval(t.type)) {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
      if (t.status === "DRAFT" && org.requireApproval) throw new LedgerError(["Submit the adjustment for approval first"]);
      await assertCanApprove(tx, organizationId, userId, [t.createdById, t.submittedById, t.updatedById], await estimate(tx, t));
    }
    return postDoc(tx, t, userId);
  }, { timeout: 60_000 });
}

export async function rejectInventory(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const t = await loadDoc(tx, organizationId, id);
    if (t.status !== "PENDING_APPROVAL") throw new LedgerError(["Only documents waiting for approval can be returned"]);
    const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
    if (!m || !can(m.role, "inventory.approve")) throw new LedgerError(["You do not have rights to approve or return stock adjustments"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason so the preparer knows what to fix"]);
    await tx.inventoryTransaction.update({ where: { id }, data: { status: "DRAFT", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "inventory.reject", id, { number: t.number, reason: reason.trim() }, null, null, "inventory");
  });
}

/** Void. A posted document puts the stock back (or takes it out again) and reverses its GL entry. */
export async function voidInventoryTx(tx: Tx, organizationId: string, userId: string, id: string, reason: string, reversalDate?: Date, fromSource = false) {
  const t = await loadDoc(tx, organizationId, id);
  if (t.status === "VOID") throw new LedgerError([`${t.number} is already void`]);
  if (!reason.trim()) throw new LedgerError(["Give a reason for voiding"]);
  if (t.sourceModule && t.sourceModule !== "COUNT" && !fromSource) throw new LedgerError([`${t.number} was created by ${t.sourceModule === "SALES" ? "Sales" : t.sourceModule === "PURCHASES" ? "Purchasing" : t.sourceModule}. Void the source document there instead.`]);
  let voidJournalId: string | null = null;
  if (t.status === "POSTED") {
    const date = asDay(reversalDate ?? t.date);
    if (date < t.date) throw new LedgerError(["The void date cannot be before the document date"]);
    await assertPeriodOpen(tx, organizationId, date);
    await reverseMoves(tx, organizationId, t.id, date, t.number);
    if (t.journalEntryId) voidJournalId = (await voidOrReverseTx(tx, organizationId, userId, t.journalEntryId, date, true))?.id ?? null;
  }
  await tx.inventoryTransaction.update({ where: { id }, data: { status: "VOID", voidedById: userId, voidedAt: new Date(), voidReason: reason.trim(), voidJournalId } });
  if (t.countId) await tx.inventoryCount.update({ where: { id: t.countId }, data: { status: "VOID" } });
  await audit(tx, organizationId, userId, "inventory.void", id, { number: t.number, reason: reason.trim() }, null, null, "inventory");
}

export async function voidInventory(organizationId: string, userId: string, id: string, reason: string, reversalDate?: Date) {
  return prisma.$transaction((tx) => voidInventoryTx(tx, organizationId, userId, id, reason, reversalDate), { timeout: 60_000 });
}

/** Lots / serials on hand for an item in a warehouse (for specific identification pickers). */
export async function lotsOnHand(organizationId: string, itemId: string, warehouseId: string) {
  const layers = await prisma.inventoryLayer.findMany({ where: { organizationId, itemId, warehouseId, qtyRemaining: { gt: 0 } }, orderBy: { receivedDate: "asc" } });
  return layers.map((l) => ({ lotNo: l.lotNo, locationId: l.locationId, qty: l.qtyRemaining.toString(), unitCost: l.unitCost.toString(), receivedDate: l.receivedDate }));
}

export type { DimKey };
