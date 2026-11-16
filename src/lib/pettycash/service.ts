// Petty cash vouchers, purchase orders and replenishment batches.
// A batch posts to the general ledger only through recordJournalTx / postJournal.
import { Prisma, type PettyCashStatus } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { can } from "../permissions";
import { LedgerError, asDay, audit, fiscalYearOf, fiscalYearRange, postJournal, recordJournalTx } from "../ledger/service";
import { saveCashTransaction } from "../bank/cash";
import { buildReplenishmentLines, computeVoucher, type AccountInfo, type BatchVoucher, type VoucherLineInput } from "./compute";
import {
  MODULES, PAYMENTS, PROVIDERS, amountLines, checksBlock, defaultTxType, detailErrors, findDuplicates, needsPaymentAccount, txType, vatTreatment,
  type Check, type DupCandidate, type ModuleKey, type PaymentKey,
} from "../expense/catalog";

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
export async function assertApprover(tx: Tx, organizationId: string, userId: string, preparerIds: (string | null)[], amount: bigint, what: string, allowWithoutRole = false) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  if (!m || (!allowWithoutRole && !can(m.role, "pettycash.approve"))) throw new LedgerError([`You do not have rights to approve this ${what}`]);
  if (org.segregationOfDuties && preparerIds.includes(userId)) throw new LedgerError([`Segregation of duties: someone other than the preparer must approve this ${what}`]);
  if (m.approvalLimit !== null && amount > cents(m.approvalLimit)) {
    throw new LedgerError([`This ${what} (PHP ${fromCentavos(amount)}) is above your approval limit of PHP ${fromCentavos(cents(m.approvalLimit))}`]);
  }
}

// ---------- Vouchers ----------

export type VoucherInput = {
  module?: ModuleKey | null;
  paymentMethod?: PaymentKey | null;
  paymentAccountId?: string | null;
  employeeId?: string | null;
  purpose?: string | null;
  transactionType?: string | null;
  provider?: string | null;
  bookingNumber?: string | null;
  tripAt?: string | null;
  details?: Record<string, unknown> | null;
  /** Transport / delivery amounts (fare, tolls, parking, deliveryFee, additionalCharges); used when no items are given. */
  amounts?: Record<string, string | number | null> | null;
  noReceipt?: boolean | null;
  noReceiptReason?: string | null;
  currencyCode?: string | null;
  fxRate?: string | null;
  statementLineId?: string | null;
  fundId?: string | null;
  receiptDate: string;
  docType?: string | null;
  docNumber?: string | null;
  vendorId?: string | null;
  vendorName?: string | null;
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
  lines?: (Partial<VoucherLineInput> & { suggestedAccountId?: string | null; originalDescription?: string | null })[];
};

const TIN_RE = /^\d{3}-?\d{3}-?\d{3}(-?\d{3,5})?$/;
const DOC_TYPES = ["OR", "SI", "CASH_INVOICE", "AR", "OTHER"];
const MODULE_KEYS = Object.keys(MODULES) as ModuleKey[];
const PAYMENT_KEYS = Object.keys(PAYMENTS) as PaymentKey[];

/** The employee record linked to a user (same email). */
export async function employeeOfUser(tx: Tx, organizationId: string, userId: string) {
  const u = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!u) return null;
  return tx.employee.findFirst({ where: { organizationId, isActive: true, email: { equals: u.email, mode: "insensitive" } } });
}

/** Debit account for a mobility transaction type: company mapping, else the template account codes / role. */
export async function mappedAccount(tx: Tx, organizationId: string, type: string) {
  const m = await tx.expenseMapping.findUnique({ where: { organizationId_transactionType: { organizationId, transactionType: type } } });
  if (m) {
    const a = await tx.account.findFirst({ where: { id: m.accountId, organizationId, isActive: true, isPostable: true } });
    if (a) return a;
  }
  const t = txType(type);
  if (!t) return null;
  if (t.role) {
    const a = await tx.account.findFirst({ where: { organizationId, systemRole: t.role, isActive: true, isPostable: true } });
    if (a) return a;
  }
  for (const code of t.codes) {
    const a = await tx.account.findFirst({ where: { organizationId, code, isActive: true, isPostable: true } });
    if (a) return a;
  }
  return null;
}

/** Multiply a money string by an exchange rate (6 decimals), rounded to centavos. */
function convert(v: string | number | null | undefined, rate6: bigint): string {
  const c = toCentavos(v ?? "0");
  return fromCentavos((c * rate6 + 500_000n) / 1_000_000n);
}

