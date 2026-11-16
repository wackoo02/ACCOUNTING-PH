// Petty cash vouchers, purchase orders and replenishment batches.
// A batch posts to the general ledger only through recordJournalTx / postJournal.
import { Prisma, type PettyCashStatus } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { can } from "../permissions";
import { LedgerError, asDay, audit, postJournal, recordJournalTx } from "../ledger/service";
import { buildReplenishmentLines, computeVoucher, type AccountInfo, type BatchVoucher, type VoucherLineInput } from "./compute";

type Tx = Prisma.TransactionClient;
const dec = (c: bigint) => new Prisma.Decimal(fromCentavos(c));
const cents = (d: Prisma.Decimal | null | undefined) => toCentavos(d?.toString() ?? "0");
/** Money for the API: always 2 decimals, e.g. "1170.00". */
const m2 = (d: Prisma.Decimal | null | undefined) => fromCentavos(cents(d));

async function nextNumber(tx: Tx, organizationId: string, prefix: string, year: number) {
  const key = `${prefix}-${year}`;
  const seq = await tx.documentSequence.upsert({
    where: { organizationId_key: { organizationId, key } },
    create: { organizationId, key, next: 2 },
    update: { next: { increment: 1 } },
  });
  return `${key}-${String(seq.next - 1).padStart(6, "0")}`;
}

// ---------- Setup data for the app ----------

export async function setupData(organizationId: string) {
  const [org, accounts, taxCodes, vendors, funds, pos, dims] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    prisma.account.findMany({
      where: { organizationId, isActive: true, isPostable: true, OR: [{ type: "EXPENSE" }, { type: "ASSET", ifrsGroup: "Property, plant and equipment" }] },
      orderBy: { code: "asc" }, select: { id: true, code: true, name: true, type: true, ifrsGroup: true },
    }),
    prisma.taxCode.findMany({ where: { organizationId, isActive: true, taxType: { in: ["EWT", "VAT_INPUT"] } }, orderBy: { code: "asc" } }),
    prisma.vendor.findMany({ where: { organizationId, isActive: true }, orderBy: { name: "asc" },
      select: { id: true, code: true, name: true, tin: true, address: true, vatRegistered: true, ewtRate: true, atcCode: true } }),
    prisma.pettyCashFund.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.purchaseOrder.findMany({ where: { organizationId, status: "APPROVED" }, orderBy: { poDate: "desc" }, take: 200 }),
    prisma.dimensionValue.findMany({ where: { organizationId, isActive: true, type: { in: ["DEPARTMENT", "COST_CENTER", "BRANCH", "PROJECT"] } },
      orderBy: [{ type: "asc" }, { code: "asc" }], select: { id: true, type: true, code: true, name: true } }),
  ]);
  return {
    company: { id: org.id, name: org.name, tin: org.tin, vatRegistered: org.vatRegistered, baseCurrency: org.baseCurrency },
    fixedAssetThreshold: org.fixedAssetThreshold.toString(),
    segregationOfDuties: org.segregationOfDuties,
    accounts: accounts.map((a) => ({ ...a, isFixedAsset: a.type === "ASSET" })),
    taxCodes: taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, taxType: t.taxType, rate: t.rate.toString(), atcCode: t.atcCode })),
    vendors: vendors.map((v) => ({ ...v, ewtRate: v.ewtRate.toString() })),
    funds: funds.map((f) => ({ id: f.id, code: f.code, name: f.name, custodianUserId: f.custodianUserId, imprestAmount: m2(f.imprestAmount) })),
    purchaseOrders: pos.map(poOut),
    dimensions: dims,
  };
}

// ---------- Funds ----------

