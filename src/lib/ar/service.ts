// Accounts receivable: sales invoices, credit memos and collections. Every document goes
// draft -> for approval -> posted (issued) and posts to the GL with source SALES through recordJournalTx.
// The BIR serial is assigned when the document is issued, so drafts never use up a number.
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { convert, parseRate, type Dims, type LineInput } from "../ledger/validate";
import { LedgerError, assertCanApprove, asDay, audit, nextNumber, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import { assertNotReconciled } from "../bank/cash";
import { can } from "../permissions";
import { addDays, computeInvoice, type VatType, VAT_TYPES } from "./compute";

type Tx = Prisma.TransactionClient;
export type Action = "draft" | "submit" | "post";
export type DocKind = "INVOICE" | "CREDIT_MEMO";

const cents = (d: Prisma.Decimal | string | null | undefined) => toCentavos(d?.toString() ?? "0");
const dec = (c: bigint) => new Prisma.Decimal(fromCentavos(c));
const fmt = (c: bigint) => (Number(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 });
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

export const SERIES_TYPES = {
  SALES_INVOICE: "Sales invoice",
  CREDIT_MEMO: "Credit memo",
  COLLECTION_RECEIPT: "Collection / official receipt",
  POS_INVOICE: "POS sales invoice (later)",
} as const;
export type SeriesType = keyof typeof SERIES_TYPES;
const FALLBACK_PREFIX: Record<SeriesType, string> = { SALES_INVOICE: "SI", CREDIT_MEMO: "CM", COLLECTION_RECEIPT: "OR", POS_INVOICE: "POS" };

async function roleAccount(tx: Tx, organizationId: string, systemRole: string) {
  return tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole } } });
}
async function requireRole(tx: Tx, organizationId: string, systemRole: string, label: string) {
  const a = await roleAccount(tx, organizationId, systemRole);
  if (!a) throw new LedgerError([`Assign the ${label} account first (Chart of Accounts, system role ${systemRole})`]);
  return a;
}

// ---------- BIR document series ----------