/** Validate and compute a voucher without saving it (the app calls this as a preview). */
export async function evaluateVoucher(tx: Tx, organizationId: string, input: VoucherInput, userId?: string) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const module: ModuleKey = MODULE_KEYS.includes(input.module as ModuleKey) ? (input.module as ModuleKey) : "PETTY_CASH";
  if (input.module && !MODULE_KEYS.includes(input.module as ModuleKey)) errors.push("Choose Petty Cash, Travel, Transport or Sent Package");
  const payment: PaymentKey = PAYMENT_KEYS.includes(input.paymentMethod as PaymentKey) ? (input.paymentMethod as PaymentKey) : module === "PETTY_CASH" ? "PETTY_CASH_FUND" : "EMPLOYEE";
  if (input.paymentMethod && !PAYMENT_KEYS.includes(input.paymentMethod as PaymentKey)) errors.push("Choose how this was paid");

  const fund = payment === "PETTY_CASH_FUND" ? await tx.pettyCashFund.findFirst({ where: { id: input.fundId ?? "", organizationId, isActive: true } }) : null;
  if (payment === "PETTY_CASH_FUND" && !fund) errors.push("Choose a petty cash fund");

  let paymentAccount: Prisma.BankAccountGetPayload<object> | null = null;
  if (needsPaymentAccount(payment)) {
    paymentAccount = await tx.bankAccount.findFirst({ where: { id: input.paymentAccountId ?? "", organizationId, isActive: true } });
    if (!paymentAccount) errors.push(`Choose which ${PAYMENTS[payment].label.replace(/^Corporate /, "corporate ")} account was used`);
    else if (!PAYMENTS[payment].kinds.includes(paymentAccount.kind)) errors.push(`${paymentAccount.name} is not a ${PAYMENTS[payment].label.toLowerCase()} account`);
  }

  // Who incurred it: the chosen employee, else the employee linked to the signed-in user.
  let employee = input.employeeId ? await tx.employee.findFirst({ where: { id: input.employeeId, organizationId } }) : null;
  if (input.employeeId && !employee) errors.push("Employee not found");
  if (!employee && !input.employeeId && userId) employee = await employeeOfUser(tx, organizationId, userId);
  if (!employee && (payment === "EMPLOYEE" || module !== "PETTY_CASH")) errors.push("Choose the employee or partner (or link your user to an employee record by email)");

  const noReceipt = !!input.noReceipt;
  if (noReceipt && !input.noReceiptReason?.trim()) errors.push("Explain why there is no receipt");
  const provider = input.provider?.trim().toUpperCase() || null;
  if (provider && module !== "PETTY_CASH" && !PROVIDERS[module].some((p) => p.key === provider)) errors.push("Choose the provider from the list (or Other)");
  const providerName = provider ? PROVIDERS[module].find((p) => p.key === provider)?.name ?? provider : null;
  const vendorName = input.vendorName?.trim() || providerName || (noReceipt ? "No receipt" : "");
  if (!vendorName) errors.push("Enter the supplier's name");
  const tin = input.vendorTin?.trim() || null;
  if (tin && !TIN_RE.test(tin)) errors.push("Supplier TIN should look like 000-000-000-000");
  const docType = (input.docType || (noReceipt ? "OTHER" : "OR")).toUpperCase();
  if (!DOC_TYPES.includes(docType)) errors.push(`Document type must be one of ${DOC_TYPES.join(", ")}`);
  if (!input.receiptDate || Number.isNaN(Date.parse(input.receiptDate))) errors.push("Enter the receipt date");
  if (input.tripAt && Number.isNaN(Date.parse(input.tripAt))) errors.push("Trip date and time is not valid");
  errors.push(...detailErrors(module, input.details, input.purpose));

  let vendor = input.vendorId ? await tx.vendor.findFirst({ where: { id: input.vendorId, organizationId } }) : null;
  if (input.vendorId && !vendor) errors.push("Supplier not found");
  if (!vendor && tin) vendor = await tx.vendor.findFirst({ where: { organizationId, tin: { in: [tin, tin.replace(/-/g, "")] } } });
  if (payment === "COMPANY_ACCOUNT" && !vendor) errors.push("Billed to company account: choose the provider from the supplier list");

  // Transaction type -> debit account (automatic GL mapping).
  const transactionType = module === "PETTY_CASH" ? null : (input.transactionType || defaultTxType(module));
  const tt = transactionType ? txType(transactionType) : null;
  if (transactionType && (!tt || tt.module !== module)) errors.push("Choose the type of transaction");
  const mapped = tt ? await mappedAccount(tx, organizationId, tt.key) : null;
  if (tt && !mapped) errors.push(`No GL account is mapped to "${tt.label}". Set it in Mobility Settings.`);

  // Currency: international receipts are entered in their own currency and converted to pesos.
  const currencyCode = (input.currencyCode || org.baseCurrency).toUpperCase();
  const foreign = currencyCode !== org.baseCurrency;
  let rate6 = 1_000_000n;
  if (foreign) {
    const r = Number(input.fxRate);
    if (!(r > 0)) errors.push(`Enter the exchange rate (PHP per 1 ${currencyCode})`);
    else rate6 = BigInt(Math.round(r * 1e6));
  }

  let rawLines = (input.lines ?? []).filter((l) => l && (l.description || l.unitPrice || l.amount));
  if (!rawLines.length && module !== "PETTY_CASH") rawLines = amountLines(module, input.amounts, mapped?.id ?? "", provider);
  const lines: (VoucherLineInput & { suggestedAccountId?: string | null })[] = rawLines.map((l) => ({
    description: l.description ?? "",
    quantity: l.quantity ?? "1",
    unitPrice: foreign ? safeConvert(l.unitPrice, rate6, errors) : (l.unitPrice ?? "0"),
    amount: l.amount === null || l.amount === undefined || String(l.amount).trim() === "" ? null : foreign ? safeConvert(l.amount, rate6, errors) : l.amount,
    accountId: l.accountId || mapped?.id || "",
    isFixedAsset: !!l.isFixedAsset,
    suggestedAccountId: l.suggestedAccountId ?? null,
  }));
  let foreignTotal: bigint | null = null;
  if (foreign) {
    try {
      foreignTotal = rawLines.reduce((s, l) => s + (l.amount !== null && l.amount !== undefined && String(l.amount).trim() !== "" ? toCentavos(l.amount) : toCentavos(l.unitPrice ?? "0") * BigInt(Math.round(Number(l.quantity ?? 1) || 1))), 0n);
    } catch { foreignTotal = null; }
  }
  const tipAmount = foreign && input.tipAmount ? safeConvert(input.tipAmount, rate6, errors) : input.tipAmount;

  const ids = [...new Set(lines.map((l) => l.accountId).filter(Boolean))];
  const accts = await tx.account.findMany({ where: { organizationId, id: { in: ids }, isActive: true, isPostable: true } });
  const accounts = new Map<string, AccountInfo>(accts.map((a) => [a.id, { id: a.id, code: a.code, name: a.name, type: a.type, ifrsGroup: a.ifrsGroup, systemRole: a.systemRole }]));

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

  // Dimensions: as entered, else the employee's defaults (by code).
  const dims = { departmentId: input.departmentId || null, costCenterId: input.costCenterId || null, branchId: input.branchId || null, projectId: input.projectId || null };
  if (employee) {
    const byCode = async (type: "DEPARTMENT" | "COST_CENTER" | "PROJECT", v?: string | null) =>
      v ? (await tx.dimensionValue.findFirst({ where: { organizationId, type, isActive: true, OR: [{ code: v }, { name: { equals: v, mode: "insensitive" } }] } }))?.id ?? null : null;
    dims.departmentId ??= await byCode("DEPARTMENT", employee.department);
    dims.costCenterId ??= await byCode("COST_CENTER", employee.costCenter);
    dims.projectId ??= await byCode("PROJECT", employee.projectCode);
  }
  for (const [key, type] of [["departmentId", "DEPARTMENT"], ["costCenterId", "COST_CENTER"], ["branchId", "BRANCH"], ["projectId", "PROJECT"]] as const) {
    const v = dims[key];
    if (v && !(await tx.dimensionValue.findFirst({ where: { id: v, organizationId, type, isActive: true } }))) errors.push(`The ${type.toLowerCase().replace("_", " ")} is inactive or not found`);
  }
  if (input.imageId && !(await tx.receiptImage.findFirst({ where: { id: input.imageId, organizationId }, select: { id: true } }))) errors.push("Receipt photo not found");
  if (!input.imageId && !noReceipt && module !== "PETTY_CASH") warnings.push("No receipt photo attached");

  // No VAT registration TIN (or no receipt, or a foreign receipt) = non-VAT, automatically.
  const vat = vatTreatment({ tin: tin ?? vendor?.tin, vatRegistered: input.vendorVatRegistered ?? vendor?.vatRegistered ?? true, noReceipt, currencyCode, baseCurrency: org.baseCurrency });
  if (vat.reason) warnings.push(vat.reason);
  const vatAmount = vat.vatRegistered ? input.vatAmount : null;

  const calc = computeVoucher({
    lines,
    vendorVatRegistered: vat.vatRegistered,
    vatAmount, vatExemptAmount: input.vatExemptAmount, zeroRatedAmount: input.zeroRatedAmount,
    tipAmount, ewtRate, fixedAssetThreshold: org.fixedAssetThreshold.toString(), accounts,
    purchaseOrder: po ? { status: po.status, amount: po.amount.toString() } : null,
  });
  if (po && !calc.needsPurchaseOrder && po.status !== "APPROVED") calc.warnings.push(`PO ${po.number} is not approved`);
  calc.errors.unshift(...errors);
  calc.warnings.unshift(...warnings);
  calc.ok = calc.errors.length === 0;
  return {
    calc, vendor, po, fund, docType, tin, ewtAccountId, threshold: org.fixedAssetThreshold.toString(),
    module, payment, paymentAccount, employee, transactionType, provider, vendorName, noReceipt, vatRegistered: vat.vatRegistered,
    currencyCode, rate6, foreignTotal, dims, lines,
  };
}

function safeConvert(v: string | number | null | undefined, rate6: bigint, errors: string[]) {
  try { return convert(v, rate6); } catch { errors.push("Enter amounts with up to 2 decimals"); return "0"; }
}

type Evaluated = Awaited<ReturnType<typeof evaluateVoucher>>;