export async function createFund(organizationId: string, userId: string, input: { code: string; name: string; imprestAmount?: string; custodianUserId?: string | null; accountId?: string | null; replenishAccountId?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const code = input.code?.trim().toUpperCase();
    if (!code || !input.name?.trim()) throw new LedgerError(["Enter a code and name for the fund"]);
    let accountId = input.accountId ?? null;
    if (!accountId) {
      const a = await tx.account.findFirst({ where: { organizationId, OR: [{ systemRole: "PETTY_CASH_FUND" }, { code: "1015" }] }, orderBy: { systemRole: "asc" } });
      if (!a) throw new LedgerError(["Choose the GL account for this petty cash fund"]);
      accountId = a.id;
    }
    for (const id of [accountId, input.replenishAccountId].filter(Boolean) as string[]) {
      const a = await tx.account.findFirst({ where: { id, organizationId, isPostable: true, isActive: true } });
      if (!a) throw new LedgerError(["The fund's account must be an active posting account of this company"]);
    }
    if (input.custodianUserId) {
      const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId: input.custodianUserId, organizationId } } });
      if (!m) throw new LedgerError(["The custodian must be a user of this company"]);
    }
    const f = await tx.pettyCashFund.create({ data: {
      organizationId, code, name: input.name.trim(), accountId, replenishAccountId: input.replenishAccountId || null,
      custodianUserId: input.custodianUserId || null, imprestAmount: dec(toCentavos(input.imprestAmount ?? "0")),
    } });
    await audit(tx, organizationId, userId, "pettycash.fund_create", f.id, { code }, null, JSON.parse(JSON.stringify(f)), "pettycash_fund");
    return f;
  });
}

// ---------- Purchase orders ----------

const poOut = (p: Prisma.PurchaseOrderGetPayload<object>) => ({
  id: p.id, number: p.number, poDate: p.poDate.toISOString().slice(0, 10), vendorId: p.vendorId, vendorName: p.vendorName,
  description: p.description, amount: m2(p.amount), status: p.status, approvedById: p.approvedById, approvedAt: p.approvedAt,
});

export async function createPurchaseOrder(organizationId: string, userId: string, input: { number?: string | null; poDate?: string | null; vendorId?: string | null; vendorName?: string | null; description: string; amount: string }) {
  return prisma.$transaction(async (tx) => {
    if (!input.description?.trim()) throw new LedgerError(["Describe what the PO is for"]);
    const amount = toCentavos(input.amount);
    if (amount <= 0n) throw new LedgerError(["PO amount must be more than zero"]);
    const date = asDay(input.poDate || new Date());
    const number = input.number?.trim() || (await nextNumber(tx, organizationId, "PO", date.getUTCFullYear()));
    if (await tx.purchaseOrder.findUnique({ where: { organizationId_number: { organizationId, number } } })) throw new LedgerError([`PO ${number} already exists`]);
    const p = await tx.purchaseOrder.create({ data: {
      organizationId, number, poDate: date, vendorId: input.vendorId || null, vendorName: input.vendorName?.trim() || null,
      description: input.description.trim(), amount: dec(amount), createdById: userId,
    } });
    await audit(tx, organizationId, userId, "po.create", p.id, { number }, null, null, "purchase_order");
    return poOut(p);
  });
}

export async function approvePurchaseOrder(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.purchaseOrder.findFirst({ where: { id, organizationId } });
    if (!p) throw new LedgerError(["PO not found"]);
    if (p.status !== "DRAFT") throw new LedgerError([`PO is already ${p.status.toLowerCase()}`]);
    await assertApprover(tx, organizationId, userId, [p.createdById], cents(p.amount), "PO");
    const after = await tx.purchaseOrder.update({ where: { id }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() } });
    await audit(tx, organizationId, userId, "po.approve", id, { number: p.number }, null, null, "purchase_order");
    return poOut(after);
  });
}

export async function listPurchaseOrders(organizationId: string, status?: string | null) {
  const where: Prisma.PurchaseOrderWhereInput = { organizationId };
  if (status) where.status = status as Prisma.EnumPurchaseOrderStatusFilter["equals"];
  return (await prisma.purchaseOrder.findMany({ where, orderBy: { poDate: "desc" }, take: 200 })).map(poOut);
}

// ---------- Approval controls ----------

/** Approver must hold pettycash.approve, respect segregation of duties and their approval limit. */
async function assertApprover(tx: Tx, organizationId: string, userId: string, preparerIds: (string | null)[], amount: bigint, what: string) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  if (!m || !can(m.role, "pettycash.approve")) throw new LedgerError([`You do not have rights to approve this ${what}`]);
  if (org.segregationOfDuties && preparerIds.includes(userId)) throw new LedgerError([`Segregation of duties: someone other than the preparer must approve this ${what}`]);
  if (m.approvalLimit !== null && amount > cents(m.approvalLimit)) {
    throw new LedgerError([`This ${what} (PHP ${fromCentavos(amount)}) is above your approval limit of PHP ${fromCentavos(cents(m.approvalLimit))}`]);
  }
}

// ---------- Vouchers ----------

