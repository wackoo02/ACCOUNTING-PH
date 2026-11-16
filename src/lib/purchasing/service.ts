// Purchasing / materials management: purchase request -> RFQ (canvass) -> purchase order -> receiving report.
// PRs and POs go through the approval matrix. Receiving posts Dr expense/inventory/asset, Cr GRNI,
// which the supplier bill clears (3-way match: PO, receiving report, invoice).
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { LedgerError, asDay, audit, nextNumber, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import { approveLevel, recordReturn, recordSubmission } from "../approvals";
import { calcLine, fromQ4, netUnitCost, q4, roundDiv, totals, type LineOut } from "../ap/compute";
import { type Tx, cents, checkCategory, cleanDims, dec, decQ4, grniAccount, q4of } from "../ap/common";
import type { LineInput } from "../ledger/validate";
import { fromCentavos } from "../money";

const snap = (x: unknown) => JSON.parse(JSON.stringify(x)) as Prisma.InputJsonValue;

// ---------- Purchase requests ----------

export type PrLineInput = { productId?: string | null; description: string; quantity: string; unit?: string | null; estUnitCost?: string | null; category?: string | null; accountId?: string | null };
export type PrInput = {
  organizationId: string; userId: string; date: Date; neededBy?: Date | null; purpose: string;
  departmentId?: string | null; costCenterId?: string | null; projectId?: string | null; branchId?: string | null;
  lines: PrLineInput[]; action?: "draft" | "submit";
};

export async function savePurchaseRequest(input: PrInput, id?: string) {
  return prisma.$transaction(async (tx) => {
    const errors: string[] = [];
    if (!input.purpose?.trim()) errors.push("Enter the purpose of the request");
    const lines = input.lines.filter((l) => l.description?.trim() || l.quantity?.trim());
    if (!lines.length) errors.push("Add at least one item");
    let est = 0n;
    const data = lines.map((l, i) => {
      let qty = 0n, cost = 0n;
      try { qty = q4(l.quantity); if (qty <= 0n) errors.push(`Item ${i + 1}: enter a quantity`); } catch (e) { errors.push(`Item ${i + 1}: ${(e as Error).message}`); }
      try { cost = q4(l.estUnitCost || "0", "Estimated cost"); } catch (e) { errors.push(`Item ${i + 1}: ${(e as Error).message}`); }
      if (!l.description?.trim()) errors.push(`Item ${i + 1}: describe the item`);
      est += roundDiv(qty * cost, 1000000n);
      return { lineNo: i + 1, productId: l.productId || null, description: l.description?.trim() ?? "", quantity: decQ4(qty), unit: l.unit?.trim() || null, estUnitCost: new Prisma.Decimal(fromQ4(cost)).toDecimalPlaces(2), category: l.category || "EXPENSE", accountId: l.accountId || null };
    });
    if (errors.length) throw new LedgerError(errors);
    const head = {
      date: asDay(input.date), neededBy: input.neededBy ? asDay(input.neededBy) : null, purpose: input.purpose.trim(),
      departmentId: input.departmentId || null, costCenterId: input.costCenterId || null, projectId: input.projectId || null, branchId: input.branchId || null, estimatedTotal: dec(est),
    };
    let pr;
    if (id) {
      const cur = await tx.purchaseRequest.findFirst({ where: { id, organizationId: input.organizationId } });
      if (!cur) throw new LedgerError(["Purchase request not found"]);
      if (cur.status !== "DRAFT") throw new LedgerError(["Only drafts can be edited"]);
      await tx.purchaseRequestLine.deleteMany({ where: { requestId: id } });
      pr = await tx.purchaseRequest.update({ where: { id }, data: { ...head, lines: { create: data } } });
      await audit(tx, input.organizationId, input.userId, "pr.update", id, { number: pr.number }, snap(cur), null, "purchase_request");
    } else {
      const number = await nextNumber(tx, input.organizationId, "PR", head.date.getUTCFullYear());
      pr = await tx.purchaseRequest.create({ data: { ...head, organizationId: input.organizationId, number, requestedById: input.userId, lines: { create: data } } });
      await audit(tx, input.organizationId, input.userId, "pr.create", pr.id, { number }, null, null, "purchase_request");
    }
    if (input.action === "submit") await submitPrTx(tx, input.organizationId, input.userId, pr.id);
    return tx.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
  });
}

async function loadPr(tx: Tx, organizationId: string, id: string) {
  const pr = await tx.purchaseRequest.findFirst({ where: { id, organizationId }, include: { lines: true } });
  if (!pr) throw new LedgerError(["Purchase request not found"]);
  return pr;
}

async function submitPrTx(tx: Tx, organizationId: string, userId: string, id: string) {
  const pr = await loadPr(tx, organizationId, id);
  if (pr.status !== "DRAFT") throw new LedgerError(["Only drafts can be submitted"]);
  await tx.purchaseRequest.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedAt: new Date(), rejectReason: null } });
  await recordSubmission(tx, organizationId, "PR", id, userId);
  await audit(tx, organizationId, userId, "pr.submit", id, { number: pr.number }, null, null, "purchase_request");
}
export const submitPurchaseRequest = (organizationId: string, userId: string, id: string) => prisma.$transaction((tx) => submitPrTx(tx, organizationId, userId, id));