function voucherData(input: VoucherInput, e: Evaluated) {
  const c = e.calc;
  return {
    module: e.module, paymentMethod: e.payment, paymentAccountId: e.paymentAccount?.id ?? null, employeeId: e.employee?.id ?? null,
    purpose: input.purpose?.trim() || null, transactionType: e.transactionType, provider: e.provider,
    bookingNumber: input.bookingNumber?.trim() || null, tripAt: input.tripAt ? new Date(input.tripAt) : null,
    details: input.details ? (JSON.parse(JSON.stringify({ ...input.details, ...(input.amounts ? { amounts: input.amounts } : {}) })) as Prisma.InputJsonValue) : input.amounts ? ({ amounts: input.amounts } as Prisma.InputJsonValue) : Prisma.DbNull,
    noReceipt: e.noReceipt, noReceiptReason: e.noReceipt ? input.noReceiptReason?.trim() || null : null,
    currencyCode: e.currencyCode, fxRate: new Prisma.Decimal((Number(e.rate6) / 1e6).toFixed(6)), foreignTotal: e.foreignTotal === null ? null : dec(e.foreignTotal),
    statementLineId: input.statementLineId || null,
    fundId: e.fund?.id ?? null,
    receiptDate: asDay(input.receiptDate),
    docType: e.docType,
    docNumber: input.docNumber?.trim() || null,
    vendorId: e.vendor?.id ?? null,
    vendorName: e.vendorName,
    vendorTin: e.tin ?? e.vendor?.tin ?? null,
    vendorAddress: input.vendorAddress?.trim() || e.vendor?.address || null,
    vendorVatRegistered: e.vatRegistered,
    description: (input.description?.trim() || [input.purpose?.trim(), c.lines.map((l) => l.description).join(", ")].filter(Boolean).join(" - ")).slice(0, 250),
    grossAmount: dec(c.gross), vatAmount: dec(c.vat), vatExemptAmount: dec(c.vatExempt), zeroRatedAmount: dec(c.zeroRated),
    ewtTaxCodeId: input.ewtTaxCodeId || null, ewtAmount: dec(c.ewt), tipAmount: dec(c.tip), tipHandwritten: !!input.tipHandwritten,
    totalPaid: dec(c.totalPaid), purchaseOrderId: e.po?.id ?? null,
    ...e.dims,
    imageId: input.imageId || null,
    extraction: input.extraction === undefined ? undefined : (JSON.parse(JSON.stringify(input.extraction)) as Prisma.InputJsonValue),
  };
}

const lineRows = (e: Evaluated) =>
  e.calc.lines.map((l, i) => ({
    lineNo: l.lineNo, description: l.description, quantity: new Prisma.Decimal(l.quantity), unitPrice: dec(l.unitPrice), amount: dec(l.amount),
    accountId: l.accountId, suggestedAccountId: e.lines[i]?.suggestedAccountId || null, isFixedAsset: l.isFixedAsset,
  }));

export async function previewVoucher(organizationId: string, input: VoucherInput, userId?: string) {
  return prisma.$transaction(async (tx) => {
    const e = await evaluateVoucher(tx, organizationId, input, userId);
    return { ...summarize(e.calc), vendorVatRegistered: e.vatRegistered, currencyCode: e.currencyCode, foreignTotal: e.foreignTotal === null ? null : fromCentavos(e.foreignTotal), employee: e.employee ? { id: e.employee.id, name: `${e.employee.firstName} ${e.employee.lastName}` } : null };
  });
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

const BLOCKING_DRAFT = /fund|supplier's name|receipt date|not found|account|choose|employee|exchange rate/i;

/** Save a voucher as a draft, or submit it for approval right away. */
export async function createVoucher(organizationId: string, userId: string, input: VoucherInput, submit = false) {
  return prisma.$transaction(async (tx) => {
    const e = await evaluateVoucher(tx, organizationId, input, userId);
    if (submit && !e.calc.ok) throw new LedgerError(e.calc.errors);
    const blocking = e.calc.errors.filter((x) => BLOCKING_DRAFT.test(x));
    if (!submit && blocking.length) throw new LedgerError(blocking);
    const date = asDay(input.receiptDate);
    const number = await nextNumber(tx, organizationId, "PCV", date.getUTCFullYear());
    const v = await tx.pettyCashVoucher.create({ data: {
      organizationId, number, createdById: userId, ...voucherData(input, e),
      status: submit ? "SUBMITTED" : "DRAFT", submittedAt: submit ? new Date() : null,
      lines: { create: lineRows(e) },
    } });
    await audit(tx, organizationId, userId, submit ? "pettycash.create_submit" : "pettycash.create", v.id, { number, module: e.module }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, v.id, e.calc.warnings);
  });
}

const EDITABLE = ["DRAFT", "RETURNED"];

export async function updateVoucher(organizationId: string, userId: string, id: string, input: VoucherInput) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (!EDITABLE.includes(v.status)) throw new LedgerError([`Only draft or returned vouchers can be edited (this one is ${v.status.toLowerCase()})`]);
    if (v.createdById !== userId) {
      const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
      if (!m || !can(m.role, "pettycash.approve")) throw new LedgerError(["Only the preparer can edit this voucher"]);
    }
    const e = await evaluateVoucher(tx, organizationId, { ...input, statementLineId: input.statementLineId ?? v.statementLineId }, v.createdById);
    const blocking = e.calc.errors.filter((x) => BLOCKING_DRAFT.test(x));
    if (blocking.length) throw new LedgerError(blocking);
    await tx.pettyCashVoucherLine.deleteMany({ where: { voucherId: id } });
    await tx.pettyCashVoucher.update({ where: { id }, data: { ...voucherData({ ...input, statementLineId: input.statementLineId ?? v.statementLineId }, e), status: "DRAFT", lines: { create: lineRows(e) } } });
    await audit(tx, organizationId, userId, "pettycash.update", id, { number: v.number }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id, e.calc.warnings);
  });
}

type FullVoucher = Prisma.PettyCashVoucherGetPayload<{ include: { lines: true; purchaseOrder: true } }>;

export function inputFromVoucher(v: FullVoucher): VoucherInput {
  const det = (v.details ?? null) as Record<string, unknown> | null;
  const foreign = v.currencyCode !== "PHP" && Number(v.fxRate) !== 1;
  // Lines are stored in pesos; a foreign receipt is re-evaluated in pesos at rate 1.
  return {
    module: v.module, paymentMethod: v.paymentMethod, paymentAccountId: v.paymentAccountId, employeeId: v.employeeId,
    purpose: v.purpose, transactionType: v.transactionType, provider: v.provider, bookingNumber: v.bookingNumber,
    tripAt: v.tripAt?.toISOString() ?? null, details: det, noReceipt: v.noReceipt, noReceiptReason: v.noReceiptReason,
    currencyCode: foreign ? null : v.currencyCode, fxRate: null, statementLineId: v.statementLineId,
    fundId: v.fundId, receiptDate: v.receiptDate.toISOString().slice(0, 10), docType: v.docType, docNumber: v.docNumber,
    vendorId: v.vendorId, vendorName: v.vendorName, vendorTin: v.vendorTin, vendorAddress: v.vendorAddress, vendorVatRegistered: foreign ? false : v.vendorVatRegistered,
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
    if (!EDITABLE.includes(v.status)) throw new LedgerError([`Voucher is already ${v.status.toLowerCase()}`]);
    const e = await evaluateVoucher(tx, organizationId, inputFromVoucher(v), v.createdById);
    if (!e.calc.ok) throw new LedgerError(e.calc.errors);
    await tx.pettyCashVoucher.update({ where: { id }, data: { status: "SUBMITTED", submittedAt: new Date(), rejectedReason: null } });
    await audit(tx, organizationId, userId, "pettycash.submit", id, { number: v.number }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id, e.calc.warnings);
  });
}