export type VoucherInput = {
  fundId: string;
  receiptDate: string;
  docType?: string | null;
  docNumber?: string | null;
  vendorId?: string | null;
  vendorName: string;
  vendorTin?: string | null;
  vendorAddress?: string | null;
  vendorVatRegistered?: boolean | null;
  description?: string | null;
  vatAmount?: string | null;
  vatExemptAmount?: string | null;
  zeroRatedAmount?: string | null;
  ewtTaxCodeId?: string | null;
  tipAmount?: string | null;
  tipHandwritten?: boolean | null;
  poNumber?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  branchId?: string | null;
  projectId?: string | null;
  imageId?: string | null;
  extraction?: unknown;
  lines: (VoucherLineInput & { suggestedAccountId?: string | null })[];
};

const TIN_RE = /^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$/;
const DOC_TYPES = ["OR", "SI", "CASH_INVOICE", "AR", "OTHER"];

/** Validate and compute a voucher without saving it (the app calls this as a preview). */
export async function evaluateVoucher(tx: Tx, organizationId: string, input: VoucherInput) {
  const errors: string[] = [];
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const fund = await tx.pettyCashFund.findFirst({ where: { id: input.fundId ?? "", organizationId, isActive: true } });
  if (!fund) errors.push("Choose a petty cash fund");
  if (!input.vendorName?.trim()) errors.push("Enter the supplier's name");
  const tin = input.vendorTin?.trim() || null;
  if (tin && !TIN_RE.test(tin)) errors.push("Supplier TIN should look like 000-000-000-000");
  const docType = (input.docType || "OR").toUpperCase();
  if (!DOC_TYPES.includes(docType)) errors.push(`Document type must be one of ${DOC_TYPES.join(", ")}`);
  if (!input.receiptDate || Number.isNaN(Date.parse(input.receiptDate))) errors.push("Enter the receipt date");

  let vendor = input.vendorId ? await tx.vendor.findFirst({ where: { id: input.vendorId, organizationId } }) : null;
  if (input.vendorId && !vendor) errors.push("Supplier not found");
  if (!vendor && tin) vendor = await tx.vendor.findFirst({ where: { organizationId, tin: { in: [tin, tin.replace(/-/g, "")] } } });

  const ids = [...new Set((input.lines ?? []).map((l) => l.accountId).filter(Boolean))];
  const accts = await tx.account.findMany({ where: { organizationId, id: { in: ids }, isActive: true, isPostable: true } });
  const accounts = new Map<string, AccountInfo>(accts.map((a) => [a.id, { id: a.id, code: a.code, name: a.name, type: a.type, ifrsGroup: a.ifrsGroup }]));

  let ewtRate: string | null = null, ewtAccountId: string | null = null;
  if (input.ewtTaxCodeId) {
    const t = await tx.taxCode.findFirst({ where: { id: input.ewtTaxCodeId, organizationId, taxType: "EWT", isActive: true } });
    if (!t) errors.push("EWT tax code not found");
    else {
      ewtRate = t.rate.toString();
      if (t.accountCode) ewtAccountId = (await tx.account.findFirst({ where: { organizationId, code: t.accountCode } }))?.id ?? null;
      if (!ewtAccountId) ewtAccountId = (await tx.account.findFirst({ where: { organizationId, systemRole: "EWT_PAYABLE" } }))?.id ?? null;
      if (!ewtAccountId) errors.push(`EWT code ${t.code} has no GL account`);
    }
  }

  const poNumber = input.poNumber?.trim() || null;
  const po = poNumber ? await tx.purchaseOrder.findUnique({ where: { organizationId_number: { organizationId, number: poNumber } } }) : null;
  if (poNumber && !po) errors.push(`PO ${poNumber} not found`);

  for (const [key, type] of [["departmentId", "DEPARTMENT"], ["costCenterId", "COST_CENTER"], ["branchId", "BRANCH"], ["projectId", "PROJECT"]] as const) {
    const v = input[key];
    if (v && !(await tx.dimensionValue.findFirst({ where: { id: v, organizationId, type, isActive: true } }))) errors.push(`The ${type.toLowerCase().replace("_", " ")} is inactive or not found`);
  }
  if (input.imageId && !(await tx.receiptImage.findFirst({ where: { id: input.imageId, organizationId }, select: { id: true } }))) errors.push("Receipt photo not found");

  const calc = computeVoucher({
    lines: input.lines ?? [],
    vendorVatRegistered: input.vendorVatRegistered ?? vendor?.vatRegistered ?? true,
    vatAmount: input.vatAmount, vatExemptAmount: input.vatExemptAmount, zeroRatedAmount: input.zeroRatedAmount,
    tipAmount: input.tipAmount, ewtRate, fixedAssetThreshold: org.fixedAssetThreshold.toString(), accounts,
    purchaseOrder: po ? { status: po.status, amount: po.amount.toString() } : null,
  });
  if (po && !calc.needsPurchaseOrder && po.status !== "APPROVED") calc.warnings.push(`PO ${po.number} is not approved`);
  calc.errors.unshift(...errors);
  calc.ok = calc.errors.length === 0;
  return { calc, vendor, po, fund, docType, tin, ewtAccountId, threshold: org.fixedAssetThreshold.toString() };
}