/** Take the next serial from the default active series of this type (or a plain yearly sequence if none is set up). */
export async function assignSerial(tx: Tx, organizationId: string, docType: SeriesType, date: Date) {
  const series = await tx.documentSeries.findFirst({
    where: { organizationId, docType, isActive: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  if (!series) return { number: await nextNumber(tx, organizationId, FALLBACK_PREFIX[docType], date.getUTCFullYear()), seriesId: null };
  if (series.validUntil && date > series.validUntil) throw new LedgerError([`The ${series.name} series (${series.authorityType} ${series.authorityNo ?? ""}) is valid only until ${series.validUntil.toISOString().slice(0, 10)}. Register a new one under Receivables → Invoice Series.`]);
  const s = await tx.documentSeries.update({ where: { id: series.id }, data: { nextNo: { increment: 1 } } });
  const n = s.nextNo - 1;
  if (s.endNo && n > s.endNo) throw new LedgerError([`The ${series.name} series is used up (last serial ${s.endNo}). Register the next ATP / permit range under Receivables → Invoice Series.`]);
  return { number: `${s.prefix}${String(n).padStart(s.padding, "0")}`, seriesId: s.id };
}

export type SeriesInput = {
  docType: SeriesType; name: string; prefix?: string | null; startNo: number; endNo?: number | null; nextNo?: number | null; padding?: number | null;
  branchCode?: string | null; authorityType?: string | null; authorityNo?: string | null; authorityDate?: Date | null; validUntil?: Date | null;
  printerName?: string | null; printerTin?: string | null; printerAddress?: string | null; printerAccreditationNo?: string | null; printerAccreditationDate?: Date | null;
  isDefault?: boolean; isActive?: boolean;
};

export async function saveSeries(organizationId: string, userId: string, input: SeriesInput, id?: string) {
  const errors: string[] = [];
  if (!(input.docType in SERIES_TYPES)) errors.push("Choose the document type");
  if (!input.name?.trim()) errors.push("Enter a name, e.g. Main office sales invoices");
  if (!(input.startNo >= 1)) errors.push("The first serial must be 1 or more");
  if (input.endNo != null && input.endNo < input.startNo) errors.push("The last serial must not be below the first");
  const t = (s?: string | null) => s?.trim() || null;
  return prisma.$transaction(async (tx) => {
    const cur = id ? await tx.documentSeries.findFirst({ where: { id, organizationId } }) : null;
    if (id && !cur) errors.push("Series not found");
    const used = cur ? cur.nextNo > cur.startNo : false;
    const nextNo = input.nextNo ?? cur?.nextNo ?? input.startNo;
    if (used && cur && nextNo < cur.nextNo) errors.push(`Serials up to ${cur.nextNo - 1} are already issued; the next serial cannot go back`);
    if (nextNo < input.startNo) errors.push("The next serial cannot be below the first serial");
    if (errors.length) throw new LedgerError(errors);
    const data = {
      docType: input.docType, name: input.name.trim(), prefix: input.prefix?.trim() ?? "", startNo: input.startNo, endNo: input.endNo ?? null, nextNo,
      padding: Math.min(Math.max(input.padding ?? 6, 1), 12), branchCode: t(input.branchCode) ?? "00000", authorityType: t(input.authorityType) ?? "ATP",
      authorityNo: t(input.authorityNo), authorityDate: input.authorityDate ? asDay(input.authorityDate) : null, validUntil: input.validUntil ? asDay(input.validUntil) : null,
      printerName: t(input.printerName), printerTin: t(input.printerTin), printerAddress: t(input.printerAddress),
      printerAccreditationNo: t(input.printerAccreditationNo), printerAccreditationDate: input.printerAccreditationDate ? asDay(input.printerAccreditationDate) : null,
      isDefault: !!input.isDefault, isActive: input.isActive ?? true,
    };
    if (data.isDefault) await tx.documentSeries.updateMany({ where: { organizationId, docType: data.docType, ...(id ? { id: { not: id } } : {}) }, data: { isDefault: false } });
    const s = id ? await tx.documentSeries.update({ where: { id }, data }) : await tx.documentSeries.create({ data: { ...data, organizationId } });
    await audit(tx, organizationId, userId, "ar.series", s.id, { name: s.name }, cur ? json(cur) : null, json(s), "document_series");
    return s;
  });
}

// ---------- Sales invoices and credit memos ----------

export type InvoiceLineInput = {
  productId?: string | null; description: string; quantity: string; unit?: string | null; unitPrice: string; discount?: string | null;
  vatType: VatType; accountId?: string | null; dims?: Dims;
};
export type InvoiceInput = {
  organizationId: string; userId: string; kind?: DocKind; customerId: string; date: Date; termsDays?: number | null; dueDate?: Date | null;
  fxRate?: string | null; pricesIncludeVat?: boolean; reference?: string | null; memo?: string | null; ewtTaxCodeId?: string | null;
  lines: InvoiceLineInput[]; creditForId?: string | null; reason?: string | null;
  source?: string; sourceRef?: string | null; contractId?: string | null; action?: Action;
};

type Invoice = Prisma.SalesInvoiceGetPayload<{ include: { lines: true } }>;

async function prepareInvoice(tx: Tx, input: InvoiceInput) {
  const errors: string[] = [];
  const kind: DocKind = input.kind ?? "INVOICE";
  const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
  const customer = await tx.customer.findFirst({ where: { id: input.customerId, organizationId: input.organizationId } });
  if (!customer) throw new LedgerError(["Choose a customer"]);
  if (!customer.isActive) errors.push(`${customer.name} is inactive`);
  const currencyCode = customer.currencyCode || org.baseCurrency;
  const foreign = currencyCode !== org.baseCurrency;
  const fxRate = foreign ? input.fxRate?.trim() || "" : "1";
  if (foreign && !((parseRate(fxRate) ?? 0n) > 0n)) errors.push(`Enter the exchange rate for ${currencyCode}`);

  let creditFor: Prisma.SalesInvoiceGetPayload<object> | null = null;
  if (kind === "CREDIT_MEMO") {
    if (!input.reason?.trim()) errors.push("Give the reason for the credit memo (returns, price adjustment, discount)");
    if (input.creditForId) {
      creditFor = await tx.salesInvoice.findFirst({ where: { id: input.creditForId, organizationId: input.organizationId, kind: "INVOICE" } });
      if (!creditFor) errors.push("The invoice being credited was not found");
      else if (creditFor.customerId !== customer.id) errors.push("The invoice being credited belongs to another customer");
      else if (creditFor.status !== "POSTED") errors.push("Only an issued (posted) invoice can be credited");
    }
  }

  const rows = input.lines.filter((l) => l.description?.trim() || String(l.unitPrice ?? "").trim() || l.productId);
  if (!rows.length) errors.push("Add at least one line");
  const products = await tx.product.findMany({ where: { organizationId: input.organizationId, id: { in: rows.map((l) => l.productId).filter(Boolean) as string[] } } });
  const roles = {
    SALES: await roleAccount(tx, input.organizationId, "SALES"),
    SERVICE: await roleAccount(tx, input.organizationId, "SERVICE_INCOME"),
    RETURNS: await roleAccount(tx, input.organizationId, "SALES_RETURNS"),
  };
  const accountIds: string[] = [];
  for (const [i, l] of rows.entries()) {
    const p = products.find((x) => x.id === l.productId);
    if (l.productId && !p) errors.push(`Line ${i + 1}: product not found`);
    if (!l.description?.trim() && !p) errors.push(`Line ${i + 1}: enter a description`);
    if (!VAT_TYPES.includes(l.vatType)) errors.push(`Line ${i + 1}: choose VATable, zero-rated or exempt`);
    let acct = l.accountId || null;
    if (!acct && p?.salesAccountCode) acct = (await tx.account.findUnique({ where: { organizationId_code: { organizationId: input.organizationId, code: p.salesAccountCode } } }))?.id ?? null;
    if (!acct) acct = (kind === "CREDIT_MEMO" ? roles.RETURNS?.id : null) ?? (p?.kind === "SERVICE" ? roles.SERVICE?.id : roles.SALES?.id) ?? roles.SALES?.id ?? roles.SERVICE?.id ?? null;
    if (!acct) errors.push(`Line ${i + 1}: choose the revenue account`);
    accountIds.push(acct ?? "");
  }
  let calc: ReturnType<typeof computeInvoice> | null = null;
  let ewtRate: string | null = null;
  if (input.ewtTaxCodeId) {
    const tc = await tx.taxCode.findFirst({ where: { id: input.ewtTaxCodeId, organizationId: input.organizationId, isActive: true } });
    if (!tc) errors.push("Withholding tax code not found");
    else ewtRate = tc.rate.toString();
  }
  try {
    calc = computeInvoice(rows.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, vatType: l.vatType })), {
      pricesIncludeVat: !!input.pricesIncludeVat, vatRegistered: org.vatRegistered, ewtRatePct: ewtRate,
    });
    if (calc.total <= 0n) errors.push("The total must be more than zero");
  } catch (e) { errors.push((e as Error).message); }
  if (errors.length || !calc) throw new LedgerError(errors);

  const date = asDay(input.date);
  const termsDays = kind === "CREDIT_MEMO" ? 0 : input.termsDays ?? customer.paymentTermsDays;
  const dueDate = input.dueDate ? asDay(input.dueDate) : addDays(date, termsDays);
  if (dueDate < date) throw new LedgerError(["The due date cannot be before the invoice date"]);
  const c = calc;
  return {
    customer, org, creditFor,
    data: {
      kind, customerId: customer.id, customerName: customer.name, customerTin: customer.tin, customerAddress: customer.address, customerBusinessStyle: customer.businessStyle,
      date, dueDate, termsDays, currencyCode, fxRate: new Prisma.Decimal(fxRate || "1"), pricesIncludeVat: !!input.pricesIncludeVat,
      reference: input.reference?.trim() || null, memo: input.memo?.trim() || null,
      vatableSales: dec(c.vatableSales), vatAmount: dec(c.vatAmount), zeroRatedSales: dec(c.zeroRatedSales), exemptSales: dec(c.exemptSales),
      discountAmount: dec(c.discount), totalAmount: dec(c.total), ewtTaxCodeId: input.ewtTaxCodeId || null, ewtAmount: dec(c.ewt),
      creditForId: creditFor?.id ?? null, reason: input.reason?.trim() || null,
      source: input.source ?? "MANUAL", sourceRef: input.sourceRef ?? null, contractId: input.contractId ?? null,
    },
    lines: rows.map((l, i) => {
      const p = products.find((x) => x.id === l.productId);
      return {
        lineNo: i + 1, productId: p?.id ?? null, description: l.description?.trim() || p?.name || "", quantity: new Prisma.Decimal(String(l.quantity).replace(/,/g, "")),
        unit: l.unit?.trim() || p?.unit || null, unitPrice: new Prisma.Decimal(String(l.unitPrice).replace(/,/g, "")), discount: dec(toCentavos(l.discount ?? "0")),
        vatType: org.vatRegistered ? l.vatType : "EXEMPT", accountId: accountIds[i], netAmount: dec(c.lines[i].net), vatAmount: dec(c.lines[i].vat),
        dims: (l.dims ?? {}) as Prisma.InputJsonValue,
      };
    }),
  };
}