/** Can this user approve as the employee's manager? (Role with approval rights, or the named supervisor.) */
export async function isManagerOf(tx: Tx, organizationId: string, userId: string, employeeId: string | null) {
  const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  if (!m) return { ok: false, viaRole: false };
  if (can(m.role, "pettycash.approve")) return { ok: true, viaRole: true };
  if (!employeeId) return { ok: false, viaRole: false };
  const emp = await tx.employee.findFirst({ where: { id: employeeId, organizationId } });
  if (!emp?.supervisorCode) return { ok: false, viaRole: false };
  const sup = await tx.employee.findFirst({ where: { organizationId, code: emp.supervisorCode } });
  const me = await tx.user.findUnique({ where: { id: userId } });
  return { ok: !!(sup?.email && me && sup.email.toLowerCase() === me.email.toLowerCase()), viaRole: false };
}

/** Manager approval: checks business purpose, budget and cost center, then sends the voucher to finance review. */
export async function approveVoucher(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId }, include: { lines: true, purchaseOrder: true } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (v.status !== "SUBMITTED") throw new LedgerError(["Only submitted vouchers can be approved"]);
    // Re-check: the threshold, accounts or PO may have changed since it was submitted.
    const e = await evaluateVoucher(tx, organizationId, inputFromVoucher(v), v.createdById);
    if (!e.calc.ok) throw new LedgerError(e.calc.errors);
    const mgr = await isManagerOf(tx, organizationId, userId, v.employeeId);
    if (!mgr.ok) throw new LedgerError(["You do not have rights to approve this voucher"]);
    const empUser = e.employee?.email ? await tx.user.findFirst({ where: { email: { equals: e.employee.email, mode: "insensitive" } } }) : null;
    await assertApprover(tx, organizationId, userId, [v.createdById, empUser?.id ?? null], e.calc.gross + e.calc.tip, "voucher", true);
    const checks = await managerChecks(tx, organizationId, v);
    if (checksBlock(checks)) throw new LedgerError(checks.filter((c) => !c.ok && c.level === "block").map((c) => c.note));
    const res = await tx.pettyCashVoucher.updateMany({ where: { id, status: "SUBMITTED" }, data: { status: "APPROVED", approvedById: userId, approvedAt: new Date(), checks: { manager: checks } as unknown as Prisma.InputJsonValue } });
    if (res.count !== 1) throw new LedgerError(["Voucher was changed by someone else; refresh and try again"]);
    await audit(tx, organizationId, userId, "pettycash.approve", id, { number: v.number }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id);
  });
}

async function requireReviewer(tx: Tx, organizationId: string, userId: string, v: { employeeId: string | null; createdById: string }, finance: boolean) {
  const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  if (!m) throw new LedgerError(["You are not a member of this company"]);
  if (finance) {
    if (!can(m.role, "expense.finance")) throw new LedgerError(["Only finance (owner, administrator or accountant) can do this"]);
    return;
  }
  if (!(await isManagerOf(tx, organizationId, userId, v.employeeId)).ok) throw new LedgerError(["You do not have rights to return vouchers"]);
}

/** Send back to the preparer to fix (manager or finance). The voucher becomes editable again. */
export async function returnVoucher(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (!["SUBMITTED", "APPROVED", "HOLD"].includes(v.status)) throw new LedgerError(["Only vouchers waiting for approval or review can be returned"]);
    await requireReviewer(tx, organizationId, userId, v, v.status !== "SUBMITTED");
    if (!reason?.trim()) throw new LedgerError(["Give a reason so the preparer knows what to fix"]);
    await tx.pettyCashVoucher.update({ where: { id }, data: { status: "RETURNED", rejectedReason: reason.trim(), approvedById: null, approvedAt: null } });
    await audit(tx, organizationId, userId, "pettycash.return", id, { number: v.number, reason: reason.trim() }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id);
  });
}

/** Decline for good (manager or finance). Not editable afterwards. */
export async function rejectVoucher(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (!["SUBMITTED", "APPROVED", "HOLD"].includes(v.status)) throw new LedgerError(["Only vouchers waiting for approval or review can be rejected"]);
    await requireReviewer(tx, organizationId, userId, v, v.status !== "SUBMITTED");
    if (!reason?.trim()) throw new LedgerError(["Give the reason for rejecting"]);
    await tx.pettyCashVoucher.update({ where: { id }, data: { status: "REJECTED", rejectedReason: reason.trim() } });
    await audit(tx, organizationId, userId, "pettycash.reject", id, { number: v.number, reason: reason.trim() }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id);
  });
}

// ---------- Checks ----------

async function managerChecks(tx: Tx, organizationId: string, v: FullVoucher): Promise<Check[]> {
  const out: Check[] = [];
  if (v.module !== "PETTY_CASH") out.push({ key: "purpose", label: "Business purpose", ok: !!v.purpose?.trim(), level: "block", note: v.purpose?.trim() ? v.purpose : "No business purpose given" });
  if (v.costCenterId) {
    const cc = await tx.dimensionValue.findFirst({ where: { id: v.costCenterId, organizationId, type: "COST_CENTER" } });
    out.push({ key: "costCenter", label: "Cost center", ok: !!cc?.isActive, level: "block", note: cc ? `${cc.code} ${cc.name}${cc.isActive ? "" : " is inactive"}` : "Cost center not found" });
  } else {
    out.push({ key: "costCenter", label: "Cost center", ok: v.module === "PETTY_CASH", level: "warn", note: "No cost center on this claim" });
  }
  out.push(...(await budgetChecks(tx, organizationId, v)));
  return out;
}

/** Annual budget for each expense account on the voucher (by cost center / department / project if budgeted that way). */
async function budgetChecks(tx: Tx, organizationId: string, v: FullVoucher): Promise<Check[]> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const fy = fiscalYearOf(org.fiscalYearStartMonth, v.receiptDate);
  const { start, end } = fiscalYearRange(org.fiscalYearStartMonth, fy);
  const byAccount = new Map<string, bigint>();
  for (const l of v.lines) byAccount.set(l.accountId, (byAccount.get(l.accountId) ?? 0n) + cents(l.amount));
  const out: Check[] = [];
  for (const [accountId, amt] of byAccount) {
    const a = await tx.account.findUnique({ where: { id: accountId } });
    if (!a || a.type !== "EXPENSE") continue;
    const dimIds = [v.costCenterId, v.departmentId, v.projectId].filter(Boolean) as string[];
    const budgets = await tx.budget.findMany({ where: { organizationId, fiscalYear: fy, accountId, OR: [{ dimensionValueId: null }, { dimensionValueId: { in: dimIds } }] } });
    const b = budgets.find((x) => x.dimensionValueId && dimIds.includes(x.dimensionValueId)) ?? budgets.find((x) => !x.dimensionValueId);
    if (!b) { out.push({ key: `budget:${a.code}`, label: `Budget ${a.code}`, ok: true, level: "info", note: `No ${fy} budget for ${a.code} ${a.name}` }); continue; }
    const total = (["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10", "m11", "m12"] as const).reduce((s, k) => s + cents(b[k]), 0n);
    const dimKey = b.dimensionValueId ? (await tx.dimensionValue.findUnique({ where: { id: b.dimensionValueId } })) : null;
    const dimField = dimKey ? ({ COST_CENTER: "costCenterId", DEPARTMENT: "departmentId", PROJECT: "projectId" } as Record<string, string>)[dimKey.type] : null;
    const agg = await tx.journalLine.aggregate({
      where: { organizationId, accountId, journalEntry: { status: "POSTED", book: "STATUTORY", date: { gte: start, lte: end } }, ...(dimField ? { [dimField]: b.dimensionValueId } : {}) },
      _sum: { debit: true, credit: true },
    });
    const used = cents(agg._sum.debit) - cents(agg._sum.credit) + amt;
    const ok = used <= total;
    out.push({ key: `budget:${a.code}`, label: `Budget ${a.code}${dimKey ? ` (${dimKey.code})` : ""}`, ok, level: "warn", note: `PHP ${fromCentavos(used)} of PHP ${fromCentavos(total)} ${fy} budget used after this claim${ok ? "" : " (over budget)"}` });
  }
  return out;
}

