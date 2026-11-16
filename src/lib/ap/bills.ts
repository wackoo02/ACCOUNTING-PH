// Supplier bills (AP vouchers / purchase invoices). Draft -> for approval (approval matrix) -> posted to the GL.
// Posting: Dr expense / inventory / fixed asset / prepayment (or GRNI for lines matched to a received PO),
//          Dr Input VAT, Cr EWT payable (by tax code), Cr Accounts Payable (net of EWT) tagged with the vendor.
// EWT is recognized when the bill is booked (RR 2-98: withholding applies when the income is paid or payable,
// whichever comes first); BIR Form 2307 is printed from the payment or per quarter.
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { LedgerError, asDay, audit, nextNumber, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import { approveLevel, recordReturn, recordSubmission } from "../approvals";
import { fromCentavos } from "../money";
import { validateLines, type LineInput } from "../ledger/validate";
import { addDays, calcLine, matchLine, netUnitCost, roundDiv, totals, type LineOut } from "./compute";
import { type Tx, cents, checkCategory, cleanDims, dec, decQ4, grniAccount, q4of, roleAccount, withFxDifference } from "./common";
import { poProgress } from "../purchasing/service";

export type BillLineInput = {
  description: string; category?: string | null; accountId: string; quantity?: string | null; unitPrice: string; vatType?: string | null;
  ewtTaxCodeId?: string | null; poLineId?: string | null; dims?: Record<string, string | null>; prepaidStart?: Date | null; prepaidEnd?: Date | null;
};
export type BillInput = {
  organizationId: string; userId: string; vendorId: string; supplierInvoiceNo: string; invoiceDate: Date; date?: Date | null; dueDate?: Date | null;
  purchaseOrderId?: string | null; memo?: string | null; currencyCode?: string | null; fxRate?: string | null; vatInclusive: boolean;
  lines: BillLineInput[]; inboxDocumentId?: string | null; action?: "draft" | "submit";
};

const snap = (x: unknown) => JSON.parse(JSON.stringify(x)) as Prisma.InputJsonValue;
/** Bill total in base currency, for approval thresholds. */
export const billBaseTotal = (b: { total: Prisma.Decimal; fxRate: Prisma.Decimal }) => roundDiv(cents(b.total) * q4of(b.fxRate), 10000n);
export const normInvoiceNo = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(^|[A-Z])0+(?=\d)/g, "$1");