const docLabel = (kind: string) => (kind === "CREDIT_MEMO" ? "Credit memo" : "Sales invoice");

/** GL lines: Dr AR / Cr revenue + output VAT (a credit memo is the mirror image). */
async function invoiceJournalLines(tx: Tx, inv: Invoice): Promise<LineInput[]> {
  const ar = await requireRole(tx, inv.organizationId, "AR_CONTROL", "accounts receivable");
  const cm = inv.kind === "CREDIT_MEMO";
  const [dr, cr] = cm ? (["credit", "debit"] as const) : (["debit", "credit"] as const);
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: inv.customerId } });
  const party = { partyType: "CUSTOMER", partyId: customer.code };
  const cur = { currencyCode: inv.currencyCode, fxRate: inv.fxRate.toString() };
  const label = `${docLabel(inv.kind)} ${inv.number ?? "(draft)"} - ${inv.customerName}`;
  const out: LineInput[] = [{ accountId: ar.id, [dr]: inv.totalAmount.toString(), description: label, ...cur, ...party }];
  const groups = new Map<string, { accountId: string; amount: bigint; dims: Dims; descr: string[] }>();
  for (const l of inv.lines) {
    const key = `${l.accountId}|${JSON.stringify(l.dims ?? {})}`;
    const g = groups.get(key) ?? { accountId: l.accountId, amount: 0n, dims: (l.dims ?? {}) as Dims, descr: [] };
    g.amount += cents(l.netAmount);
    g.descr.push(l.description);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (g.amount === 0n) continue;
    out.push({ accountId: g.accountId, [cr]: fromCentavos(g.amount), description: g.descr.join("; ").slice(0, 200), dims: g.dims, ...cur, ...party });
  }
  const vat = cents(inv.vatAmount);
  if (vat > 0n) {
    const ov = await requireRole(tx, inv.organizationId, "OUTPUT_VAT", "output VAT");
    out.push({ accountId: ov.id, [cr]: fromCentavos(vat), description: `Output VAT - ${label}`, ...cur, ...party });
  }
  return out;
}

async function baseTotal(tx: Tx, organizationId: string, amount: bigint, rate: string) {
  void organizationId;
  return convert(amount, parseRate(rate) ?? 1_000_000n);
}

export async function saveInvoice(input: InvoiceInput, id?: string) {
  return prisma.$transaction((tx) => saveInvoiceTx(tx, input, id));
}

export async function saveInvoiceTx(tx: Tx, input: InvoiceInput, id?: string) {
  const p = await prepareInvoice(tx, input);
  const action = input.action ?? "draft";
  let inv: Invoice;
  if (id) {
    const cur = await tx.salesInvoice.findFirst({ where: { id, organizationId: input.organizationId }, include: { lines: true } });
    if (!cur) throw new LedgerError(["Document not found"]);
    if (cur.status !== "DRAFT") throw new LedgerError(["Only drafts can be edited. Void an issued invoice and issue a new one, or issue a credit memo."]);
    if (cur.kind !== p.data.kind) throw new LedgerError(["The document type cannot change"]);
    await tx.salesInvoiceLine.deleteMany({ where: { invoiceId: id } });
    inv = await tx.salesInvoice.update({ where: { id }, data: { ...p.data, updatedById: input.userId, lines: { create: p.lines } }, include: { lines: true } });
    await audit(tx, input.organizationId, input.userId, "ar.update", id, { kind: inv.kind }, json(cur), json(inv), "sales_invoice");
  } else {
    inv = await tx.salesInvoice.create({ data: { ...p.data, organizationId: input.organizationId, createdById: input.userId, lines: { create: p.lines } }, include: { lines: true } });
    await audit(tx, input.organizationId, input.userId, "ar.create", inv.id, { kind: inv.kind, source: inv.source }, null, json(inv), "sales_invoice");
  }
  await invoiceJournalLines(tx, inv); // fail now if a control account is missing
  if (action === "submit") inv = await submitInvoiceTx(tx, input.organizationId, input.userId, inv);
  if (action === "post") {
    if (p.org.requireApproval) throw new LedgerError(["This company requires approval: submit the document for approval instead"]);
    await assertCanApprove(tx, input.organizationId, input.userId, p.org.segregationOfDuties ? [input.userId] : [], await baseTotal(tx, input.organizationId, cents(inv.totalAmount), inv.fxRate.toString()));
    inv = await postInvoiceTx(tx, inv, input.userId);
  }
  return inv;
}