/** Receipt validity, tax compliance and duplicates, for finance review. */
export async function financeChecks(tx: Tx, organizationId: string, v: FullVoucher): Promise<Check[]> {
  const out: Check[] = [];
  const ext = (v.extraction ?? null) as { receipt?: { confidence?: string; isReceipt?: boolean } } | null;
  if (v.noReceipt) out.push({ key: "receipt", label: "Receipt", ok: false, level: "warn", note: `No receipt (${v.noReceiptReason ?? "no reason"}). Without an official receipt the expense may not be deductible for income tax.` });
  else if (!v.imageId) out.push({ key: "receipt", label: "Receipt", ok: false, level: "warn", note: "No receipt photo attached" });
  else if (ext?.receipt?.isReceipt === false) out.push({ key: "receipt", label: "Receipt", ok: false, level: "warn", note: "The photo does not look like a receipt" });
  else out.push({ key: "receipt", label: "Receipt", ok: ext?.receipt?.confidence !== "low", level: "warn", note: ext?.receipt?.confidence === "low" ? "Receipt was hard to read; compare the photo with the amounts" : "Receipt photo attached" });

  const vat = cents(v.vatAmount);
  const tinOk = (v.vendorTin ?? "").replace(/\D/g, "").length >= 9;
  if (vat > 0n) out.push({ key: "tax", label: "Tax compliance", ok: tinOk && !v.noReceipt, level: "block", note: tinOk ? `Input VAT PHP ${fromCentavos(vat)} supported by supplier TIN ${v.vendorTin}` : "Input VAT claimed without the supplier's VAT TIN" });
  else out.push({ key: "tax", label: "Tax compliance", ok: true, level: "info", note: tinOk ? "Non-VAT purchase" : "Non-VAT (no VAT TIN on the receipt), no input VAT claimed" });

  const others = await tx.pettyCashVoucher.findMany({
    where: { organizationId, id: { not: v.id }, status: { notIn: ["REJECTED"] }, OR: [
      ...(v.bookingNumber ? [{ bookingNumber: v.bookingNumber }] : []),
      ...(v.imageId ? [{ imageId: v.imageId }] : []),
      ...(v.docNumber ? [{ docNumber: v.docNumber }] : []),
      ...(v.employeeId ? [{ employeeId: v.employeeId, receiptDate: v.receiptDate }] : []),
    ] },
    take: 50,
  });
  const total = (x: { grossAmount: Prisma.Decimal; tipAmount: Prisma.Decimal }) => cents(x.grossAmount) + cents(x.tipAmount);
  const toCand = (x: typeof others[number]): DupCandidate => ({ id: x.id, number: x.number, provider: x.provider, bookingNumber: x.bookingNumber, employeeId: x.employeeId, receiptDate: x.receiptDate.toISOString().slice(0, 10), total: total(x), docNumber: x.docNumber, vendorTin: x.vendorTin, imageId: x.imageId });
  const me = toCand(v as unknown as typeof others[number]);
  const dups = findDuplicates(me, others.map(toCand));
  if (!dups.length) out.push({ key: "duplicate", label: "Duplicates", ok: true, level: "info", note: "No duplicate found" });
  for (const d of dups) out.push({ key: `duplicate:${d.id}`, label: "Possible duplicate", ok: false, level: d.strong ? "block" : "warn", note: `${d.number}: ${d.reason}` });
  return out;
}

const voucherInclude = { lines: { orderBy: { lineNo: "asc" } }, purchaseOrder: true, fund: true, batch: true } satisfies Prisma.PettyCashVoucherInclude;
type VoucherRow = Prisma.PettyCashVoucherGetPayload<{ include: typeof voucherInclude }>;

async function voucherExtras(tx: Tx, rows: VoucherRow[]) {
  const ids = (k: (v: VoucherRow) => string | null) => [...new Set(rows.map(k).filter(Boolean) as string[])];
  const [emps, banks, jes, users] = await Promise.all([
    tx.employee.findMany({ where: { id: { in: ids((v) => v.employeeId) } } }),
    tx.bankAccount.findMany({ where: { id: { in: ids((v) => v.paymentAccountId) } } }),
    tx.journalEntry.findMany({ where: { id: { in: ids((v) => v.journalEntryId) } }, select: { id: true, number: true, status: true } }),
    tx.user.findMany({ where: { id: { in: [...ids((v) => v.createdById), ...ids((v) => v.approvedById), ...ids((v) => v.financeById)] } }, select: { id: true, name: true } }),
  ]);
  return { emps: new Map(emps.map((e) => [e.id, e])), banks: new Map(banks.map((b) => [b.id, b])), jes: new Map(jes.map((j) => [j.id, j])), users: new Map(users.map((u) => [u.id, u.name])) };
}

function voucherOut(v: VoucherRow, x: Awaited<ReturnType<typeof voucherExtras>>, warnings: string[] = []) {
  const emp = v.employeeId ? x.emps.get(v.employeeId) : null;
  const bank = v.paymentAccountId ? x.banks.get(v.paymentAccountId) : null;
  const je = v.journalEntryId ? x.jes.get(v.journalEntryId) : null;
  return {
    id: v.id, number: v.number, status: v.status, module: v.module, paymentMethod: v.paymentMethod,
    paymentAccount: bank ? { id: bank.id, code: bank.code, name: bank.name, kind: bank.kind } : null,
    employee: emp ? { id: emp.id, code: emp.code, name: `${emp.firstName} ${emp.lastName}`, department: emp.department } : null,
    purpose: v.purpose, transactionType: v.transactionType, provider: v.provider, bookingNumber: v.bookingNumber, tripAt: v.tripAt,
    details: v.details, noReceipt: v.noReceipt, noReceiptReason: v.noReceiptReason,
    currencyCode: v.currencyCode, fxRate: v.fxRate.toString(), foreignTotal: v.foreignTotal ? m2(v.foreignTotal) : null,
    fund: v.fund ? { id: v.fund.id, code: v.fund.code, name: v.fund.name } : null,
    receiptDate: v.receiptDate.toISOString().slice(0, 10), docType: v.docType, docNumber: v.docNumber,
    vendor: { id: v.vendorId, name: v.vendorName, tin: v.vendorTin, address: v.vendorAddress, vatRegistered: v.vendorVatRegistered },
    description: v.description, grossAmount: m2(v.grossAmount), vatAmount: m2(v.vatAmount), vatExemptAmount: m2(v.vatExemptAmount),
    zeroRatedAmount: m2(v.zeroRatedAmount), ewtTaxCodeId: v.ewtTaxCodeId, ewtAmount: m2(v.ewtAmount), tipAmount: m2(v.tipAmount),
    tipHandwritten: v.tipHandwritten, totalPaid: m2(v.totalPaid), poNumber: v.purchaseOrder?.number ?? null,
    departmentId: v.departmentId, costCenterId: v.costCenterId, branchId: v.branchId, projectId: v.projectId, imageId: v.imageId,
    createdById: v.createdById, createdBy: x.users.get(v.createdById) ?? null, submittedAt: v.submittedAt,
    approvedById: v.approvedById, approvedBy: v.approvedById ? x.users.get(v.approvedById) ?? null : null, approvedAt: v.approvedAt,
    financeById: v.financeById, financeBy: v.financeById ? x.users.get(v.financeById) ?? null : null, financeAt: v.financeAt, financeNote: v.financeNote,
    rejectedReason: v.rejectedReason, checks: v.checks,
    batch: v.batch ? { id: v.batch.id, number: v.batch.number } : null,
    journal: je ? { id: je.id, number: je.number, status: je.status } : null,
    reimbursementId: v.reimbursementId, statementLineId: v.statementLineId,
    lines: v.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), unitPrice: m2(l.unitPrice), amount: m2(l.amount), accountId: l.accountId, suggestedAccountId: l.suggestedAccountId, isFixedAsset: l.isFixedAsset })),
    warnings,
  };
}
export type VoucherOut = ReturnType<typeof voucherOut>;