/** Another non-void bill from the same supplier with the same invoice number. */
export async function findDuplicateBill(db: Tx | typeof prisma, organizationId: string, vendorId: string, invoiceNo: string, excludeId?: string) {
  const n = normInvoiceNo(invoiceNo);
  if (!n) return null;
  const others = await db.apBill.findMany({ where: { organizationId, vendorId, status: { not: "VOID" }, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { id: true, number: true, supplierInvoiceNo: true } });
  return others.find((o) => normInvoiceNo(o.supplierInvoiceNo) === n) ?? null;
}

type Prepared = { head: Omit<Prisma.ApBillUncheckedCreateInput, "organizationId" | "number" | "createdById" | "lines">; rows: Omit<Prisma.ApBillLineUncheckedCreateInput, "billId">[]; warnings: string[] };

async function prepare(tx: Tx, input: BillInput, selfId?: string): Promise<Prepared> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
  const vendor = await tx.vendor.findFirst({ where: { id: input.vendorId, organizationId: input.organizationId } });
  if (!vendor) throw new LedgerError(["Choose the supplier"]);
  if (!input.supplierInvoiceNo?.trim()) errors.push("Enter the supplier's invoice number");
  else {
    const dup = await findDuplicateBill(tx, input.organizationId, vendor.id, input.supplierInvoiceNo, selfId);
    if (dup) errors.push(`Invoice ${input.supplierInvoiceNo} from ${vendor.name} is already recorded as ${dup.number}`);
  }
  const po = input.purchaseOrderId ? await tx.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, organizationId: input.organizationId }, include: { lines: true } }) : null;
  if (input.purchaseOrderId && !po) errors.push("Purchase order not found");
  if (po && po.vendorId !== vendor.id) errors.push(`${po.number} is for a different supplier`);
  if (po && !["APPROVED", "CLOSED"].includes(po.status)) errors.push(`${po.number} is not approved`);
  const currency = po?.currencyCode ?? (input.currencyCode || vendor.currencyCode || org.baseCurrency);
  const fxRate = currency === org.baseCurrency ? "1" : (input.fxRate || "").trim();
  if (currency !== org.baseCurrency && !(Number(fxRate) > 0)) errors.push(`Enter the exchange rate for ${currency}`);

  const lines = input.lines.filter((l) => l.description?.trim() || String(l.unitPrice ?? "").trim() || l.accountId);
  if (!lines.length) errors.push("Add at least one line");
  const [accounts, taxCodes] = await Promise.all([
    tx.account.findMany({ where: { organizationId: input.organizationId, id: { in: lines.map((l) => l.accountId).filter(Boolean) } } }),
    tx.taxCode.findMany({ where: { organizationId: input.organizationId, taxType: "EWT", isActive: true } }),
  ]);
  const progress = po ? await poProgress(tx, po.id, selfId) : [];
  const billedNow = new Map<string, bigint>();
  const outs: LineOut[] = [];
  const rows = lines.map((l, i) => {
    const label = `Line ${i + 1}`;
    if (!l.description?.trim()) errors.push(`${label}: enter a description`);
    const category = l.category || "EXPENSE";
    const err = checkCategory(accounts.find((a) => a.id === l.accountId), category, label);
    if (err) errors.push(err);
    const tc = l.ewtTaxCodeId ? taxCodes.find((t) => t.id === l.ewtTaxCodeId) : undefined;
    if (l.ewtTaxCodeId && !tc) errors.push(`${label}: withholding tax code not found`);
    let o: LineOut = { qty: 0n, price: 0n, gross: 0n, net: 0n, vat: 0n, ewt: 0n };
    try {
      o = calcLine({ quantity: l.quantity || "1", unitPrice: l.unitPrice, vatType: l.vatType, ewtRate: tc?.rate.toString() }, { vatInclusive: input.vatInclusive, vendorVatRegistered: vendor.vatRegistered });
      if (o.qty <= 0n) errors.push(`${label}: enter a quantity`);
      if (o.gross <= 0n) errors.push(`${label}: enter a positive amount`);
    } catch (e) { errors.push(`${label}: ${(e as Error).message}`); }
    outs.push(o);
    if (l.poLineId) {
      const p = progress.find((x) => x.line.id === l.poLineId);
      if (!p) errors.push(`${label}: the PO line is not on ${po?.number ?? "the selected PO"}`);
      else {
        const already = billedNow.get(p.line.id) ?? 0n;
        const m = matchLine({ lineNo: i + 1, billQty: o.qty, billNet: o.net, poNetUnit: netUnitCost(q4of(p.line.unitPrice), p.line.vatType, po!.vatInclusive, vendor.vatRegistered), received: p.received, billedElsewhere: p.billed + already, ordered: p.ordered });
        errors.push(...m.errors); warnings.push(...m.warnings);
        billedNow.set(p.line.id, already + o.qty);
      }
    } else if (category === "FIXED_ASSET") errors.push(`${label}: fixed asset purchases need an approved PO. Link the PO line.`);
    if (category === "PREPAYMENT" && l.prepaidStart && l.prepaidEnd && l.prepaidEnd < l.prepaidStart) errors.push(`${label}: the coverage end date is before the start date`);
    return {
      lineNo: i + 1, description: l.description?.trim() ?? "", category, accountId: l.accountId, quantity: decQ4(o.qty), unitPrice: decQ4(o.price), vatType: l.vatType || "VATABLE",
      netAmount: dec(o.net), vatAmount: dec(o.vat), ewtTaxCodeId: tc?.id ?? null, ewtAmount: dec(o.ewt), poLineId: l.poLineId || null, dims: cleanDims(l.dims),
      prepaidStart: l.prepaidStart ? asDay(l.prepaidStart) : null, prepaidEnd: l.prepaidEnd ? asDay(l.prepaidEnd) : null,
    };
  });
  if (errors.length) throw new LedgerError(errors);
  const t = totals(outs);
  if (t.ewt >= t.total) throw new LedgerError(["Withholding tax must be less than the invoice total"]);
  const invoiceDate = asDay(input.invoiceDate);
  const terms = po?.paymentTermsDays ?? vendor.paymentTermsDays;
  return {
    warnings, rows,
    head: {
      vendorId: vendor.id, supplierInvoiceNo: input.supplierInvoiceNo.trim(), invoiceDate, date: asDay(input.date ?? invoiceDate),
      dueDate: input.dueDate ? asDay(input.dueDate) : addDays(invoiceDate, terms), purchaseOrderId: po?.id ?? null,
      memo: input.memo?.trim() || po?.description || rows[0]?.description || "Supplier invoice", currencyCode: currency, fxRate: new Prisma.Decimal(fxRate || "1"), vatInclusive: input.vatInclusive,
      subtotal: dec(t.subtotal), vatAmount: dec(t.vat), total: dec(t.total), ewtAmount: dec(t.ewt), netPayable: dec(t.netPayable), matchNotes: warnings,
    },
  };
}