async function loadInvoice(tx: Tx, organizationId: string, id: string) {
  const inv = await tx.salesInvoice.findFirst({ where: { id, organizationId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!inv) throw new LedgerError(["Document not found"]);
  return inv;
}

async function submitInvoiceTx(tx: Tx, organizationId: string, userId: string, inv: Invoice) {
  if (inv.status !== "DRAFT") throw new LedgerError(["Only drafts can be submitted"]);
  const r = await tx.salesInvoice.update({ where: { id: inv.id }, data: { status: "PENDING_APPROVAL", submittedById: userId, submittedAt: new Date(), rejectReason: null }, include: { lines: true } });
  await audit(tx, organizationId, userId, "ar.submit", inv.id, { kind: inv.kind }, null, null, "sales_invoice");
  return r;
}

export async function submitInvoice(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => submitInvoiceTx(tx, organizationId, userId, await loadInvoice(tx, organizationId, id)));
}

/** Issue: assign the BIR serial, post to the GL, and apply a credit memo to the invoice it corrects. */
async function postInvoiceTx(tx: Tx, inv: Invoice, userId: string) {
  const cm = inv.kind === "CREDIT_MEMO";
  const serial = inv.number ? { number: inv.number, seriesId: inv.seriesId } : await assignSerial(tx, inv.organizationId, cm ? "CREDIT_MEMO" : "SALES_INVOICE", inv.date);
  const dup = await tx.salesInvoice.findFirst({ where: { organizationId: inv.organizationId, kind: inv.kind, number: serial.number, id: { not: inv.id } } });
  if (dup) throw new LedgerError([`${docLabel(inv.kind)} no. ${serial.number} is already used. Check the next serial of the invoice series.`]);
  const numbered = { ...inv, number: serial.number };
  const e = await recordJournalTx(tx, {
    organizationId: inv.organizationId, userId, date: inv.date, memo: `${docLabel(inv.kind)} ${serial.number} - ${inv.customerName}${inv.memo ? `: ${inv.memo}` : ""}`.slice(0, 500),
    reference: `${cm ? "CM" : "SI"} ${serial.number}`, lines: await invoiceJournalLines(tx, numbered), source: "SALES", sourceId: inv.id, action: "post",
  });
  const now = new Date();
  const r = await tx.salesInvoice.updateMany({
    where: { id: inv.id, status: inv.status },
    data: { status: "POSTED", number: serial.number, seriesId: serial.seriesId, journalEntryId: e.id, approvedById: userId, approvedAt: now, submittedById: inv.submittedById ?? userId, submittedAt: inv.submittedAt ?? now, rejectReason: null },
  });
  if (r.count !== 1) throw new LedgerError(["This document was changed by someone else; refresh and try again"]);
  await audit(tx, inv.organizationId, userId, "ar.post", inv.id, { number: serial.number, journal: e.number }, null, null, "sales_invoice");
  if (cm && inv.creditForId) {
    const target = await tx.salesInvoice.findUniqueOrThrow({ where: { id: inv.creditForId } });
    const open = cents(target.totalAmount) - cents(target.appliedAmount);
    const amt = open < cents(inv.totalAmount) ? open : cents(inv.totalAmount);
    if (amt > 0n && target.status === "POSTED") await applyTx(tx, inv.organizationId, userId, { creditMemoId: inv.id }, [{ invoiceId: target.id, amount: amt }], inv.date);
  }
  return tx.salesInvoice.findUniqueOrThrow({ where: { id: inv.id }, include: { lines: true } });
}

export async function approveInvoice(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const inv = await loadInvoice(tx, organizationId, id);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (inv.status === "POSTED" || inv.status === "VOID") throw new LedgerError([`This document is already ${inv.status === "POSTED" ? "issued" : "void"}`]);
    if (inv.status === "DRAFT" && org.requireApproval) throw new LedgerError(["Submit the document for approval first"]);
    await assertCanApprove(tx, organizationId, userId, [inv.createdById, inv.submittedById, inv.updatedById], await baseTotal(tx, organizationId, cents(inv.totalAmount), inv.fxRate.toString()));
    return postInvoiceTx(tx, inv, userId);
  });
}

async function assertApprover(tx: Tx, organizationId: string, userId: string) {
  const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  if (!m || !can(m.role, "journal.post")) throw new LedgerError(["You do not have rights to approve or return documents"]);
}

export async function rejectInvoice(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const inv = await loadInvoice(tx, organizationId, id);
    if (inv.status !== "PENDING_APPROVAL") throw new LedgerError(["Only documents waiting for approval can be returned"]);
    await assertApprover(tx, organizationId, userId);
    if (!reason.trim()) throw new LedgerError(["Give a reason so the preparer knows what to fix"]);
    await tx.salesInvoice.update({ where: { id }, data: { status: "DRAFT", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "ar.reject", id, { reason: reason.trim() }, null, null, "sales_invoice");
  });
}

/**
 * Void. A draft just becomes void. An issued invoice keeps its serial (BIR requires cancelled
 * invoices to stay in the series) and its GL entry is reversed. Collections applied to it must be
 * voided first; a credit memo's applications are released.
 */