export async function getVoucherTx(tx: Tx, organizationId: string, id: string, warnings: string[] = []) {
  const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId }, include: voucherInclude });
  if (!v) throw new LedgerError(["Voucher not found"]);
  return voucherOut(v, await voucherExtras(tx, [v]), warnings);
}

export async function getVoucher(organizationId: string, id: string) {
  await syncReimbursements(organizationId);
  return prisma.$transaction((tx) => getVoucherTx(tx, organizationId, id));
}

export type VoucherFilter = { status?: string | null; fundId?: string | null; mine?: string | null; userId: string; module?: string | null; employeeId?: string | null; paymentMethod?: string | null; from?: string | null; to?: string | null; queue?: string | null };

export async function listVouchers(organizationId: string, f: VoucherFilter) {
  await syncReimbursements(organizationId);
  const where: Prisma.PettyCashVoucherWhereInput = { organizationId };
  if (f.status) where.status = { in: f.status.split(",").map((s) => s.trim().toUpperCase()) as PettyCashStatus[] };
  if (f.fundId) where.fundId = f.fundId;
  if (f.module) where.module = { in: f.module.split(",").map((s) => s.trim().toUpperCase()) as ModuleKey[] };
  if (f.paymentMethod) where.paymentMethod = { in: f.paymentMethod.split(",").map((s) => s.trim().toUpperCase()) as PaymentKey[] };
  if (f.employeeId) where.employeeId = f.employeeId;
  if (f.from || f.to) where.receiptDate = { ...(f.from ? { gte: asDay(f.from) } : {}), ...(f.to ? { lte: asDay(f.to) } : {}) };
  if (f.mine === "1" || f.mine === "true") {
    const emp = await prisma.$transaction((tx) => employeeOfUser(tx, organizationId, f.userId));
    where.OR = [{ createdById: f.userId }, ...(emp ? [{ employeeId: emp.id }] : [])];
  }
  if (f.queue === "manager") {
    // Submitted claims this user may approve: everything for approvers, else their team's claims.
    where.status = "SUBMITTED";
    const m = await prisma.membership.findUnique({ where: { userId_organizationId: { userId: f.userId, organizationId } } });
    if (!m || !can(m.role, "pettycash.approve")) {
      const me = await prisma.user.findUnique({ where: { id: f.userId } });
      const mine = me ? await prisma.employee.findFirst({ where: { organizationId, email: { equals: me.email, mode: "insensitive" } } }) : null;
      const team = mine ? await prisma.employee.findMany({ where: { organizationId, supervisorCode: mine.code }, select: { id: true } }) : [];
      where.employeeId = { in: team.map((t) => t.id) };
    }
  }
  if (f.queue === "finance") where.status = { in: ["APPROVED", "HOLD"] };
  const rows = await prisma.pettyCashVoucher.findMany({ where, include: voucherInclude, orderBy: [{ receiptDate: "desc" }, { number: "desc" }], take: 500 });
  const x = await prisma.$transaction((tx) => voucherExtras(tx, rows));
  return rows.map((v) => voucherOut(v, x));
}

// ---------- Finance review and posting ----------

/** Run the finance checks again and save them on the voucher (for the review screen). */
export async function reviewChecks(organizationId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId }, include: { lines: true, purchaseOrder: true } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    return financeChecks(tx, organizationId, v);
  });
}

/** Re-split VAT over the lines exactly as computeVoucher does and shape a voucher for the journal builder. */
function toBatchVoucher(v: FullVoucher, ewtAccountId: string | null): BatchVoucher {
  const vat = cents(v.vatAmount), gross = cents(v.grossAmount);
  const lines = [...v.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ accountId: l.accountId, description: l.description, amount: cents(l.amount), net: cents(l.amount) }));
  if (vat > 0n && gross > 0n) {
    let given = 0n;
    const shares = lines.map((l) => { const s = (vat * l.amount) / gross; given += s; return s; });
    const big = lines.reduce((bi, l, i) => (l.amount > lines[bi].amount ? i : bi), 0);
    shares[big] += vat - given;
    lines.forEach((l, i) => { l.net = l.amount - shares[i]; });
  }
  return {
    id: v.id, number: v.number, vendorName: v.vendorName, vendorId: v.vendorId, docType: v.docType, docNumber: v.docNumber,
    vat, ewt: cents(v.ewtAmount), tip: cents(v.tipAmount), totalPaid: cents(v.totalPaid), ewtAccountId,
    dims: { departmentId: v.departmentId, costCenterId: v.costCenterId, branchId: v.branchId, projectId: v.projectId },
    lines: lines.map(({ accountId, description, net }) => ({ accountId, description, net })),
  };
}

async function ewtAccountOf(tx: Tx, organizationId: string, taxCodeId: string | null) {
  if (!taxCodeId) return null;
  const code = await tx.taxCode.findFirst({ where: { id: taxCodeId, organizationId } });
  const a = (code?.accountCode ? await tx.account.findFirst({ where: { organizationId, code: code.accountCode } }) : null)
    ?? (await tx.account.findFirst({ where: { organizationId, systemRole: "EWT_PAYABLE" } }));
  return a?.id ?? null;
}

/** The credit side of a corporate / employee-paid claim. */
async function creditSide(tx: Tx, organizationId: string, v: FullVoucher) {
  if (v.paymentMethod === "EMPLOYEE") {
    const a = await tx.account.findFirst({ where: { organizationId, systemRole: "EMPLOYEE_REIMB_PAYABLE" } });
    if (!a) throw new LedgerError(["No account is assigned the role EMPLOYEE_REIMB_PAYABLE (Employee Reimbursements Payable)"]);
    const e = v.employeeId ? await tx.employee.findUnique({ where: { id: v.employeeId } }) : null;
    return { accountId: a.id, label: "Employee reimbursement payable", partyType: e?.isPartner ? "PARTNER" : "EMPLOYEE", partyId: e?.code ?? null };
  }
  if (v.paymentMethod === "COMPANY_ACCOUNT") {
    const a = await tx.account.findFirst({ where: { organizationId, systemRole: "AP_CONTROL" } });
    if (!a) throw new LedgerError(["No account is assigned the role AP_CONTROL (Accounts Payable)"]);
    const vd = v.vendorId ? await tx.vendor.findUnique({ where: { id: v.vendorId } }) : null;
    return { accountId: a.id, label: `Billed to company account - ${v.vendorName}`, partyType: vd ? "VENDOR" : null, partyId: vd?.code ?? null };
  }
  const b = v.paymentAccountId ? await tx.bankAccount.findFirst({ where: { id: v.paymentAccountId, organizationId } }) : null;
  if (!b) throw new LedgerError(["The payment account was not found"]);
  return { accountId: b.glAccountId, label: `${PAYMENTS[v.paymentMethod].label} - ${b.name}`, partyType: null, partyId: null, bankAccountId: b.id };
}