export async function approvePurchaseRequest(organizationId: string, userId: string, id: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    const pr = await loadPr(tx, organizationId, id);
    if (pr.status !== "PENDING_APPROVAL") throw new LedgerError(["This request is not waiting for approval"]);
    const done = await approveLevel(tx, { organizationId, docType: "PR", docId: id, userId, total: cents(pr.estimatedTotal), preparerIds: [pr.requestedById], comment });
    if (done) await tx.purchaseRequest.update({ where: { id }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() } });
    await audit(tx, organizationId, userId, done ? "pr.approve" : "pr.approve_level", id, { number: pr.number }, null, null, "purchase_request");
    return done;
  });
}

export async function returnPurchaseRequest(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const pr = await loadPr(tx, organizationId, id);
    if (pr.status !== "PENDING_APPROVAL") throw new LedgerError(["Only requests waiting for approval can be returned"]);
    await recordReturn(tx, organizationId, "PR", id, userId, reason, cents(pr.estimatedTotal));
    await tx.purchaseRequest.update({ where: { id }, data: { status: "DRAFT", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "pr.return", id, { number: pr.number, reason }, null, null, "purchase_request");
  });
}

export async function cancelPurchaseRequest(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const pr = await loadPr(tx, organizationId, id);
    if (["ORDERED", "CLOSED", "CANCELLED"].includes(pr.status)) throw new LedgerError([`This request is already ${pr.status.toLowerCase()}`]);
    if (!reason.trim()) throw new LedgerError(["Give a reason"]);
    await tx.purchaseRequest.update({ where: { id }, data: { status: "CANCELLED", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "pr.cancel", id, { number: pr.number, reason }, null, null, "purchase_request");
  });
}

// ---------- RFQ / canvass ----------

type RfqLine = { lineNo: number; description: string; quantity: string; unit: string | null; productId: string | null; category: string; accountId: string | null };

export async function createRfq(organizationId: string, userId: string, input: { requestId: string; date: Date; dueDate?: Date | null; notes?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const pr = await loadPr(tx, organizationId, input.requestId);
    if (pr.status !== "APPROVED") throw new LedgerError(["Only an approved purchase request can go out for quotation"]);
    const lines: RfqLine[] = pr.lines.sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), unit: l.unit, productId: l.productId, category: l.category, accountId: l.accountId }));
    const date = asDay(input.date);
    const number = await nextNumber(tx, organizationId, "RFQ", date.getUTCFullYear());
    const r = await tx.rfq.create({ data: { organizationId, number, requestId: pr.id, date, dueDate: input.dueDate ? asDay(input.dueDate) : null, notes: input.notes?.trim() || null, lines, createdById: userId } });
    await audit(tx, organizationId, userId, "rfq.create", r.id, { number, pr: pr.number }, null, null, "rfq");
    return r;
  });
}