export async function saveBill(input: BillInput, id?: string) {
  return prisma.$transaction(async (tx) => {
    const p = await prepare(tx, input, id);
    let billId: string;
    if (id) {
      const cur = await tx.apBill.findFirst({ where: { id, organizationId: input.organizationId }, include: { lines: true } });
      if (!cur) throw new LedgerError(["Bill not found"]);
      if (cur.status !== "DRAFT") throw new LedgerError(["Only drafts can be edited. Void a posted bill and record it again."]);
      await tx.apBillLine.deleteMany({ where: { billId: id } });
      await tx.apBill.update({ where: { id }, data: { ...p.head, updatedById: input.userId, lines: { create: p.rows } } });
      await audit(tx, input.organizationId, input.userId, "bill.update", id, { number: cur.number }, snap(cur), null, "ap_bill");
      billId = id;
    } else {
      const number = await nextNumber(tx, input.organizationId, "APV", (p.head.date as Date).getUTCFullYear());
      if (input.inboxDocumentId) {
        const doc = await tx.apInboxDocument.findFirst({ where: { id: input.inboxDocumentId, organizationId: input.organizationId } });
        if (!doc) throw new LedgerError(["Inbox document not found"]);
        if (doc.billId) throw new LedgerError(["A bill was already created from this document"]);
      }
      const b = await tx.apBill.create({ data: { ...p.head, organizationId: input.organizationId, number, createdById: input.userId, inboxDocumentId: input.inboxDocumentId || null, lines: { create: p.rows } } });
      if (input.inboxDocumentId) await tx.apInboxDocument.update({ where: { id: input.inboxDocumentId }, data: { status: "BILLED", billId: b.id, reviewedById: input.userId, reviewedAt: new Date() } });
      await audit(tx, input.organizationId, input.userId, "bill.create", b.id, { number }, null, null, "ap_bill");
      billId = b.id;
    }
    // Build the GL entry now so a draft never hides a bill that cannot post.
    await journalLines(tx, await loadBill(tx, input.organizationId, billId));
    if (input.action === "submit") await submitBillTx(tx, input.organizationId, input.userId, billId);
    return tx.apBill.findUniqueOrThrow({ where: { id: billId } });
  });
}