export async function voidInvoice(organizationId: string, userId: string, id: string, reason: string, reversalDate?: Date) {
  return prisma.$transaction(async (tx) => {
    const inv = await loadInvoice(tx, organizationId, id);
    if (inv.status === "VOID") throw new LedgerError(["Already void"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason for voiding (e.g. cancelled sale, wrong customer)"]);
    if (inv.status === "POSTED") {
      if (inv.kind === "INVOICE") {
        const apps = await tx.arApplication.findMany({ where: { invoiceId: id } });
        if (apps.length) throw new LedgerError(["Payments or credit memos are applied to this invoice. Void those collections / credit memos first, or issue a credit memo instead."]);
      } else {
        for (const a of await tx.arApplication.findMany({ where: { creditMemoId: id } })) {
          await tx.salesInvoice.update({ where: { id: a.invoiceId }, data: { appliedAmount: { decrement: a.amount } } });
          await tx.arApplication.delete({ where: { id: a.id } });
        }
        await tx.salesInvoice.update({ where: { id }, data: { appliedAmount: 0 } });
      }
      if (inv.journalEntryId) await voidOrReverseTx(tx, organizationId, userId, inv.journalEntryId, reversalDate ?? inv.date, true);
    }
    await tx.salesInvoice.update({ where: { id }, data: { status: "VOID", voidedById: userId, voidedAt: new Date(), voidReason: reason.trim() } });
    await tx.billingMilestone.updateMany({ where: { invoiceId: id }, data: { invoiceId: null, billedAt: null } });
    await audit(tx, organizationId, userId, "ar.void", id, { number: inv.number, reason: reason.trim() }, null, null, "sales_invoice");
  });
}

// ---------- Applying payments and credits ----------

type Alloc = { invoiceId: string; amount: bigint };

/** Check allocations against open invoices of the customer, in the document's currency. */
async function checkAllocations(tx: Tx, organizationId: string, customerId: string, currencyCode: string, allocs: Alloc[], available: bigint) {
  const errors: string[] = [];
  const invs = await tx.salesInvoice.findMany({ where: { organizationId, id: { in: allocs.map((a) => a.invoiceId) } } });
  let sum = 0n;
  const seen = new Set<string>();
  for (const a of allocs) {
    const inv = invs.find((i) => i.id === a.invoiceId);
    if (seen.has(a.invoiceId)) errors.push("An invoice appears twice");
    seen.add(a.invoiceId);
    if (!inv || inv.kind !== "INVOICE") { errors.push("Invoice not found"); continue; }
    const tag = `SI ${inv.number ?? "(draft)"}`;
    if (inv.customerId !== customerId) errors.push(`${tag} belongs to another customer`);
    if (inv.status !== "POSTED") errors.push(`${tag} is not issued`);
    if (inv.currencyCode !== currencyCode) errors.push(`${tag} is in ${inv.currencyCode}; the payment is in ${currencyCode}`);
    const open = cents(inv.totalAmount) - cents(inv.appliedAmount);
    if (a.amount <= 0n) errors.push(`${tag}: enter a positive amount`);
    if (a.amount > open) errors.push(`${tag}: only ${fmt(open)} is still open`);
    sum += a.amount;
  }
  if (sum > available) errors.push(`The amounts applied (${fmt(sum)}) are more than the payment / credit available (${fmt(available)})`);
  if (errors.length) throw new LedgerError(errors);
  return { invs, sum };
}

async function applyTx(tx: Tx, organizationId: string, userId: string, from: { receiptId?: string; creditMemoId?: string }, allocs: Alloc[], date: Date, journalEntryId?: string | null) {
  for (const a of allocs) {
    await tx.arApplication.create({ data: { organizationId, invoiceId: a.invoiceId, ...from, amount: dec(a.amount), date: asDay(date), journalEntryId: journalEntryId ?? null, createdById: userId } });
    await tx.salesInvoice.update({ where: { id: a.invoiceId }, data: { appliedAmount: { increment: dec(a.amount) } } });
  }
  const total = allocs.reduce((s, a) => s + a.amount, 0n);
  if (from.receiptId) await tx.arReceipt.update({ where: { id: from.receiptId }, data: { appliedAmount: { increment: dec(total) } } });
  if (from.creditMemoId) await tx.salesInvoice.update({ where: { id: from.creditMemoId }, data: { appliedAmount: { increment: dec(total) } } });
}

/** Base-currency amount of foreign lines, the same way the GL converts them. */
const toBase = (amount: bigint, rate: string) => convert(amount, parseRate(rate) ?? 1_000_000n);

async function fxLine(tx: Tx, organizationId: string, baseCurrency: string, diff: bigint, what: string): Promise<LineInput[]> {
  if (diff === 0n) return [];
  // diff = base debits - base credits before this line. Debits higher -> credit a gain.
  const gain = diff > 0n;
  const acct = await requireRole(tx, organizationId, gain ? "FX_GAIN" : "FX_LOSS", gain ? "realized FX gain" : "realized FX loss");
  return [{ accountId: acct.id, [gain ? "credit" : "debit"]: fromCentavos(gain ? diff : -diff), currencyCode: baseCurrency, description: `Realized foreign exchange difference - ${what}` }];
}

/**
 * Apply an unapplied payment (customer advance) or an unapplied credit memo to open invoices.
 * A payment moves from Advances from Customers to AR with a journal; a credit memo needs none
 * (it already credited AR).
 */
export async function applyCredit(organizationId: string, userId: string, source: { receiptId?: string; creditMemoId?: string }, allocations: { invoiceId: string; amount: string }[], date: Date) {
  return prisma.$transaction(async (tx) => {
    const allocs = allocations.map((a) => ({ invoiceId: a.invoiceId, amount: toCentavos(a.amount) })).filter((a) => a.amount !== 0n);
    if (!allocs.length) throw new LedgerError(["Enter the amount to apply to at least one invoice"]);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (source.creditMemoId) {
      const cm = await tx.salesInvoice.findFirst({ where: { id: source.creditMemoId, organizationId, kind: "CREDIT_MEMO" } });
      if (!cm || cm.status !== "POSTED") throw new LedgerError(["Only an issued credit memo can be applied"]);
      const avail = cents(cm.totalAmount) - cents(cm.appliedAmount);
      await checkAllocations(tx, organizationId, cm.customerId, cm.currencyCode, allocs, avail);
      if (asDay(date) < cm.date) throw new LedgerError(["The application date cannot be before the credit memo date"]);
      await applyTx(tx, organizationId, userId, { creditMemoId: cm.id }, allocs, date);
      await audit(tx, organizationId, userId, "ar.apply", cm.id, { count: allocs.length }, null, null, "sales_invoice");
      return;
    }
    const r = await tx.arReceipt.findFirst({ where: { id: source.receiptId, organizationId } });
    if (!r || r.status !== "POSTED") throw new LedgerError(["Only a posted collection can be applied"]);
    const avail = cents(r.cashAmount) + cents(r.withholdingAmount) - cents(r.appliedAmount);
    const { invs } = await checkAllocations(tx, organizationId, r.customerId, r.currencyCode, allocs, avail);
    if (asDay(date) < r.date) throw new LedgerError(["The application date cannot be before the collection date"]);
    const adv = await requireRole(tx, organizationId, "CUSTOMER_ADVANCES", "advances from customers");
    const ar = await requireRole(tx, organizationId, "AR_CONTROL", "accounts receivable");
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: r.customerId } });
    const party = { partyType: "CUSTOMER", partyId: customer.code };
    const total = allocs.reduce((s, a) => s + a.amount, 0n);
    const lines: LineInput[] = [{ accountId: adv.id, debit: fromCentavos(total), currencyCode: r.currencyCode, fxRate: r.fxRate.toString(), description: `Advance ${r.number} applied`, ...party }];
    let diff = toBase(total, r.fxRate.toString());
    for (const a of allocs) {
      const inv = invs.find((i) => i.id === a.invoiceId)!;
      lines.push({ accountId: ar.id, credit: fromCentavos(a.amount), currencyCode: inv.currencyCode, fxRate: inv.fxRate.toString(), description: `SI ${inv.number} paid from advance ${r.number}`, ...party });
      diff -= toBase(a.amount, inv.fxRate.toString());
    }
    lines.push(...(await fxLine(tx, organizationId, org.baseCurrency, diff, `advance ${r.number}`)));
    const e = await recordJournalTx(tx, {
      organizationId, userId, date, memo: `Apply customer advance ${r.number} - ${r.customerName}`, reference: `OR ${r.number}`, lines, source: "SALES", sourceId: r.id, action: "post",
    });
    await applyTx(tx, organizationId, userId, { receiptId: r.id }, allocs, date, e.id);
    await audit(tx, organizationId, userId, "ar.apply", r.id, { count: allocs.length, journal: e.number }, null, null, "ar_receipt");
  });
}