export async function saveQuote(organizationId: string, userId: string, rfqId: string, input: { vendorId: string; quoteRef?: string | null; quoteDate?: Date | null; validUntil?: Date | null; leadTimeDays?: number | null; paymentTermsDays?: number | null; vatInclusive: boolean; prices: { lineNo: number; unitPrice: string }[]; remarks?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const rfq = await tx.rfq.findFirst({ where: { id: rfqId, organizationId } });
    if (!rfq) throw new LedgerError(["RFQ not found"]);
    if (rfq.status !== "OPEN") throw new LedgerError(["This RFQ is already awarded or cancelled"]);
    const vendor = await tx.vendor.findFirst({ where: { id: input.vendorId, organizationId } });
    if (!vendor) throw new LedgerError(["Choose a supplier"]);
    const lines = rfq.lines as RfqLine[];
    const errors: string[] = [];
    const outs: LineOut[] = [];
    const prices = input.prices.filter((p) => String(p.unitPrice ?? "").trim());
    for (const p of prices) {
      const l = lines.find((x) => x.lineNo === p.lineNo);
      if (!l) continue;
      try { outs.push(calcLine({ quantity: l.quantity, unitPrice: p.unitPrice }, { vatInclusive: input.vatInclusive, vendorVatRegistered: vendor.vatRegistered })); }
      catch (e) { errors.push(`Item ${p.lineNo}: ${(e as Error).message}`); }
    }
    if (!prices.length) errors.push("Enter the supplier's price for at least one item");
    if (errors.length) throw new LedgerError(errors);
    const t = totals(outs);
    const data = {
      quoteRef: input.quoteRef?.trim() || null, quoteDate: input.quoteDate ? asDay(input.quoteDate) : null, validUntil: input.validUntil ? asDay(input.validUntil) : null,
      leadTimeDays: input.leadTimeDays ?? null, paymentTermsDays: input.paymentTermsDays ?? vendor.paymentTermsDays, vatInclusive: input.vatInclusive,
      prices: prices.map((p) => ({ lineNo: p.lineNo, unitPrice: p.unitPrice.replace(/,/g, "").trim() })), total: dec(t.total), remarks: input.remarks?.trim() || null,
    };
    const q = await tx.rfqQuote.upsert({ where: { rfqId_vendorId: { rfqId, vendorId: vendor.id } }, create: { rfqId, vendorId: vendor.id, ...data }, update: data });
    await audit(tx, organizationId, userId, "rfq.quote", rfqId, { number: rfq.number, vendor: vendor.code, total: t.total.toString() }, null, null, "rfq");
    return q;
  });
}

export async function deleteQuote(organizationId: string, rfqId: string, quoteId: string) {
  const rfq = await prisma.rfq.findFirst({ where: { id: rfqId, organizationId } });
  if (!rfq || rfq.status !== "OPEN") throw new LedgerError(["This RFQ can no longer be changed"]);
  await prisma.rfqQuote.deleteMany({ where: { id: quoteId, rfqId } });
}

/** Award the canvass to one supplier: creates a draft PO with the quoted prices. */
export async function awardRfq(organizationId: string, userId: string, rfqId: string, quoteId: string, reason?: string | null) {
  return prisma.$transaction(async (tx) => {
    const rfq = await tx.rfq.findFirst({ where: { id: rfqId, organizationId }, include: { quotes: true } });
    if (!rfq) throw new LedgerError(["RFQ not found"]);
    if (rfq.status !== "OPEN") throw new LedgerError(["This RFQ is already awarded or cancelled"]);
    const q = rfq.quotes.find((x) => x.id === quoteId);
    if (!q) throw new LedgerError(["Quote not found"]);
    const lowest = rfq.quotes.reduce((m, x) => (cents(x.total) < cents(m.total) ? x : m), q);
    if (lowest.id !== q.id && !reason?.trim()) throw new LedgerError(["This is not the lowest quote. Give the reason for choosing it (e.g. quality, delivery time, terms)."]);
    const prices = q.prices as { lineNo: number; unitPrice: string }[];
    const lines = (rfq.lines as RfqLine[]).filter((l) => prices.some((p) => p.lineNo === l.lineNo));
    const pr = rfq.requestId ? await tx.purchaseRequest.findUnique({ where: { id: rfq.requestId } }) : null;
    const dims = pr ? cleanDims({ departmentId: pr.departmentId, costCenterId: pr.costCenterId, projectId: pr.projectId, branchId: pr.branchId }) : {};
    const missing = lines.filter((l) => !l.accountId);
    const fallback = missing.length ? await tx.account.findFirst({ where: { organizationId, type: "EXPENSE", isPostable: true, isActive: true }, orderBy: { code: "asc" } }) : null;
    const po = await savePoTx(tx, {
      organizationId, userId, vendorId: q.vendorId, poDate: new Date(), description: pr?.purpose ?? `Award of ${rfq.number}`, requestId: rfq.requestId, rfqId: rfq.id,
      paymentTermsDays: q.paymentTermsDays, vatInclusive: q.vatInclusive, deliveryDate: pr?.neededBy ?? null,
      lines: lines.map((l) => ({ productId: l.productId, description: l.description, quantity: l.quantity, unit: l.unit, unitPrice: prices.find((p) => p.lineNo === l.lineNo)!.unitPrice, category: l.category, accountId: l.accountId ?? fallback?.id ?? "", vatType: "VATABLE", dims })),
    });
    await tx.rfq.update({ where: { id: rfqId }, data: { status: "AWARDED", awardedQuoteId: q.id, awardReason: reason?.trim() || null, purchaseOrderId: po.id } });
    if (rfq.requestId) await tx.purchaseRequest.update({ where: { id: rfq.requestId }, data: { status: "ORDERED" } });
    await audit(tx, organizationId, userId, "rfq.award", rfqId, { number: rfq.number, po: po.number, reason: reason ?? null }, null, null, "rfq");
    return po;
  });
}