async function loadBill(tx: Tx, organizationId: string, id: string) {
  const b = await tx.apBill.findFirst({ where: { id, organizationId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!b) throw new LedgerError(["Bill not found"]);
  return b;
}
type BillFull = Awaited<ReturnType<typeof loadBill>>;

/** The GL lines of a bill. */
export async function journalLines(tx: Tx, b: BillFull): Promise<LineInput[]> {
  const vendor = await tx.vendor.findUniqueOrThrow({ where: { id: b.vendorId } });
  const party = { partyType: "VENDOR", partyId: vendor.code };
  const cur = { currencyCode: b.currencyCode, fxRate: b.fxRate.toString() };
  const po = b.purchaseOrderId ? await tx.purchaseOrder.findUnique({ where: { id: b.purchaseOrderId }, include: { lines: true } }) : null;
  const out: LineInput[] = [];
  for (const l of b.lines) {
    const net = cents(l.netAmount);
    const dims = cleanDims(l.dims);
    const pl = l.poLineId ? po?.lines.find((x) => x.id === l.poLineId) : undefined;
    if (pl && po) {
      const grni = await grniAccount(tx, b.organizationId);
      const atPo = roundDiv(q4of(l.quantity) * netUnitCost(q4of(pl.unitPrice), pl.vatType, po.vatInclusive, vendor.vatRegistered), 1000000n);
      if (atPo > 0n) out.push({ accountId: grni.id, debit: fromCentavos(atPo), description: `${l.description} (received on ${po.number})`, currencyCode: po.currencyCode, fxRate: po.fxRate.toString(), ...party });
      const variance = net - atPo;
      if (variance !== 0n) out.push({ accountId: l.accountId, [variance > 0n ? "debit" : "credit"]: fromCentavos(variance > 0n ? variance : -variance), description: `${l.description}: price difference vs ${po.number}`, ...cur, dims, ...party });
    } else {
      out.push({ accountId: l.accountId, debit: fromCentavos(net), description: l.description, ...cur, dims, ...party });
    }
  }
  const vat = cents(b.vatAmount);
  if (vat > 0n) out.push({ accountId: (await roleAccount(tx, b.organizationId, "INPUT_VAT", "Input VAT")).id, debit: fromCentavos(vat), description: `Input VAT, ${vendor.name} invoice ${b.supplierInvoiceNo}`, ...cur, ...party });
  const ewtByCode = new Map<string, bigint>();
  for (const l of b.lines) if (l.ewtTaxCodeId && cents(l.ewtAmount) > 0n) ewtByCode.set(l.ewtTaxCodeId, (ewtByCode.get(l.ewtTaxCodeId) ?? 0n) + cents(l.ewtAmount));
  for (const [code, amt] of ewtByCode) {
    const tc = await tx.taxCode.findUniqueOrThrow({ where: { id: code } });
    const acct = (tc.accountCode ? await tx.account.findUnique({ where: { organizationId_code: { organizationId: b.organizationId, code: tc.accountCode } } }) : null) ?? (await roleAccount(tx, b.organizationId, "EWT_PAYABLE", "Expanded Withholding Tax Payable"));
    out.push({ accountId: acct.id, credit: fromCentavos(amt), description: `EWT ${tc.atcCode ?? tc.code} ${tc.rate.toString()}% (BIR 2307 to ${vendor.name})`, ...cur, ...party });
  }
  const ap = await roleAccount(tx, b.organizationId, "AP_CONTROL", "Accounts Payable");
  out.push({ accountId: ap.id, credit: b.netPayable.toString(), description: `${vendor.name} invoice ${b.supplierInvoiceNo}, due ${b.dueDate.toISOString().slice(0, 10)}`, ...cur, ...party });
  const lines = await withFxDifference(tx, b.organizationId, out, `Exchange difference vs PO rate, ${b.number}`);
  const org = await tx.organization.findUniqueOrThrow({ where: { id: b.organizationId } });
  const v = validateLines(lines, org.baseCurrency);
  if (!v.ok) throw new LedgerError(v.errors);
  return lines;
}

async function submitBillTx(tx: Tx, organizationId: string, userId: string, id: string) {
  const b = await loadBill(tx, organizationId, id);
  if (b.status !== "DRAFT") throw new LedgerError(["Only drafts can be submitted"]);
  await tx.apBill.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedById: userId, submittedAt: new Date(), rejectReason: null } });
  await recordSubmission(tx, organizationId, "BILL", id, userId);
  await audit(tx, organizationId, userId, "bill.submit", id, { number: b.number }, null, null, "ap_bill");
}
export const submitBill = (organizationId: string, userId: string, id: string) => prisma.$transaction((tx) => submitBillTx(tx, organizationId, userId, id));