function voucherData(input: VoucherInput, e: Awaited<ReturnType<typeof evaluateVoucher>>) {
  const c = e.calc;
  return {
    fundId: input.fundId,
    receiptDate: asDay(input.receiptDate),
    docType: e.docType,
    docNumber: input.docNumber?.trim() || null,
    vendorId: e.vendor?.id ?? null,
    vendorName: input.vendorName.trim(),
    vendorTin: e.tin ?? e.vendor?.tin ?? null,
    vendorAddress: input.vendorAddress?.trim() || e.vendor?.address || null,
    vendorVatRegistered: input.vendorVatRegistered ?? e.vendor?.vatRegistered ?? true,
    description: input.description?.trim() || c.lines.map((l) => l.description).join(", ").slice(0, 250),
    grossAmount: dec(c.gross), vatAmount: dec(c.vat), vatExemptAmount: dec(c.vatExempt), zeroRatedAmount: dec(c.zeroRated),
    ewtTaxCodeId: input.ewtTaxCodeId || null, ewtAmount: dec(c.ewt), tipAmount: dec(c.tip), tipHandwritten: !!input.tipHandwritten,
    totalPaid: dec(c.totalPaid), purchaseOrderId: e.po?.id ?? null,
    departmentId: input.departmentId || null, costCenterId: input.costCenterId || null, branchId: input.branchId || null, projectId: input.projectId || null,
    imageId: input.imageId || null,
    extraction: input.extraction === undefined ? undefined : (JSON.parse(JSON.stringify(input.extraction)) as Prisma.InputJsonValue),
  };
}

const lineRows = (input: VoucherInput, e: Awaited<ReturnType<typeof evaluateVoucher>>) =>
  e.calc.lines.map((l, i) => ({
    lineNo: l.lineNo, description: l.description, quantity: new Prisma.Decimal(l.quantity), unitPrice: dec(l.unitPrice), amount: dec(l.amount),
    accountId: l.accountId, suggestedAccountId: input.lines[i]?.suggestedAccountId || null, isFixedAsset: l.isFixedAsset,
  }));

export async function previewVoucher(organizationId: string, input: VoucherInput) {
  return prisma.$transaction(async (tx) => summarize((await evaluateVoucher(tx, organizationId, input)).calc));
}

function summarize(c: ReturnType<typeof computeVoucher>) {
  const m = (x: bigint) => fromCentavos(x);
  return {
    ok: c.ok, errors: c.errors, warnings: c.warnings,
    gross: m(c.gross), vat: m(c.vat), netOfVat: m(c.netOfVat), vatExempt: m(c.vatExempt), zeroRated: m(c.zeroRated),
    ewt: m(c.ewt), tip: m(c.tip), totalPaid: m(c.totalPaid), capitalAmount: m(c.capitalAmount), needsPurchaseOrder: c.needsPurchaseOrder,
    lines: c.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity, unitPrice: m(l.unitPrice), amount: m(l.amount), vat: m(l.vat), net: m(l.net), accountId: l.accountId, isFixedAsset: l.isFixedAsset })),
  };
}