export async function cancelRfq(organizationId: string, userId: string, rfqId: string) {
  const r = await prisma.rfq.updateMany({ where: { id: rfqId, organizationId, status: "OPEN" }, data: { status: "CANCELLED" } });
  if (!r.count) throw new LedgerError(["Only open RFQs can be cancelled"]);
  await prisma.$transaction((tx) => audit(tx, organizationId, userId, "rfq.cancel", rfqId, null, null, null, "rfq"));
}

// ---------- Purchase orders ----------

export type PoLineInput = { productId?: string | null; description: string; quantity: string; unit?: string | null; unitPrice: string; vatType?: string | null; category?: string | null; accountId: string; dims?: Record<string, string | null> };
export type PoInput = {
  organizationId: string; userId: string; vendorId: string; poDate: Date; description: string; requestId?: string | null; rfqId?: string | null;
  deliveryDate?: Date | null; deliverTo?: string | null; paymentTermsDays?: number | null; currencyCode?: string | null; fxRate?: string | null;
  vatInclusive: boolean; notes?: string | null; lines: PoLineInput[]; action?: "draft" | "submit";
};

async function savePoTx(tx: Tx, input: PoInput, id?: string) {
  const errors: string[] = [];
  const vendor = await tx.vendor.findFirst({ where: { id: input.vendorId, organizationId: input.organizationId } });
  if (!vendor) errors.push("Choose a supplier");
  if (!input.description?.trim()) errors.push("Enter what the PO is for");
  const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
  const currency = input.currencyCode || vendor?.currencyCode || org.baseCurrency;
  const fxRate = currency === org.baseCurrency ? "1" : (input.fxRate || "").trim();
  if (currency !== org.baseCurrency && !(Number(fxRate) > 0)) errors.push(`Enter the exchange rate for ${currency}`);
  const lines = input.lines.filter((l) => l.description?.trim() || l.unitPrice?.trim() || l.accountId);
  if (!lines.length) errors.push("Add at least one item");
  const accounts = await tx.account.findMany({ where: { organizationId: input.organizationId, id: { in: lines.map((l) => l.accountId).filter(Boolean) } } });
  const outs: LineOut[] = [];
  const rows = lines.map((l, i) => {
    const label = `Item ${i + 1}`;
    if (!l.description?.trim()) errors.push(`${label}: describe the item`);
    const err = checkCategory(accounts.find((a) => a.id === l.accountId), l.category || "EXPENSE", label);
    if (err) errors.push(err);
    let o: LineOut = { qty: 0n, price: 0n, gross: 0n, net: 0n, vat: 0n, ewt: 0n };
    try {
      o = calcLine({ quantity: l.quantity, unitPrice: l.unitPrice, vatType: l.vatType }, { vatInclusive: input.vatInclusive, vendorVatRegistered: vendor?.vatRegistered ?? true });
      if (o.qty <= 0n) errors.push(`${label}: enter a quantity`);
      if (o.price < 0n) errors.push(`${label}: the price cannot be negative`);
    } catch (e) { errors.push(`${label}: ${(e as Error).message}`); }
    outs.push(o);
    return {
      lineNo: i + 1, productId: l.productId || null, description: l.description?.trim() ?? "", quantity: decQ4(o.qty), unit: l.unit?.trim() || null, unitPrice: decQ4(o.price),
      vatType: l.vatType || "VATABLE", netAmount: dec(o.net), vatAmount: dec(o.vat), category: l.category || "EXPENSE", accountId: l.accountId, dims: cleanDims(l.dims),
    };
  });
  if (errors.length) throw new LedgerError(errors);
  const t = totals(outs);
  const head = {
    vendorId: vendor!.id, vendorName: vendor!.name, poDate: asDay(input.poDate), description: input.description.trim(), requestId: input.requestId || null, rfqId: input.rfqId || null,
    deliveryDate: input.deliveryDate ? asDay(input.deliveryDate) : null, deliverTo: input.deliverTo?.trim() || null, paymentTermsDays: input.paymentTermsDays ?? vendor!.paymentTermsDays,
    currencyCode: currency, fxRate: new Prisma.Decimal(fxRate || "1"), vatInclusive: input.vatInclusive, notes: input.notes?.trim() || null,
    subtotal: dec(t.subtotal), vatAmount: dec(t.vat), amount: dec(t.total),
  };
  if (id) {
    const cur = await tx.purchaseOrder.findFirst({ where: { id, organizationId: input.organizationId }, include: { lines: true } });
    if (!cur) throw new LedgerError(["Purchase order not found"]);
    if (cur.status !== "DRAFT") throw new LedgerError(["Only draft POs can be edited. Close or cancel an approved PO and issue a new one."]);
    await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
    const po = await tx.purchaseOrder.update({ where: { id }, data: { ...head, updatedById: input.userId, lines: { create: rows } } });
    await audit(tx, input.organizationId, input.userId, "po.update", id, { number: po.number }, snap(cur), null, "purchase_order");
    return po;
  }
  const number = await nextNumber(tx, input.organizationId, "PO", head.poDate.getUTCFullYear());
  const po = await tx.purchaseOrder.create({ data: { ...head, organizationId: input.organizationId, number, createdById: input.userId, lines: { create: rows } } });
  await audit(tx, input.organizationId, input.userId, "po.create", po.id, { number }, null, null, "purchase_order");
  return po;
}