/** One approval level. The last level posts the bill to the GL and the AP sub-ledger. */
export async function approveBill(organizationId: string, userId: string, id: string, comment?: string) {
  return prisma.$transaction(async (tx) => {
    const b = await loadBill(tx, organizationId, id);
    if (b.status !== "PENDING_APPROVAL") throw new LedgerError(["This bill is not waiting for approval"]);
    const done = await approveLevel(tx, { organizationId, docType: "BILL", docId: id, userId, total: billBaseTotal(b), preparerIds: [b.createdById, b.submittedById, b.updatedById], comment });
    if (!done) { await audit(tx, organizationId, userId, "bill.approve_level", id, { number: b.number }, null, null, "ap_bill"); return null; }
    // Re-check the 3-way match: a receiving report may have been voided since the bill was prepared.
    if (b.purchaseOrderId) {
      const progress = await poProgress(tx, b.purchaseOrderId, b.id);
      for (const l of b.lines.filter((x) => x.poLineId)) {
        const p = progress.find((x) => x.line.id === l.poLineId);
        if (!p || p.received - p.billed < q4of(l.quantity)) throw new LedgerError([`Line ${l.lineNo}: the quantity received is no longer enough for this bill. Return it to the preparer.`]);
      }
    }
    const e = await recordJournalTx(tx, {
      organizationId, userId, date: b.date, transactionDate: b.invoiceDate, memo: `${b.number}: ${b.memo}`, reference: b.supplierInvoiceNo,
      lines: await journalLines(tx, b), source: "PURCHASES", sourceId: b.id, action: "post",
    });
    const r = await tx.apBill.updateMany({ where: { id, status: "PENDING_APPROVAL" }, data: { status: "POSTED", journalEntryId: e.id, approvedById: userId, approvedAt: new Date() } });
    if (r.count !== 1) throw new LedgerError(["This bill was changed by someone else; refresh and try again"]);
    await audit(tx, organizationId, userId, "bill.post", id, { number: b.number, journal: e.number }, null, null, "ap_bill");
    return e;
  });
}

export async function returnBill(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const b = await loadBill(tx, organizationId, id);
    if (b.status !== "PENDING_APPROVAL") throw new LedgerError(["Only bills waiting for approval can be returned"]);
    await recordReturn(tx, organizationId, "BILL", id, userId, reason, billBaseTotal(b));
    await tx.apBill.update({ where: { id }, data: { status: "DRAFT", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "bill.return", id, { number: b.number, reason }, null, null, "ap_bill");
  });
}

export async function voidBill(organizationId: string, userId: string, id: string, reason: string, reversalDate?: Date) {
  return prisma.$transaction(async (tx) => {
    const b = await loadBill(tx, organizationId, id);
    if (b.status === "VOID") throw new LedgerError(["Bill is already void"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason for voiding"]);
    const paid = await tx.apPaymentLine.findFirst({ where: { billId: id, payment: { status: { not: "VOID" } } }, include: { payment: true } });
    if (paid) throw new LedgerError([`Payment ${paid.payment.number} includes this bill. Void or change the payment first.`]);
    if (b.status === "POSTED" && b.journalEntryId) await voidOrReverseTx(tx, organizationId, userId, b.journalEntryId, reversalDate ?? b.date, true);
    await tx.apBill.update({ where: { id }, data: { status: "VOID", voidedById: userId, voidedAt: new Date(), voidReason: reason.trim() } });
    if (b.inboxDocumentId) await tx.apInboxDocument.update({ where: { id: b.inboxDocumentId }, data: { status: "READY", billId: null } });
    await tx.apBill.update({ where: { id }, data: { inboxDocumentId: null } });
    await audit(tx, organizationId, userId, "bill.void", id, { number: b.number, reason }, null, null, "ap_bill");
  });
}

/** Schedule (or unschedule) bills for payment, or put them on hold. */
export async function scheduleBills(organizationId: string, userId: string, billIds: string[], input: { scheduledPayDate?: Date | null; onHold?: boolean }) {
  return prisma.$transaction(async (tx) => {
    const data: Prisma.ApBillUpdateManyMutationInput = {};
    if (input.scheduledPayDate !== undefined) data.scheduledPayDate = input.scheduledPayDate ? asDay(input.scheduledPayDate) : null;
    if (input.onHold !== undefined) data.onHold = input.onHold;
    const r = await tx.apBill.updateMany({ where: { organizationId, id: { in: billIds }, status: "POSTED" }, data });
    await audit(tx, organizationId, userId, "bill.schedule", billIds.join(","), { count: r.count, ...input, scheduledPayDate: input.scheduledPayDate?.toISOString().slice(0, 10) ?? null }, null, null, "ap_bill");
    return r.count;
  });
}

/** Unpaid balance of posted bills: net payable less payments not voided (drafts and pending included). */
export async function openBalances(db: Tx | typeof prisma, organizationId: string, billIds: string[], excludePaymentId?: string) {
  const sums = await db.apPaymentLine.groupBy({
    by: ["billId"], where: { billId: { in: billIds }, payment: { organizationId, status: { not: "VOID" }, ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}) } }, _sum: { amount: true },
  });
  return new Map(sums.map((s) => [s.billId, cents(s._sum.amount)]));
}