// ---------- Collections ----------

export const METHODS = { CASH: "Cash", CHECK: "Check", BANK_TRANSFER: "Bank transfer / InstaPay / PESONet", ONLINE: "Online / card", EWALLET: "GCash / Maya" } as const;

export type ReceiptInput = {
  organizationId: string; userId: string; customerId: string; date: Date; bankAccountId: string; method?: string | null;
  checkNo?: string | null; checkDate?: Date | null; checkBank?: string | null; reference?: string | null; memo?: string | null; fxRate?: string | null;
  cashAmount: string; withholdingTaxCodeId?: string | null; withholdingAmount?: string | null;
  applications: { invoiceId: string; amount: string }[]; action?: Action;
};

type Receipt = Prisma.ArReceiptGetPayload<object>;
type Plan = { invoiceId: string; amount: string }[];

async function prepareReceipt(tx: Tx, input: ReceiptInput) {
  const errors: string[] = [];
  const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
  const customer = await tx.customer.findFirst({ where: { id: input.customerId, organizationId: input.organizationId } });
  if (!customer) throw new LedgerError(["Choose the customer who paid"]);
  const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, organizationId: input.organizationId } });
  if (!bank) throw new LedgerError(["Choose the bank or cash account the money went to"]);
  if (!bank.isActive) errors.push(`${bank.name} is inactive`);
  const method = (input.method || "CASH").toUpperCase();
  if (!(method in METHODS)) errors.push("Choose how the customer paid");
  if (method === "CHECK" && !input.checkNo?.trim()) errors.push("Enter the customer's check number");
  const foreign = bank.currencyCode !== org.baseCurrency;
  const fxRate = foreign ? input.fxRate?.trim() || "" : "1";
  if (foreign && !((parseRate(fxRate) ?? 0n) > 0n)) errors.push(`Enter the exchange rate for ${bank.currencyCode}`);
  let cash = 0n, wht = 0n;
  try { cash = toCentavos(input.cashAmount); } catch (e) { errors.push(`Amount received: ${(e as Error).message}`); }
  try { wht = toCentavos(input.withholdingAmount ?? "0"); } catch (e) { errors.push(`Tax withheld: ${(e as Error).message}`); }
  if (cash < 0n || wht < 0n) errors.push("Amounts cannot be negative");
  if (cash + wht <= 0n) errors.push("Enter the amount received");
  if (wht > 0n && !input.withholdingTaxCodeId) errors.push("Choose the withholding tax code on the customer's BIR 2307");
  if (input.withholdingTaxCodeId && !(await tx.taxCode.findFirst({ where: { id: input.withholdingTaxCodeId, organizationId: input.organizationId } }))) errors.push("Withholding tax code not found");
  const plan: Plan = [];
  for (const a of input.applications ?? []) {
    try { const c = toCentavos(a.amount); if (c !== 0n) plan.push({ invoiceId: a.invoiceId, amount: fromCentavos(c) }); } catch (e) { errors.push((e as Error).message); }
  }
  if (errors.length) throw new LedgerError(errors);
  await checkAllocations(tx, input.organizationId, customer.id, bank.currencyCode, plan.map((p) => ({ invoiceId: p.invoiceId, amount: toCentavos(p.amount) })), cash + wht);
  return {
    org, bank,
    data: {
      customerId: customer.id, customerName: customer.name, date: asDay(input.date), bankAccountId: bank.id, method,
      checkNo: input.checkNo?.trim() || null, checkDate: input.checkDate ? asDay(input.checkDate) : null, checkBank: input.checkBank?.trim() || null,
      reference: input.reference?.trim() || null, memo: input.memo?.trim() || null, currencyCode: bank.currencyCode, fxRate: new Prisma.Decimal(fxRate || "1"),
      cashAmount: dec(cash), withholdingTaxCodeId: wht > 0n ? input.withholdingTaxCodeId || null : null, withholdingAmount: dec(wht), plan: plan as Prisma.InputJsonValue,
    },
  };
}