export async function savePurchaseOrder(input: PoInput, id?: string) {
  return prisma.$transaction(async (tx) => {
    const po = await savePoTx(tx, input, id);
    if (input.action === "submit") await submitPoTx(tx, input.organizationId, input.userId, po.id);
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
  });
}

/** Turn an approved PR straight into a draft PO (when no canvass is needed). */
export async function poFromRequest(organizationId: string, userId: string, requestId: string, vendorId: string) {
  return prisma.$transaction(async (tx) => {
    const pr = await loadPr(tx, organizationId, requestId);
    if (pr.status !== "APPROVED") throw new LedgerError(["Only an approved purchase request can be ordered"]);
    const fallback = await tx.account.findFirst({ where: { organizationId, type: "EXPENSE", isPostable: true, isActive: true }, orderBy: { code: "asc" } });
    const dims = cleanDims({ departmentId: pr.departmentId, costCenterId: pr.costCenterId, projectId: pr.projectId, branchId: pr.branchId });
    const po = await savePoTx(tx, {
      organizationId, userId, vendorId, poDate: new Date(), description: pr.purpose, requestId: pr.id, vatInclusive: true, deliveryDate: pr.neededBy,
      lines: pr.lines.sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ productId: l.productId, description: l.description, quantity: l.quantity.toString(), unit: l.unit, unitPrice: l.estUnitCost.toString(), category: l.category, accountId: l.accountId ?? fallback?.id ?? "", dims })),
    });
    await tx.purchaseRequest.update({ where: { id: pr.id }, data: { status: "ORDERED" } });
    return po;
  });
}

async function loadPo(tx: Tx, organizationId: string, id: string) {
  const po = await tx.purchaseOrder.findFirst({ where: { id, organizationId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!po) throw new LedgerError(["Purchase order not found"]);
  return po;
}

/** Total in base currency, for approval thresholds. */
const baseTotal = (po: { amount: Prisma.Decimal; fxRate: Prisma.Decimal }) => roundDiv(cents(po.amount) * q4of(po.fxRate), 10000n);

async function submitPoTx(tx: Tx, organizationId: string, userId: string, id: string) {
  const po = await loadPo(tx, organizationId, id);
  if (po.status !== "DRAFT") throw new LedgerError(["Only draft POs can be submitted"]);
  if (!po.lines.length) throw new LedgerError(["Add the items before submitting"]);
  await tx.purchaseOrder.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedById: userId, submittedAt: new Date(), rejectReason: null } });
  await recordSubmission(tx, organizationId, "PO", id, userId);
  await audit(tx, organizationId, userId, "po.submit", id, { number: po.number }, null, null, "purchase_order");
}
export const submitPurchaseOrder = (organizationId: string, userId: string, id: string) => prisma.$transaction((tx) => submitPoTx(tx, organizationId, userId, id));