/** Save a voucher as a draft, or submit it for approval right away. */
export async function createVoucher(organizationId: string, userId: string, input: VoucherInput, submit = false) {
  return prisma.$transaction(async (tx) => {
    const e = await evaluateVoucher(tx, organizationId, input);
    if (submit && !e.calc.ok) throw new LedgerError(e.calc.errors);
    const blocking = e.calc.errors.filter((x) => /fund|supplier's name|receipt date|not found|account|choose/i.test(x));
    if (!submit && blocking.length) throw new LedgerError(blocking);
    const date = asDay(input.receiptDate);
    const number = await nextNumber(tx, organizationId, "PCV", date.getUTCFullYear());
    const v = await tx.pettyCashVoucher.create({ data: {
      organizationId, number, createdById: userId, ...voucherData(input, e),
      status: submit ? "SUBMITTED" : "DRAFT", submittedAt: submit ? new Date() : null,
      lines: { create: lineRows(input, e) },
    } });
    await audit(tx, organizationId, userId, submit ? "pettycash.create_submit" : "pettycash.create", v.id, { number }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, v.id, e.calc.warnings);
  });
}

export async function updateVoucher(organizationId: string, userId: string, id: string, input: VoucherInput) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (v.status !== "DRAFT" && v.status !== "REJECTED") throw new LedgerError([`Only draft or returned vouchers can be edited (this one is ${v.status.toLowerCase()})`]);
    if (v.createdById !== userId) {
      const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
      if (!m || !can(m.role, "pettycash.approve")) throw new LedgerError(["Only the preparer can edit this voucher"]);
    }
    const e = await evaluateVoucher(tx, organizationId, input);
    await tx.pettyCashVoucherLine.deleteMany({ where: { voucherId: id } });
    await tx.pettyCashVoucher.update({ where: { id }, data: { ...voucherData(input, e), status: "DRAFT", lines: { create: lineRows(input, e) } } });
    await audit(tx, organizationId, userId, "pettycash.update", id, { number: v.number }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id, e.calc.warnings);
  });
}

function inputFromVoucher(v: Prisma.PettyCashVoucherGetPayload<{ include: { lines: true; purchaseOrder: true } }>): VoucherInput {
  return {
    fundId: v.fundId, receiptDate: v.receiptDate.toISOString().slice(0, 10), docType: v.docType, docNumber: v.docNumber,
    vendorId: v.vendorId, vendorName: v.vendorName, vendorTin: v.vendorTin, vendorAddress: v.vendorAddress, vendorVatRegistered: v.vendorVatRegistered,
    description: v.description, vatAmount: m2(v.vatAmount), vatExemptAmount: m2(v.vatExemptAmount), zeroRatedAmount: m2(v.zeroRatedAmount),
    ewtTaxCodeId: v.ewtTaxCodeId, tipAmount: m2(v.tipAmount), poNumber: v.purchaseOrder?.number ?? null,
    departmentId: v.departmentId, costCenterId: v.costCenterId, branchId: v.branchId, projectId: v.projectId, imageId: v.imageId,
    lines: v.lines.sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: m2(l.unitPrice), amount: l.amount.toString(), accountId: l.accountId, isFixedAsset: l.isFixedAsset })),
  };
}

export async function submitVoucher(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId }, include: { lines: true, purchaseOrder: true } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (v.status !== "DRAFT" && v.status !== "REJECTED") throw new LedgerError([`Voucher is already ${v.status.toLowerCase()}`]);
    const e = await evaluateVoucher(tx, organizationId, inputFromVoucher(v));
    if (!e.calc.ok) throw new LedgerError(e.calc.errors);
    await tx.pettyCashVoucher.update({ where: { id }, data: { status: "SUBMITTED", submittedAt: new Date(), rejectedReason: null } });
    await audit(tx, organizationId, userId, "pettycash.submit", id, { number: v.number }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id, e.calc.warnings);
  });
}

export async function approveVoucher(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId }, include: { lines: true, purchaseOrder: true } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (v.status !== "SUBMITTED") throw new LedgerError(["Only submitted vouchers can be approved"]);
    // Re-check: the threshold, accounts or PO may have changed since it was submitted.
    const e = await evaluateVoucher(tx, organizationId, inputFromVoucher(v));
    if (!e.calc.ok) throw new LedgerError(e.calc.errors);
    await assertApprover(tx, organizationId, userId, [v.createdById], e.calc.gross + e.calc.tip, "voucher");
    const res = await tx.pettyCashVoucher.updateMany({ where: { id, status: "SUBMITTED" }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date() } });
    if (res.count !== 1) throw new LedgerError(["Voucher was changed by someone else; refresh and try again"]);
    await audit(tx, organizationId, userId, "pettycash.approve", id, { number: v.number }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id);
  });
}