/** Dr bank (cash) + CWT / Cr AR per invoice (at the invoice's rate) + advances (unapplied), with any FX difference. */
async function receiptJournalLines(tx: Tx, r: Receipt): Promise<LineInput[]> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: r.organizationId } });
  const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: r.bankAccountId } });
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: r.customerId } });
  const party = { partyType: "CUSTOMER", partyId: customer.code };
  const rate = r.fxRate.toString();
  const cur = { currencyCode: r.currencyCode, fxRate: rate };
  const tag = `OR ${r.number ?? "(draft)"} - ${r.customerName}`;
  const cash = cents(r.cashAmount), wht = cents(r.withholdingAmount);
  const lines: LineInput[] = [];
  let diff = 0n;
  if (cash > 0n) { lines.push({ accountId: bank.glAccountId, debit: fromCentavos(cash), description: tag, ...cur, ...party }); diff += toBase(cash, rate); }
  if (wht > 0n) {
    const cwt = await requireRole(tx, r.organizationId, "CWT_RECEIVABLE", "creditable withholding tax");
    lines.push({ accountId: cwt.id, debit: fromCentavos(wht), description: `Creditable withholding tax (BIR 2307) - ${tag}`, ...cur, ...party });
    diff += toBase(wht, rate);
  }
  const plan = r.plan as Plan;
  const ar = await requireRole(tx, r.organizationId, "AR_CONTROL", "accounts receivable");
  const invs = await tx.salesInvoice.findMany({ where: { id: { in: plan.map((p) => p.invoiceId) } } });
  let applied = 0n;
  for (const p of plan) {
    const inv = invs.find((i) => i.id === p.invoiceId);
    if (!inv) throw new LedgerError(["An invoice in this collection no longer exists"]);
    const amt = toCentavos(p.amount);
    applied += amt;
    lines.push({ accountId: ar.id, credit: p.amount, currencyCode: inv.currencyCode, fxRate: inv.fxRate.toString(), description: `Payment of SI ${inv.number} - ${r.customerName}`, ...party });
    diff -= toBase(amt, inv.fxRate.toString());
  }
  const unapplied = cash + wht - applied;
  if (unapplied > 0n) {
    const adv = await requireRole(tx, r.organizationId, "CUSTOMER_ADVANCES", "advances from customers");
    lines.push({ accountId: adv.id, credit: fromCentavos(unapplied), description: `Unapplied payment / advance - ${tag}`, ...cur, ...party });
    diff -= toBase(unapplied, rate);
  }
  lines.push(...(await fxLine(tx, r.organizationId, org.baseCurrency, diff, tag)));
  return lines;
}

export async function saveReceipt(input: ReceiptInput, id?: string) {
  return prisma.$transaction(async (tx) => {
    const p = await prepareReceipt(tx, input);
    let r: Receipt;
    if (id) {
      const cur = await tx.arReceipt.findFirst({ where: { id, organizationId: input.organizationId } });
      if (!cur) throw new LedgerError(["Collection not found"]);
      if (cur.status !== "DRAFT") throw new LedgerError(["Only drafts can be edited. Void a posted collection and record it again."]);
      r = await tx.arReceipt.update({ where: { id }, data: { ...p.data, updatedById: input.userId } });
      await audit(tx, input.organizationId, input.userId, "ar.update", id, null, json(cur), json(r), "ar_receipt");
    } else {
      r = await tx.arReceipt.create({ data: { ...p.data, organizationId: input.organizationId, createdById: input.userId } });
      await audit(tx, input.organizationId, input.userId, "ar.create", r.id, null, null, json(r), "ar_receipt");
    }
    await receiptJournalLines(tx, r);
    const action = input.action ?? "draft";
    if (action === "submit") {
      r = await tx.arReceipt.update({ where: { id: r.id }, data: { status: "PENDING_APPROVAL", submittedById: input.userId, submittedAt: new Date(), rejectReason: null } });
      await audit(tx, input.organizationId, input.userId, "ar.submit", r.id, null, null, null, "ar_receipt");
    }
    if (action === "post") {
      if (p.org.requireApproval) throw new LedgerError(["This company requires approval: submit the collection for approval instead"]);
      await assertCanApprove(tx, input.organizationId, input.userId, p.org.segregationOfDuties ? [input.userId] : [], toBase(cents(r.cashAmount) + cents(r.withholdingAmount), r.fxRate.toString()));
      r = await postReceiptTx(tx, r, input.userId);
    }
    return r;
  });
}

async function loadReceipt(tx: Tx, organizationId: string, id: string) {
  const r = await tx.arReceipt.findFirst({ where: { id, organizationId } });
  if (!r) throw new LedgerError(["Collection not found"]);
  return r;
}

async function postReceiptTx(tx: Tx, r: Receipt, userId: string) {
  await assertNotReconciled(tx, r.organizationId, [r.bankAccountId], r.date);
  // Re-check the invoices: another collection may have paid them since this draft was saved.
  const plan = (r.plan as Plan).map((p) => ({ invoiceId: p.invoiceId, amount: toCentavos(p.amount) }));
  await checkAllocations(tx, r.organizationId, r.customerId, r.currencyCode, plan, cents(r.cashAmount) + cents(r.withholdingAmount));
  const serial = r.number ? { number: r.number, seriesId: r.seriesId } : await assignSerial(tx, r.organizationId, "COLLECTION_RECEIPT", r.date);
  const numbered = { ...r, number: serial.number };
  const e = await recordJournalTx(tx, {
    organizationId: r.organizationId, userId, date: r.date, memo: `Collection ${serial.number} - ${r.customerName}${r.memo ? `: ${r.memo}` : ""}`.slice(0, 500),
    reference: [`OR ${serial.number}`, r.checkNo ? `Check ${r.checkNo}` : null, r.reference].filter(Boolean).join(" / "),
    lines: await receiptJournalLines(tx, numbered), source: "SALES", sourceId: r.id, action: "post",
  });
  const now = new Date();
  const u = await tx.arReceipt.updateMany({
    where: { id: r.id, status: r.status },
    data: { status: "POSTED", number: serial.number, seriesId: serial.seriesId, journalEntryId: e.id, approvedById: userId, approvedAt: now, submittedById: r.submittedById ?? userId, submittedAt: r.submittedAt ?? now, rejectReason: null },
  });
  if (u.count !== 1) throw new LedgerError(["This collection was changed by someone else; refresh and try again"]);
  await applyTx(tx, r.organizationId, userId, { receiptId: r.id }, plan, r.date, e.id);
  await audit(tx, r.organizationId, userId, "ar.post", r.id, { number: serial.number, journal: e.number }, null, null, "ar_receipt");
  return tx.arReceipt.findUniqueOrThrow({ where: { id: r.id } });
}