export async function approvePo(organizationId: string, userId: string, id: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    const po = await loadPo(tx, organizationId, id);
    if (po.status !== "PENDING_APPROVAL") throw new LedgerError(["This PO is not waiting for approval"]);
    const done = await approveLevel(tx, { organizationId, docType: "PO", docId: id, userId, total: baseTotal(po), preparerIds: [po.createdById, po.submittedById, po.updatedById], comment });
    if (done) await tx.purchaseOrder.update({ where: { id }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() } });
    await audit(tx, organizationId, userId, done ? "po.approve" : "po.approve_level", id, { number: po.number }, null, null, "purchase_order");
    return done;
  });
}

export async function returnPo(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const po = await loadPo(tx, organizationId, id);
    if (po.status !== "PENDING_APPROVAL") throw new LedgerError(["Only POs waiting for approval can be returned"]);
    await recordReturn(tx, organizationId, "PO", id, userId, reason, baseTotal(po));
    await tx.purchaseOrder.update({ where: { id }, data: { status: "DRAFT", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "po.return", id, { number: po.number, reason }, null, null, "purchase_order");
  });
}

/** Close (approved, nothing more expected) or cancel (nothing received yet). */
export async function closePo(organizationId: string, userId: string, id: string, reason: string, cancel: boolean) {
  return prisma.$transaction(async (tx) => {
    const po = await loadPo(tx, organizationId, id);
    if (!reason.trim()) throw new LedgerError(["Give a reason"]);
    if (po.status === "CLOSED" || po.status === "CANCELLED") throw new LedgerError([`PO is already ${po.status.toLowerCase()}`]);
    if (cancel) {
      const received = await tx.goodsReceipt.count({ where: { purchaseOrderId: id, status: "POSTED" } });
      if (received) throw new LedgerError(["Items were already received on this PO. Close it instead of cancelling."]);
    } else if (po.status !== "APPROVED") throw new LedgerError(["Only approved POs can be closed"]);
    await tx.purchaseOrder.update({ where: { id }, data: { status: cancel ? "CANCELLED" : "CLOSED", closedAt: new Date(), closeReason: reason.trim() } });
    await audit(tx, organizationId, userId, cancel ? "po.cancel" : "po.close", id, { number: po.number, reason }, null, null, "purchase_order");
  });
}

/** Ordered, received and billed quantity per PO line (posted receipts, non-void bills). */
export async function poProgress(db: Tx | typeof prisma, purchaseOrderId: string, excludeBillId?: string) {
  const [lines, rr, billed] = await Promise.all([
    db.purchaseOrderLine.findMany({ where: { purchaseOrderId }, orderBy: { lineNo: "asc" } }),
    db.goodsReceiptLine.groupBy({ by: ["poLineId"], where: { receipt: { purchaseOrderId, status: "POSTED" } }, _sum: { quantity: true } }),
    db.apBillLine.groupBy({ by: ["poLineId"], where: { poLine: { purchaseOrderId }, bill: { status: { not: "VOID" }, ...(excludeBillId ? { id: { not: excludeBillId } } : {}) } }, _sum: { quantity: true } }),
  ]);
  return lines.map((l) => ({
    line: l, ordered: q4of(l.quantity),
    received: q4of(rr.find((r) => r.poLineId === l.id)?._sum.quantity ?? 0),
    billed: q4of(billed.find((b) => b.poLineId === l.id)?._sum.quantity ?? 0),
  }));
}

// ---------- Receiving ----------