export async function rejectVoucher(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (v.status !== "SUBMITTED" && v.status !== "APPROVED") throw new LedgerError(["Only submitted or approved vouchers can be returned"]);
    const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
    if (!m || !can(m.role, "pettycash.approve")) throw new LedgerError(["You do not have rights to return vouchers"]);
    if (!reason?.trim()) throw new LedgerError(["Give a reason so the preparer knows what to fix"]);
    await tx.pettyCashVoucher.update({ where: { id }, data: { status: "REJECTED", rejectedReason: reason.trim(), approvedById: null, approvedAt: null } });
    await audit(tx, organizationId, userId, "pettycash.reject", id, { number: v.number, reason: reason.trim() }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id);
  });
}

const voucherInclude = { lines: { orderBy: { lineNo: "asc" } }, purchaseOrder: true, fund: true, batch: true } satisfies Prisma.PettyCashVoucherInclude;

function voucherOut(v: Prisma.PettyCashVoucherGetPayload<{ include: typeof voucherInclude }>, warnings: string[] = []) {
  return {
    id: v.id, number: v.number, status: v.status, fund: { id: v.fund.id, code: v.fund.code, name: v.fund.name },
    receiptDate: v.receiptDate.toISOString().slice(0, 10), docType: v.docType, docNumber: v.docNumber,
    vendor: { id: v.vendorId, name: v.vendorName, tin: v.vendorTin, address: v.vendorAddress, vatRegistered: v.vendorVatRegistered },
    description: v.description, grossAmount: m2(v.grossAmount), vatAmount: m2(v.vatAmount), vatExemptAmount: m2(v.vatExemptAmount),
    zeroRatedAmount: m2(v.zeroRatedAmount), ewtTaxCodeId: v.ewtTaxCodeId, ewtAmount: m2(v.ewtAmount), tipAmount: m2(v.tipAmount),
    tipHandwritten: v.tipHandwritten, totalPaid: m2(v.totalPaid), poNumber: v.purchaseOrder?.number ?? null,
    departmentId: v.departmentId, costCenterId: v.costCenterId, branchId: v.branchId, projectId: v.projectId, imageId: v.imageId,
    createdById: v.createdById, submittedAt: v.submittedAt, approvedById: v.approvedById, approvedAt: v.approvedAt, rejectedReason: v.rejectedReason,
    batch: v.batch ? { id: v.batch.id, number: v.batch.number } : null,
    lines: v.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), unitPrice: m2(l.unitPrice), amount: m2(l.amount), accountId: l.accountId, suggestedAccountId: l.suggestedAccountId, isFixedAsset: l.isFixedAsset })),
    warnings,
  };
}

async function getVoucherTx(tx: Tx, organizationId: string, id: string, warnings: string[] = []) {
  const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId }, include: voucherInclude });
  if (!v) throw new LedgerError(["Voucher not found"]);
  return voucherOut(v, warnings);
}

export async function getVoucher(organizationId: string, id: string) {
  return prisma.$transaction((tx) => getVoucherTx(tx, organizationId, id));
}

export async function listVouchers(organizationId: string, f: { status?: string | null; fundId?: string | null; mine?: string | null; userId: string }) {
  const where: Prisma.PettyCashVoucherWhereInput = { organizationId };
  if (f.status) where.status = { in: f.status.split(",").map((s) => s.trim().toUpperCase()) as PettyCashStatus[] };
  if (f.fundId) where.fundId = f.fundId;
  if (f.mine === "1" || f.mine === "true") where.createdById = f.userId;
  const rows = await prisma.pettyCashVoucher.findMany({ where, include: voucherInclude, orderBy: [{ receiptDate: "desc" }, { number: "desc" }], take: 500 });
  return rows.map((v) => voucherOut(v));
}

// ---------- Replenishment batches ----------