async function postClaim(tx: Tx, organizationId: string, userId: string, v: FullVoucher, attachmentBase?: string | null) {
  const inputVat = await tx.account.findFirst({ where: { organizationId, systemRole: "INPUT_VAT" } });
  if (!inputVat && cents(v.vatAmount) > 0n) throw new LedgerError(["No account is assigned the role INPUT_VAT"]);
  const credit = await creditSide(tx, organizationId, v);
  const bv = toBatchVoucher(v, await ewtAccountOf(tx, organizationId, v.ewtTaxCodeId));
  let lines;
  try { lines = buildReplenishmentLines([bv], inputVat?.id ?? "", credit.accountId); } catch (err) { throw new LedgerError([(err as Error).message]); }
  const ref = v.bookingNumber || v.docNumber || v.number;
  const emp = v.employeeId ? await tx.employee.findUnique({ where: { id: v.employeeId } }) : null;
  const who = emp ? `${emp.firstName} ${emp.lastName}` : null;
  // Expense lines carry the employee as party (expense summary per employee / partner).
  // Party ids follow the cash module convention: the master code (EMPLOYEE:E-001, VENDOR:V-001).
  const vendorCode = v.vendorId ? (await tx.vendor.findUnique({ where: { id: v.vendorId } }))?.code ?? null : null;
  for (const l of lines.slice(0, -1)) {
    if (emp && l.debit !== "0" && l.accountId !== inputVat?.id) { l.partyType = emp.isPartner ? "PARTNER" : "EMPLOYEE"; l.partyId = emp.code; }
    else if (l.partyType === "VENDOR") l.partyId = vendorCode;
  }
  const last = lines[lines.length - 1];
  last.description = `${credit.label}${who ? ` - ${who}` : ""} - ${ref}`.slice(0, 250);
  last.partyType = credit.partyType; last.partyId = credit.partyId;
  // Post on the receipt date; if that period is closed, on today.
  let date = v.receiptDate;
  const p = await tx.fiscalPeriod.findUnique({ where: { organizationId_year_month: { organizationId, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 } } });
  if (p && p.status !== "OPEN") date = asDay(new Date());
  const entry = await recordJournalTx(tx, {
    organizationId, userId, date, transactionDate: v.receiptDate,
    memo: `${MODULES[v.module].label} ${v.number}${who ? ` - ${who}` : ""}: ${v.description}`.slice(0, 500),
    reference: ref, source: "EXPENSE_CLAIM", sourceId: v.id, action: "post", lines,
    attachments: attachmentBase && v.imageId ? [{ name: `${v.number} receipt`, url: `${attachmentBase}/api/receipts/${v.imageId}` }] : [],
  });
  // A claim created from a corporate statement line clears against it right away.
  if (v.statementLineId && credit.bankAccountId) {
    const sl = await tx.bankStatementLine.findFirst({ where: { id: v.statementLineId, organizationId, bankAccountId: credit.bankAccountId, matchId: null } });
    const gl = await tx.journalLine.findFirst({ where: { journalEntryId: entry.id, accountId: credit.accountId } });
    if (sl && gl && cents(sl.amount) === -cents(gl.credit)) {
      const m = await tx.bankMatch.create({ data: { organizationId, bankAccountId: credit.bankAccountId, method: "SUGGESTED", note: `Claim ${v.number}`, createdById: userId } });
      await tx.bankStatementLine.update({ where: { id: sl.id }, data: { matchId: m.id } });
      await tx.journalLine.update({ where: { id: gl.id }, data: { clearedAt: sl.date, clearingRef: m.id } });
    }
  }
  return entry;
}

/**
 * Finance review passed. Corporate-paid and employee-paid claims post to the GL now
 * (Dr expense / input VAT, Cr card, wallet, bank or employee payable); petty cash fund vouchers wait for a replenishment batch.
 */
export async function financeClear(organizationId: string, userId: string, id: string, opts: { note?: string | null; overrideDuplicates?: boolean } = {}, attachmentBase?: string | null) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId }, include: { lines: true, purchaseOrder: true } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (v.status !== "APPROVED" && v.status !== "HOLD") throw new LedgerError(["Only manager-approved vouchers (or ones on hold) can be cleared"]);
    await requireReviewer(tx, organizationId, userId, v, true);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const empUser = v.employeeId ? await tx.employee.findUnique({ where: { id: v.employeeId } }).then((e) => e?.email ? tx.user.findFirst({ where: { email: { equals: e.email, mode: "insensitive" } } }) : null) : null;
    if (org.segregationOfDuties && [v.createdById, empUser?.id].includes(userId)) throw new LedgerError(["Segregation of duties: finance review must be done by someone other than the preparer or the employee"]);
    const e = await evaluateVoucher(tx, organizationId, inputFromVoucher(v), v.createdById);
    if (!e.calc.ok) throw new LedgerError(e.calc.errors);
    const checks = await financeChecks(tx, organizationId, v);
    const blocking = checks.filter((c) => !c.ok && c.level === "block");
    const onlyDups = blocking.every((c) => c.key.startsWith("duplicate"));
    if (blocking.length && !(onlyDups && opts.overrideDuplicates && opts.note?.trim())) {
      throw new LedgerError([...blocking.map((c) => c.note), ...(onlyDups ? ["If this is not a duplicate, add a note and confirm the override"] : [])]);
    }
    const prev = (v.checks ?? {}) as Record<string, unknown>;
    let journalEntryId: string | null = null;
    if (v.paymentMethod !== "PETTY_CASH_FUND") journalEntryId = (await postClaim(tx, organizationId, userId, v, attachmentBase)).id;
    const r = await tx.pettyCashVoucher.updateMany({ where: { id, status: v.status }, data: {
      status: "CLEARED", financeById: userId, financeAt: new Date(), financeNote: opts.note?.trim() || null, journalEntryId,
      checks: { ...prev, finance: checks } as unknown as Prisma.InputJsonValue,
    } });
    if (r.count !== 1) throw new LedgerError(["Voucher was changed by someone else; refresh and try again"]);
    await audit(tx, organizationId, userId, "expense.finance_clear", id, { number: v.number, journalEntryId, override: !!opts.overrideDuplicates }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id);
  }, { timeout: 30_000 });
}

export async function holdVoucher(organizationId: string, userId: string, id: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const v = await tx.pettyCashVoucher.findFirst({ where: { id, organizationId } });
    if (!v) throw new LedgerError(["Voucher not found"]);
    if (v.status !== "APPROVED") throw new LedgerError(["Only vouchers in finance review can be put on hold"]);
    await requireReviewer(tx, organizationId, userId, v, true);
    if (!reason?.trim()) throw new LedgerError(["Say why the voucher is on hold"]);
    await tx.pettyCashVoucher.update({ where: { id }, data: { status: "HOLD", financeNote: reason.trim(), financeById: userId, financeAt: new Date() } });
    await audit(tx, organizationId, userId, "expense.hold", id, { number: v.number, reason: reason.trim() }, null, null, "pettycash_voucher");
    return getVoucherTx(tx, organizationId, id);
  });
}

// ---------- Employee reimbursements ----------