export async function recordGoodsReceipt(organizationId: string, userId: string, input: { purchaseOrderId: string; date: Date; deliveryRef?: string | null; notes?: string | null; lines: { poLineId: string; quantity: string; remarks?: string | null }[] }) {
  return prisma.$transaction(async (tx) => {
    const po = await loadPo(tx, organizationId, input.purchaseOrderId);
    if (po.status !== "APPROVED") throw new LedgerError(["Items can only be received on an approved PO"]);
    const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: po.vendorId! } });
    const progress = await poProgress(tx, po.id);
    const errors: string[] = [];
    const rows: { poLineId: string; quantity: Prisma.Decimal; remarks: string | null }[] = [];
    const gl: LineInput[] = [];
    const grni = await grniAccount(tx, organizationId);
    let credit = 0n;
    for (const l of input.lines) {
      if (!String(l.quantity ?? "").trim()) continue;
      const p = progress.find((x) => x.line.id === l.poLineId);
      if (!p) { errors.push("A received item is not on this PO"); continue; }
      let qty = 0n;
      try { qty = q4(l.quantity); } catch (e) { errors.push(`Item ${p.line.lineNo}: ${(e as Error).message}`); continue; }
      if (qty === 0n) continue;
      if (qty < 0n) { errors.push(`Item ${p.line.lineNo}: quantity cannot be negative`); continue; }
      if (p.received + qty > p.ordered) errors.push(`Item ${p.line.lineNo}: receiving ${fromQ4(qty)} would exceed the ${fromQ4(p.ordered)} ordered (${fromQ4(p.received)} already received)`);
      rows.push({ poLineId: p.line.id, quantity: decQ4(qty), remarks: l.remarks?.trim() || null });
      const cost = roundDiv(qty * netUnitCost(q4of(p.line.unitPrice), p.line.vatType, po.vatInclusive, vendor.vatRegistered), 1000000n);
      if (cost > 0n) {
        gl.push({ accountId: p.line.accountId, debit: fromCentavos(cost), description: `${p.line.description} (${fromQ4(qty)} ${p.line.unit ?? ""})`.trim(), currencyCode: po.currencyCode, fxRate: po.fxRate.toString(), dims: cleanDims(p.line.dims), partyType: "VENDOR", partyId: vendor.code });
        credit += cost;
      }
    }
    if (!rows.length) errors.push("Enter the quantity received for at least one item");
    if (errors.length) throw new LedgerError(errors);
    const date = asDay(input.date);
    const number = await nextNumber(tx, organizationId, "RR", date.getUTCFullYear());
    const rr = await tx.goodsReceipt.create({ data: { organizationId, number, purchaseOrderId: po.id, date, deliveryRef: input.deliveryRef?.trim() || null, notes: input.notes?.trim() || null, receivedById: userId, lines: { create: rows } } });
    if (credit > 0n) {
      gl.push({ accountId: grni.id, credit: fromCentavos(credit), description: `Received on ${po.number}, not yet invoiced`, currencyCode: po.currencyCode, fxRate: po.fxRate.toString(), partyType: "VENDOR", partyId: vendor.code });
      const e = await recordJournalTx(tx, { organizationId, userId, date, memo: `${number}: received from ${vendor.name} on ${po.number}`, reference: input.deliveryRef?.trim() || number, lines: gl, source: "PURCHASES", sourceId: rr.id, action: "post" });
      await tx.goodsReceipt.update({ where: { id: rr.id }, data: { journalEntryId: e.id } });
    }
    await audit(tx, organizationId, userId, "rr.create", rr.id, { number, po: po.number }, null, null, "goods_receipt");
    return rr;
  });
}

export async function voidGoodsReceipt(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const rr = await tx.goodsReceipt.findFirst({ where: { id, organizationId }, include: { lines: true } });
    if (!rr) throw new LedgerError(["Receiving report not found"]);
    if (rr.status === "VOID") throw new LedgerError(["Already void"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason"]);
    const progress = await poProgress(tx, rr.purchaseOrderId);
    for (const l of rr.lines) {
      const p = progress.find((x) => x.line.id === l.poLineId)!;
      if (p.received - q4of(l.quantity) < p.billed) throw new LedgerError([`Item ${p.line.lineNo} is already billed by the supplier. Void the bill first.`]);
    }
    if (rr.journalEntryId) await voidOrReverseTx(tx, organizationId, userId, rr.journalEntryId, undefined, true);
    await tx.goodsReceipt.update({ where: { id }, data: { status: "VOID", voidedById: userId, voidedAt: new Date(), voidReason: reason.trim() } });
    await audit(tx, organizationId, userId, "rr.void", id, { number: rr.number, reason }, null, null, "goods_receipt");
  });
}