export async function submitReceipt(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const r = await loadReceipt(tx, organizationId, id);
    if (r.status !== "DRAFT") throw new LedgerError(["Only drafts can be submitted"]);
    await tx.arReceipt.update({ where: { id }, data: { status: "PENDING_APPROVAL", submittedById: userId, submittedAt: new Date(), rejectReason: null } });
    await audit(tx, organizationId, userId, "ar.submit", id, null, null, null, "ar_receipt");
  });
}

export async function approveReceipt(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const r = await loadReceipt(tx, organizationId, id);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (r.status === "POSTED" || r.status === "VOID") throw new LedgerError([`Collection is already ${r.status.toLowerCase()}`]);
    if (r.status === "DRAFT" && org.requireApproval) throw new LedgerError(["Submit the collection for approval first"]);
    await assertCanApprove(tx, organizationId, userId, [r.createdById, r.submittedById, r.updatedById], toBase(cents(r.cashAmount) + cents(r.withholdingAmount), r.fxRate.toString()));
    return postReceiptTx(tx, r, userId);
  });
}

export async function rejectReceipt(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const r = await loadReceipt(tx, organizationId, id);
    if (r.status !== "PENDING_APPROVAL") throw new LedgerError(["Only collections waiting for approval can be returned"]);
    await assertApprover(tx, organizationId, userId);
    if (!reason.trim()) throw new LedgerError(["Give a reason so the preparer knows what to fix"]);
    await tx.arReceipt.update({ where: { id }, data: { status: "DRAFT", rejectReason: reason.trim() } });
    await audit(tx, organizationId, userId, "ar.reject", id, { reason: reason.trim() }, null, null, "ar_receipt");
  });
}

/**
 * Void a collection (e.g. a bounced check). The GL entry and any later advance applications are
 * reversed, the invoices it paid become open again, and the original and reversal bank lines
 * clear each other so nothing shows as a deposit in transit.
 */
export async function voidReceipt(organizationId: string, userId: string, id: string, reason: string, reversalDate?: Date) {
  return prisma.$transaction(async (tx) => {
    const r = await loadReceipt(tx, organizationId, id);
    if (r.status === "VOID") throw new LedgerError(["Already void"]);
    if (!reason.trim()) throw new LedgerError(["Give a reason for voiding (e.g. bounced check, wrong customer)"]);
    if (r.status === "POSTED") {
      const date = asDay(reversalDate ?? r.date);
      await assertNotReconciled(tx, organizationId, [r.bankAccountId], date);
      const apps = await tx.arApplication.findMany({ where: { receiptId: id } });
      const laterJournals = [...new Set(apps.map((a) => a.journalEntryId).filter((j) => j && j !== r.journalEntryId))] as string[];
      for (const j of laterJournals) {
        const e = await tx.journalEntry.findUniqueOrThrow({ where: { id: j } });
        await voidOrReverseTx(tx, organizationId, userId, j, date < e.date ? e.date : date, true);
      }
      for (const a of apps) {
        await tx.salesInvoice.update({ where: { id: a.invoiceId }, data: { appliedAmount: { decrement: a.amount } } });
        await tx.arApplication.delete({ where: { id: a.id } });
      }
      if (r.journalEntryId) {
        const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: r.bankAccountId } });
        const rev = await voidOrReverseTx(tx, organizationId, userId, r.journalEntryId, date, true);
        if (rev) {
          const ls = await tx.journalLine.findMany({ where: { journalEntryId: { in: [r.journalEntryId, rev.id] }, accountId: bank.glAccountId, clearedAt: null } });
          if (ls.length) {
            const m = await tx.bankMatch.create({ data: { organizationId, bankAccountId: bank.id, method: "NO_STATEMENT", note: `Voided collection ${r.number}: reversal offsets the original`, createdById: userId } });
            for (const l of ls) await tx.journalLine.update({ where: { id: l.id }, data: { clearedAt: rev.date, clearingRef: m.id } });
          }
        }
      }
    }
    await tx.arReceipt.update({ where: { id }, data: { status: "VOID", appliedAmount: 0, voidedById: userId, voidedAt: new Date(), voidReason: reason.trim() } });
    await audit(tx, organizationId, userId, "ar.void", id, { number: r.number, reason: reason.trim() }, null, null, "ar_receipt");
  });
}

/** Open invoices of a customer, oldest first (for the collection form). */
export async function openInvoices(organizationId: string, customerId: string) {
  const rows = await prisma.salesInvoice.findMany({ where: { organizationId, customerId, kind: "INVOICE", status: "POSTED" }, orderBy: [{ dueDate: "asc" }, { number: "asc" }] });
  return rows.map((i) => ({ ...i, open: cents(i.totalAmount) - cents(i.appliedAmount) })).filter((i) => i.open > 0n);
}

/** Unapplied payments and credit memos of a customer. */
export async function openCredits(organizationId: string, customerId: string) {
  const [rs, cms] = await Promise.all([
    prisma.arReceipt.findMany({ where: { organizationId, customerId, status: "POSTED" }, orderBy: { date: "asc" } }),
    prisma.salesInvoice.findMany({ where: { organizationId, customerId, kind: "CREDIT_MEMO", status: "POSTED" }, orderBy: { date: "asc" } }),
  ]);
  return [
    ...rs.map((r) => ({ type: "RECEIPT" as const, id: r.id, number: r.number, date: r.date, currencyCode: r.currencyCode, open: cents(r.cashAmount) + cents(r.withholdingAmount) - cents(r.appliedAmount) })),
    ...cms.map((c) => ({ type: "CREDIT_MEMO" as const, id: c.id, number: c.number, date: c.date, currencyCode: c.currencyCode, open: cents(c.totalAmount) - cents(c.appliedAmount) })),
  ].filter((c) => c.open > 0n);
}