/** Cleared employee-paid claims not yet paid back, per employee. */
export async function outstandingReimbursements(organizationId: string) {
  await syncReimbursements(organizationId);
  const vs = await prisma.pettyCashVoucher.findMany({ where: { organizationId, paymentMethod: "EMPLOYEE", status: "CLEARED", reimbursementId: null }, orderBy: [{ receiptDate: "asc" }, { number: "asc" }] });
  const emps = await prisma.employee.findMany({ where: { id: { in: [...new Set(vs.map((v) => v.employeeId).filter(Boolean) as string[])] } } });
  return emps.map((e) => {
    const mine = vs.filter((v) => v.employeeId === e.id);
    return { employee: { id: e.id, code: e.code, name: `${e.firstName} ${e.lastName}` }, count: mine.length, total: fromCentavos(mine.reduce((s, v) => s + cents(v.totalPaid), 0n)),
      vouchers: mine.map((v) => ({ id: v.id, number: v.number, receiptDate: v.receiptDate.toISOString().slice(0, 10), module: v.module, description: v.description, totalPaid: m2(v.totalPaid) })) };
  });
}

/** Pay an employee back: one disbursement voucher (Dr employee reimbursements payable, Cr bank), approved in Cash and Bank. */
export async function payReimbursement(organizationId: string, userId: string, input: { employeeId: string; voucherIds?: string[] | null; bankAccountId: string; date?: string | null; method?: string | null; checkNo?: string | null }) {
  const lock = `PENDING:${userId}:${Date.now()}`;
  const claimed = await prisma.$transaction(async (tx) => {
    const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
    if (!m || !can(m.role, "expense.finance")) throw new LedgerError(["Only finance can pay reimbursements"]);
    const where: Prisma.PettyCashVoucherWhereInput = { organizationId, employeeId: input.employeeId, paymentMethod: "EMPLOYEE", status: "CLEARED", reimbursementId: null };
    if (input.voucherIds?.length) where.id = { in: input.voucherIds };
    const vs = await tx.pettyCashVoucher.findMany({ where });
    if (!vs.length) throw new LedgerError(["There are no cleared claims to reimburse for this employee"]);
    if (input.voucherIds?.length && vs.length !== new Set(input.voucherIds).size) throw new LedgerError(["Some claims are not cleared, already reimbursed, or belong to someone else"]);
    const r = await tx.pettyCashVoucher.updateMany({ where: { id: { in: vs.map((v) => v.id) }, reimbursementId: null }, data: { reimbursementId: lock } });
    if (r.count !== vs.length) throw new LedgerError(["Someone else is paying these claims; refresh and try again"]);
    const emp = await tx.employee.findUniqueOrThrow({ where: { id: input.employeeId } });
    const acct = await tx.account.findFirst({ where: { organizationId, systemRole: "EMPLOYEE_REIMB_PAYABLE" } });
    if (!acct) throw new LedgerError(["No account is assigned the role EMPLOYEE_REIMB_PAYABLE"]);
    return { vs, emp, acct };
  });
  try {
    const total = claimed.vs.reduce((s, v) => s + cents(v.totalPaid), 0n);
    const t = await saveCashTransaction({
      organizationId, userId, type: "DISBURSEMENT", bankAccountId: input.bankAccountId, date: asDay(input.date || new Date()),
      payee: `${claimed.emp.firstName} ${claimed.emp.lastName}`, partyType: claimed.emp.isPartner ? "PARTNER" : "EMPLOYEE", partyId: claimed.emp.code,
      method: input.method || "BANK_TRANSFER", checkNo: input.checkNo || null,
      reference: claimed.vs.map((v) => v.number).join(", ").slice(0, 190),
      memo: `Reimbursement of ${claimed.vs.length} expense claim${claimed.vs.length === 1 ? "" : "s"}`,
      lines: [{ accountId: claimed.acct.id, amount: fromCentavos(total), description: `Expense claims ${claimed.vs.map((v) => v.number).join(", ")}`.slice(0, 250) }],
      action: "submit",
    });
    await prisma.pettyCashVoucher.updateMany({ where: { reimbursementId: lock }, data: { reimbursementId: t.id } });
    return { cashTransactionId: t.id, number: t.number, total: fromCentavos(total), vouchers: claimed.vs.length };
  } catch (e) {
    await prisma.pettyCashVoucher.updateMany({ where: { reimbursementId: lock }, data: { reimbursementId: null } });
    throw e;
  }
}

/** Mark claims reimbursed once their disbursement is posted; free them if it was voided. */
export async function syncReimbursements(organizationId: string) {
  const pending = await prisma.pettyCashVoucher.findMany({ where: { organizationId, status: "CLEARED", reimbursementId: { not: null } }, select: { reimbursementId: true } });
  const ids = [...new Set(pending.map((p) => p.reimbursementId!).filter((x) => !x.startsWith("PENDING:")))];
  if (!ids.length) return;
  const txs = await prisma.cashTransaction.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
  const posted = txs.filter((t) => t.status === "POSTED").map((t) => t.id);
  const gone = [...txs.filter((t) => t.status === "VOID").map((t) => t.id), ...ids.filter((i) => !txs.some((t) => t.id === i))];
  if (posted.length) await prisma.pettyCashVoucher.updateMany({ where: { organizationId, status: "CLEARED", reimbursementId: { in: posted } }, data: { status: "REIMBURSED" } });
  if (gone.length) await prisma.pettyCashVoucher.updateMany({ where: { organizationId, status: "CLEARED", reimbursementId: { in: gone } }, data: { reimbursementId: null } });
}

// ---------- Replenishment batches ----------

/** Group approved vouchers into a replenishment batch and send its journal to the GL for approval. */
export async function createBatch(organizationId: string, userId: string, input: { fundId: string; voucherIds?: string[] | null; date?: string | null }, attachmentBase?: string | null) {
  return prisma.$transaction(async (tx) => {
    const fund = await tx.pettyCashFund.findFirst({ where: { id: input.fundId ?? "", organizationId } });
    if (!fund) throw new LedgerError(["Choose a petty cash fund"]);
    const where: Prisma.PettyCashVoucherWhereInput = { organizationId, fundId: fund.id, status: "CLEARED", paymentMethod: "PETTY_CASH_FUND", batchId: null };
    if (input.voucherIds?.length) where.id = { in: input.voucherIds };
    const vs = await tx.pettyCashVoucher.findMany({ where, include: { lines: { orderBy: { lineNo: "asc" } }, purchaseOrder: true }, orderBy: [{ receiptDate: "asc" }, { number: "asc" }] });
    if (!vs.length) throw new LedgerError(["There are no cleared vouchers to replenish for this fund"]);
    if (input.voucherIds?.length && vs.length !== new Set(input.voucherIds).size) throw new LedgerError(["Some vouchers are not cleared by finance, are already in a batch, or belong to another fund"]);

    const inputVat = await tx.account.findFirst({ where: { organizationId, systemRole: "INPUT_VAT" } });
    if (!inputVat && vs.some((v) => cents(v.vatAmount) > 0n)) throw new LedgerError(["No account is assigned the role INPUT_VAT"]);
    const ewtAcct = new Map<string, string | null>();
    for (const t of [...new Set(vs.map((v) => v.ewtTaxCodeId).filter(Boolean) as string[])]) ewtAcct.set(t, await ewtAccountOf(tx, organizationId, t));
    const vcodes = new Map((await tx.vendor.findMany({ where: { id: { in: vs.map((v) => v.vendorId).filter(Boolean) as string[] } } })).map((x) => [x.id, x.code]));
    const bvs: BatchVoucher[] = vs.map((v) => ({ ...toBatchVoucher(v as FullVoucher, v.ewtTaxCodeId ? ewtAcct.get(v.ewtTaxCodeId) ?? null : null), vendorId: v.vendorId ? vcodes.get(v.vendorId) ?? null : null }));
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