/** Group approved vouchers into a replenishment batch and send its journal to the GL for approval. */
export async function createBatch(organizationId: string, userId: string, input: { fundId: string; voucherIds?: string[] | null; date?: string | null }, attachmentBase?: string | null) {
  return prisma.$transaction(async (tx) => {
    const fund = await tx.pettyCashFund.findFirst({ where: { id: input.fundId ?? "", organizationId } });
    if (!fund) throw new LedgerError(["Choose a petty cash fund"]);
    const where: Prisma.PettyCashVoucherWhereInput = { organizationId, fundId: fund.id, status: "APPROVED", batchId: null };
    if (input.voucherIds?.length) where.id = { in: input.voucherIds };
    const vs = await tx.pettyCashVoucher.findMany({ where, include: { lines: { orderBy: { lineNo: "asc" } } }, orderBy: [{ receiptDate: "asc" }, { number: "asc" }] });
    if (!vs.length) throw new LedgerError(["There are no approved vouchers to replenish for this fund"]);
    if (input.voucherIds?.length && vs.length !== new Set(input.voucherIds).size) throw new LedgerError(["Some vouchers are not approved, are already in a batch, or belong to another fund"]);

    const inputVat = await tx.account.findFirst({ where: { organizationId, systemRole: "INPUT_VAT" } });
    if (!inputVat && vs.some((v) => cents(v.vatAmount) > 0n)) throw new LedgerError(["No account is assigned the role INPUT_VAT"]);
    const ewtAcct = new Map<string, string | null>();
    for (const t of [...new Set(vs.map((v) => v.ewtTaxCodeId).filter(Boolean) as string[])]) {
      const code = await tx.taxCode.findFirst({ where: { id: t, organizationId } });
      const a = (code?.accountCode ? await tx.account.findFirst({ where: { organizationId, code: code.accountCode } }) : null)
        ?? (await tx.account.findFirst({ where: { organizationId, systemRole: "EWT_PAYABLE" } }));
      ewtAcct.set(t, a?.id ?? null);
    }

    const bvs: BatchVoucher[] = vs.map((v) => {
      const vat = cents(v.vatAmount), gross = cents(v.grossAmount);
      // Re-split VAT over the lines exactly as computeVoucher does.
      const lines = v.lines.map((l) => ({ accountId: l.accountId, description: l.description, amount: cents(l.amount), net: cents(l.amount) }));
      if (vat > 0n && gross > 0n) {
        let given = 0n;
        const shares = lines.map((l) => { const s = (vat * l.amount) / gross; given += s; return s; });
        const big = lines.reduce((bi, l, i) => (l.amount > lines[bi].amount ? i : bi), 0);
        shares[big] += vat - given;
        lines.forEach((l, i) => { l.net = l.amount - shares[i]; });
      }
      return {
        id: v.id, number: v.number, vendorName: v.vendorName, vendorId: v.vendorId, docType: v.docType, docNumber: v.docNumber,
        vat, ewt: cents(v.ewtAmount), tip: cents(v.tipAmount), totalPaid: cents(v.totalPaid),
        ewtAccountId: v.ewtTaxCodeId ? ewtAcct.get(v.ewtTaxCodeId) ?? null : null,
        dims: { departmentId: v.departmentId, costCenterId: v.costCenterId, branchId: v.branchId, projectId: v.projectId },
        lines: lines.map(({ accountId, description, net }) => ({ accountId, description, net })),
      };
    });
    let lines;
    try {
      lines = buildReplenishmentLines(bvs, inputVat?.id ?? "", fund.replenishAccountId ?? fund.accountId);
    } catch (err) {
      throw new LedgerError([(err as Error).message]);
    }
    const total = bvs.reduce((s, v) => s + v.totalPaid, 0n);
    const date = asDay(input.date || new Date());
    const number = await nextNumber(tx, organizationId, "PCR", date.getUTCFullYear());
    const batch = await tx.pettyCashBatch.create({ data: { organizationId, fundId: fund.id, number, date, totalPaid: dec(total), createdById: userId } });
    const attachments = attachmentBase
      ? vs.filter((v) => v.imageId).map((v) => ({ name: `${v.number} receipt`, url: `${attachmentBase}/api/receipts/${v.imageId}` }))
      : [];
    const entry = await recordJournalTx(tx, {
      organizationId, userId, date, transactionDate: date,
      memo: `Petty cash replenishment ${number} - ${fund.name} (${vs.length} vouchers)`,
      reference: number, source: "PETTY_CASH", sourceId: batch.id, action: "submit", lines, attachments,
    });
    await tx.pettyCashBatch.update({ where: { id: batch.id }, data: { journalEntryId: entry.id } });
    await tx.pettyCashVoucher.updateMany({ where: { id: { in: vs.map((v) => v.id) } }, data: { status: "BATCHED", batchId: batch.id } });
    await audit(tx, organizationId, userId, "pettycash.batch_create", batch.id, { number, journal: entry.number, total: fromCentavos(total) }, null, null, "pettycash_batch");
    return batch.id;
  }, { timeout: 30_000 }).then((id) => getBatch(organizationId, id));
}

/** Mark vouchers replenished once the batch journal is posted in the GL (by the app or the web). */
async function syncBatch(organizationId: string, batchId: string) {
  const b = await prisma.pettyCashBatch.findFirst({ where: { id: batchId, organizationId } });
  if (!b?.journalEntryId) return;
  const je = await prisma.journalEntry.findUnique({ where: { id: b.journalEntryId } });
  if (je?.status === "POSTED") await prisma.pettyCashVoucher.updateMany({ where: { batchId, status: "BATCHED" }, data: { status: "REPLENISHED" } });
}

export async function getBatch(organizationId: string, id: string) {
  await syncBatch(organizationId, id);
  const b = await prisma.pettyCashBatch.findFirst({ where: { id, organizationId }, include: { fund: true, vouchers: { include: { lines: true }, orderBy: [{ receiptDate: "asc" }, { number: "asc" }] } } });
  if (!b) throw new LedgerError(["Batch not found"]);
  const je = b.journalEntryId ? await prisma.journalEntry.findUnique({ where: { id: b.journalEntryId }, include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } } } }) : null;
  const sum = (k: "grossAmount" | "vatAmount" | "ewtAmount" | "tipAmount" | "totalPaid") => fromCentavos(b.vouchers.reduce((s, v) => s + cents(v[k]), 0n));
  // Summary by account (net of VAT), the usual replenishment report layout.
  const byAccount = new Map<string, { code: string; name: string; amount: bigint }>();
  for (const l of je?.lines ?? []) {
    if (cents(l.debit) === 0n) continue;
    const r = byAccount.get(l.accountId) ?? { code: l.account.code, name: l.account.name, amount: 0n };
    r.amount += cents(l.debit);
    byAccount.set(l.accountId, r);
  }
  return {
    id: b.id, number: b.number, date: b.date.toISOString().slice(0, 10),
    fund: { id: b.fund.id, code: b.fund.code, name: b.fund.name, imprestAmount: m2(b.fund.imprestAmount) },
    status: je?.status === "POSTED" ? "REPLENISHED" : je?.status === "VOID" ? "VOID" : je?.status === "DRAFT" ? "RETURNED" : "PENDING_APPROVAL",
    totals: { vouchers: b.vouchers.length, gross: sum("grossAmount"), vat: sum("vatAmount"), ewt: sum("ewtAmount"), tip: sum("tipAmount"), totalPaid: sum("totalPaid") },
    byAccount: [...byAccount.values()].sort((a, c) => a.code.localeCompare(c.code)).map((r) => ({ code: r.code, name: r.name, amount: fromCentavos(r.amount) })),
    vouchers: b.vouchers.map((v) => ({
      id: v.id, number: v.number, receiptDate: v.receiptDate.toISOString().slice(0, 10), vendorName: v.vendorName, vendorTin: v.vendorTin,
      docType: v.docType, docNumber: v.docNumber, description: v.description, gross: m2(v.grossAmount), vat: m2(v.vatAmount),
      ewt: m2(v.ewtAmount), tip: m2(v.tipAmount), totalPaid: m2(v.totalPaid), status: v.status,
    })),
    journal: je ? {
      id: je.id, number: je.number, status: je.status, date: je.date.toISOString().slice(0, 10), memo: je.memo,
      totalDebit: m2(je.totalDebit), totalCredit: m2(je.totalCredit),
      lines: je.lines.map((l) => ({ lineNo: l.lineNo, accountCode: l.account.code, accountName: l.account.name, description: l.description, debit: m2(l.debit), credit: m2(l.credit) })),
    } : null,
  };
}

export async function listBatches(organizationId: string, fundId?: string | null) {
  const rows = await prisma.pettyCashBatch.findMany({ where: { organizationId, ...(fundId ? { fundId } : {}) }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true } });
  return Promise.all(rows.map((r) => getBatch(organizationId, r.id)));
}

/** Approve and post the batch journal (same controls as any GL entry: rights, segregation of duties, limit). */
export async function postBatch(organizationId: string, userId: string, id: string) {
  const b = await prisma.pettyCashBatch.findFirst({ where: { id, organizationId } });
  if (!b?.journalEntryId) throw new LedgerError(["Batch not found"]);
  await postJournal(organizationId, userId, b.journalEntryId);
  return getBatch(organizationId, id);
}
