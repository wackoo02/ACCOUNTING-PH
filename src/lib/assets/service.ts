// Fixed assets sub-ledger (PAS 16): additions, improvements, transfers, disposals, retirements and
// the monthly depreciation run. Every GL effect goes through recordJournalTx with source FIXED_ASSETS.
// Every change to cost or accumulated depreciation is a FixedAssetTxn, so reports can be rebuilt as of any date.
import { Prisma, type FixedAsset } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { LedgerError, asDay, audit, nextNumber, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import type { LineInput } from "../ledger/validate";
import { METHODS, catchUp, disposalThroughIdx, idxLabel, monthEnd, monthIdx, notReady, type DepState } from "./depreciation";

type Tx = Prisma.TransactionClient;
const c = (d: Prisma.Decimal | string | number | null | undefined) => toCentavos(d?.toString() ?? "0");
const dec = (x: bigint) => new Prisma.Decimal(fromCentavos(x));
const money = (v: string | number | null | undefined, label: string) => {
  try { return toCentavos(v ?? "0"); } catch { throw new LedgerError([`${label}: enter an amount with up to 2 decimals`]); }
};
const clean = (s?: string | null) => (s ?? "").trim() || null;
export const OFF_BOOKS = ["DISPOSED", "RETIRED", "CANCELLED"];

export const TXN_LABEL: Record<string, string> = {
  OPENING: "Opening balance", ADDITION: "Addition", IMPROVEMENT: "Improvement", TRANSFER: "Transfer",
  DEPRECIATION: "Depreciation", DISPOSAL: "Disposal (sale)", RETIREMENT: "Retirement / write-off",
};

// ---------- lookups ----------

async function accountId(tx: Tx, organizationId: string, code: string | null | undefined, label: string, errors: string[]) {
  if (!code) { errors.push(`Set the ${label}`); return null; }
  const a = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code } } });
  if (!a) { errors.push(`${label}: account ${code} not found`); return null; }
  if (!a.isPostable || !a.isActive) { errors.push(`${label}: ${a.code} ${a.name} is a header or inactive account`); return null; }
  return a.id;
}

async function dimsOf(tx: Tx, organizationId: string, a: Pick<FixedAsset, "departmentCode" | "costCenterCode">) {
  const find = async (type: "DEPARTMENT" | "COST_CENTER", code: string | null) => code
    ? (await tx.dimensionValue.findUnique({ where: { organizationId_type_code: { organizationId, type, code } } }))?.id ?? null : null;
  return { departmentId: await find("DEPARTMENT", a.departmentCode), costCenterId: await find("COST_CENTER", a.costCenterCode) };
}

export const stateOf = (a: FixedAsset): DepState => ({
  cost: c(a.cost), salvage: c(a.salvageValue), accum: c(a.accumulatedDepreciation), lifeMonths: a.usefulLifeMonths,
  method: a.depreciationMethod, inService: a.inServiceDate ?? a.acquisitionDate,
});
const throughIdx = (a: FixedAsset) => (a.depreciatedThrough ? monthIdx(a.depreciatedThrough) : null);

/** Snapshot of the fields a transaction changes, so it can be undone. */
const snap = (a: FixedAsset) => ({
  cost: a.cost.toString(), accumulatedDepreciation: a.accumulatedDepreciation.toString(), usefulLifeMonths: a.usefulLifeMonths,
  depreciatedThrough: a.depreciatedThrough?.toISOString().slice(0, 10) ?? null, status: a.status, isActive: a.isActive,
  disposedAt: a.disposedAt?.toISOString().slice(0, 10) ?? null, location: a.location, custodianCode: a.custodianCode,
  departmentCode: a.departmentCode, costCenterCode: a.costCenterCode,
});
type Snap = ReturnType<typeof snap>;
const unsnap = (s: Snap) => ({
  cost: new Prisma.Decimal(s.cost), accumulatedDepreciation: new Prisma.Decimal(s.accumulatedDepreciation), usefulLifeMonths: s.usefulLifeMonths,
  depreciatedThrough: s.depreciatedThrough ? new Date(s.depreciatedThrough) : null, status: s.status, isActive: s.isActive,
  disposedAt: s.disposedAt ? new Date(s.disposedAt) : null, location: s.location, custodianCode: s.custodianCode,
  departmentCode: s.departmentCode, costCenterCode: s.costCenterCode,
});

async function assetFor(tx: Tx, organizationId: string, id: string) {
  const a = await tx.fixedAsset.findFirst({ where: { id, organizationId } });
  if (!a) throw new LedgerError(["Asset not found"]);
  return a;
}

/** Next free asset number for a prefix, e.g. FA-000001 or IT-000001. */
export async function nextAssetCode(tx: Tx, organizationId: string, prefix = "FA") {
  const p = (prefix || "FA").toUpperCase();
  for (;;) {
    const seq = await tx.documentSequence.upsert({
      where: { organizationId_key: { organizationId, key: `ASSET-${p}` } },
      create: { organizationId, key: `ASSET-${p}`, next: 2 }, update: { next: { increment: 1 } },
    });
    const code = `${p}-${String(seq.next - 1).padStart(6, "0")}`;
    if (!(await tx.fixedAsset.findUnique({ where: { organizationId_code: { organizationId, code } } }))) return code;
  }
}

async function newTxn(tx: Tx, organizationId: string, userId: string, assetId: string, type: string, date: Date, data: Partial<Prisma.FixedAssetTxnUncheckedCreateInput>) {
  const number = await nextNumber(tx, organizationId, "FAT", date.getUTCFullYear());
  return tx.fixedAssetTxn.create({ data: { organizationId, assetId, number, type, date, createdById: userId, ...data } });
}

// ---------- additions ----------

export type AdditionInput = {
  code?: string | null; name: string; categoryCode?: string | null; serialNo?: string | null; location?: string | null;
  departmentCode?: string | null; costCenterCode?: string | null; custodianCode?: string | null; vendorCode?: string | null; poNumber?: string | null;
  acquisitionDate: Date; inServiceDate?: Date | null; cost: string; salvageValue?: string | null; usefulLifeMonths?: number | null; depreciationMethod?: string | null;
  accountCode?: string | null; accumDepAccountCode?: string | null; depExpenseAccountCode?: string | null;
  /** true: Dr asset / Cr offsetAccountCode. false: already in the GL (AP bill, opening balance). */
  postToGl: boolean; offsetAccountCode?: string | null; reference?: string | null; memo?: string | null;
  /** Registered from a posted supplier bill line (already in the GL through AP). */
  apBillLineId?: string | null;
  /** Assets brought in already partly depreciated (only when not posting to the GL). */
  openingAccum?: string | null; depreciatedThrough?: Date | null;
  /** Require full depreciation setup even when not posting (the web form does; the Excel upload doesn't). */
  strict?: boolean;
};

/** Resolve category defaults onto the asset's own fields; checks accounts and dates. */
export async function settleSetup(tx: Tx, organizationId: string, i: Omit<AdditionInput, "acquisitionDate">, errors: string[], strict = true) {
  const cat = i.categoryCode ? await tx.assetCategory.findUnique({ where: { organizationId_code: { organizationId, code: i.categoryCode.toUpperCase() } } }) : null;
  if (i.categoryCode && !cat) errors.push(`Asset category ${i.categoryCode} not found`);
  const method = (i.depreciationMethod || cat?.depreciationMethod || "STRAIGHT_LINE").toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) errors.push(`Depreciation method must be one of ${METHODS.join(", ")}`);
  const cost = money(i.cost, "Acquisition cost");
  if (cost < 0n) errors.push("Acquisition cost cannot be negative");
  const salvage = i.salvageValue !== null && i.salvageValue !== undefined && String(i.salvageValue).trim() !== ""
    ? money(i.salvageValue, "Salvage value") : cat ? (cost * c(cat.salvagePct)) / 10000n : 0n;
  if (salvage < 0n || salvage > cost) errors.push("Salvage value must be between zero and the cost");
  const life = i.usefulLifeMonths ?? cat?.usefulLifeMonths ?? null;
  if (method !== "NONE" && strict && !life) errors.push("Enter the useful life in months");
  if (life !== null && life <= 0) errors.push("Useful life must be at least 1 month");
  const accountCode = clean(i.accountCode) ?? cat?.assetAccountCode ?? null;
  const accumDepAccountCode = clean(i.accumDepAccountCode) ?? cat?.accumDepAccountCode ?? null;
  const depExpenseAccountCode = clean(i.depExpenseAccountCode) ?? cat?.depExpenseAccountCode ?? null;
  const assetAcct = strict || accountCode ? await accountId(tx, organizationId, accountCode, "GL asset account", errors) : null;
  if (method !== "NONE") {
    if (strict || accumDepAccountCode) await accountId(tx, organizationId, accumDepAccountCode, "accumulated depreciation account", errors);
    if (strict || depExpenseAccountCode) await accountId(tx, organizationId, depExpenseAccountCode, "depreciation expense account", errors);
  }
  for (const [type, code, label] of [["DEPARTMENT", i.departmentCode, "Department"], ["COST_CENTER", i.costCenterCode, "Cost center"]] as const) {
    if (code && !(await tx.dimensionValue.findUnique({ where: { organizationId_type_code: { organizationId, type, code: code.toUpperCase() } } }))) errors.push(`${label} ${code} not found in Dimensions`);
  }
  if (i.vendorCode && !(await tx.vendor.findUnique({ where: { organizationId_code: { organizationId, code: i.vendorCode.toUpperCase() } } }))) errors.push(`Vendor ${i.vendorCode} not found`);
  if (i.custodianCode && !(await tx.employee.findUnique({ where: { organizationId_code: { organizationId, code: i.custodianCode.toUpperCase() } } }))) errors.push(`Custodian employee ${i.custodianCode} not found`);
  return { cat, method, cost, salvage, life, accountCode, accumDepAccountCode, depExpenseAccountCode, assetAcct };
}

export async function addAsset(organizationId: string, userId: string, i: AdditionInput) {
  return prisma.$transaction((tx) => addAssetTx(tx, organizationId, userId, i));
}

export async function addAssetTx(tx: Tx, organizationId: string, userId: string, i: Omit<AdditionInput, "acquisitionDate"> & { acquisitionDate?: Date | null }) {
  {
    const errors: string[] = [];
    if (!i.name?.trim()) errors.push("Enter the asset description");
    const s = await settleSetup(tx, organizationId, i, errors, i.postToGl || !!i.strict);
    if (i.postToGl && s.cost <= 0n) errors.push("Enter the acquisition cost");
    if (i.postToGl && !i.acquisitionDate) errors.push("Enter the purchase date");
    const acq = i.acquisitionDate ? asDay(i.acquisitionDate) : null;
    const inService = i.inServiceDate ? asDay(i.inServiceDate) : acq;
    if (acq && inService && inService < acq) errors.push("The in-service date cannot be before the acquisition date");
    const openingAccum = money(i.openingAccum, "Accumulated depreciation");
    if (openingAccum && i.postToGl) errors.push("Opening accumulated depreciation is only for assets already in the books (don't post to the GL)");
    if (openingAccum < 0n || openingAccum > s.cost - s.salvage) errors.push("Opening accumulated depreciation must be between zero and cost less salvage");
    if (openingAccum && !i.depreciatedThrough) errors.push("Enter the month the opening accumulated depreciation runs through");
    const offsetId = i.postToGl ? await accountId(tx, organizationId, clean(i.offsetAccountCode), "account to credit (e.g. Accounts Payable or cash)", errors) : null;
    if (i.apBillLineId) {
      if (i.postToGl) errors.push("This asset came from a posted supplier bill, so it is already in the GL. Don't post it again.");
      const line = await tx.apBillLine.findFirst({ where: { id: i.apBillLineId, bill: { organizationId, status: "POSTED" } } });
      if (!line) errors.push("Supplier bill line not found or not posted");
      const used = await tx.fixedAsset.findFirst({ where: { organizationId, apBillLineId: i.apBillLineId, status: { not: "CANCELLED" } } });
      if (used) errors.push(`That bill line is already registered as ${used.code}`);
    }
    let code = clean(i.code)?.toUpperCase() ?? null;
    if (code && (await tx.fixedAsset.findUnique({ where: { organizationId_code: { organizationId, code } } }))) errors.push(`Asset number ${code} is already used`);
    if (errors.length) throw new LedgerError(errors);
    code ??= await nextAssetCode(tx, organizationId, s.cat?.prefix ?? "FA");
    const through = i.depreciatedThrough ? monthEnd(monthIdx(i.depreciatedThrough)) : null;
    const asset = await tx.fixedAsset.create({ data: {
      organizationId, code, name: i.name.trim(), categoryCode: s.cat?.code ?? null, category: s.cat?.name ?? null,
      serialNo: clean(i.serialNo), location: clean(i.location), departmentCode: clean(i.departmentCode)?.toUpperCase() ?? null, costCenterCode: clean(i.costCenterCode)?.toUpperCase() ?? null,
      custodianCode: clean(i.custodianCode)?.toUpperCase() ?? null, vendorCode: clean(i.vendorCode)?.toUpperCase() ?? null, poNumber: clean(i.poNumber), apBillLineId: i.apBillLineId ?? null,
      acquisitionDate: acq, inServiceDate: inService, cost: dec(s.cost), salvageValue: dec(s.salvage), usefulLifeMonths: s.life, depreciationMethod: s.method,
      accountCode: s.accountCode, accumDepAccountCode: s.accumDepAccountCode, depExpenseAccountCode: s.depExpenseAccountCode,
      accumulatedDepreciation: dec(openingAccum), depreciatedThrough: through,
    } });
    let journalEntryId: string | null = null;
    if (i.postToGl) {
      const dims = await dimsOf(tx, organizationId, asset);
      const party = asset.vendorCode ? { partyType: "VENDOR", partyId: asset.vendorCode } : {};
      const je = await recordJournalTx(tx, {
        organizationId, userId, date: acq!, memo: `Asset addition ${code} ${asset.name}`, reference: clean(i.reference) ?? asset.poNumber, source: "FIXED_ASSETS", sourceId: asset.id, action: "post",
        lines: [
          { accountId: s.assetAcct!, debit: fromCentavos(s.cost), description: `${code} ${asset.name}`, dims },
          { accountId: offsetId!, credit: fromCentavos(s.cost), description: `${code} ${asset.name}`, ...party },
        ],
      });
      journalEntryId = je.id;
    }
    await newTxn(tx, organizationId, userId, asset.id, i.postToGl || i.apBillLineId ? "ADDITION" : "OPENING", acq ?? asDay(new Date()), {
      costChange: dec(s.cost), accumChange: dec(openingAccum), journalEntryId, memo: clean(i.memo) ?? (i.postToGl ? "Asset acquired" : i.apBillLineId ? "Registered from supplier bill (posted through Payables)" : "Brought into the register (already in the GL)"),
      reference: clean(i.reference), details: { offsetAccountCode: i.postToGl ? clean(i.offsetAccountCode) : null, depreciatedThrough: through?.toISOString().slice(0, 10) ?? null },
    });
    await audit(tx, organizationId, userId, "asset.add", asset.id, { code, cost: fromCentavos(s.cost), postedToGl: i.postToGl }, null, null, "fixed_asset");
    return asset;
  }
}

// ---------- improvements (subsequent costs that meet PAS 16 recognition) ----------

export async function improveAsset(organizationId: string, userId: string, i: {
  assetId: string; date: Date; amount: string; extendLifeMonths?: number | null; postToGl: boolean; offsetAccountCode?: string | null; vendorCode?: string | null; reference?: string | null; memo: string;
}) {
  return prisma.$transaction(async (tx) => {
    const a = await assetFor(tx, organizationId, i.assetId);
    const errors: string[] = [];
    if (OFF_BOOKS.includes(a.status)) errors.push(`Asset is ${a.status.toLowerCase()}`);
    const amt = money(i.amount, "Amount");
    if (amt <= 0n) errors.push("Enter the amount capitalized");
    if (!i.memo?.trim()) errors.push("Describe the improvement");
    const ext = i.extendLifeMonths ?? 0;
    if (ext < 0) errors.push("Useful life extension cannot be negative");
    const date = asDay(i.date);
    if (a.acquisitionDate && date < a.acquisitionDate) errors.push("The improvement date is before the asset was acquired");
    const assetAcct = await accountId(tx, organizationId, a.accountCode, "GL asset account (set it on the asset)", errors);
    const offsetId = i.postToGl ? await accountId(tx, organizationId, clean(i.offsetAccountCode), "account to credit", errors) : null;
    if (errors.length) throw new LedgerError(errors);
    let journalEntryId: string | null = null;
    if (i.postToGl) {
      const dims = await dimsOf(tx, organizationId, a);
      const vendor = clean(i.vendorCode)?.toUpperCase() ?? a.vendorCode;
      const je = await recordJournalTx(tx, {
        organizationId, userId, date, memo: `Improvement to ${a.code} ${a.name}: ${i.memo.trim()}`, reference: clean(i.reference), source: "FIXED_ASSETS", sourceId: a.id, action: "post",
        lines: [
          { accountId: assetAcct!, debit: fromCentavos(amt), description: i.memo.trim(), dims },
          { accountId: offsetId!, credit: fromCentavos(amt), description: `${a.code} improvement`, ...(vendor ? { partyType: "VENDOR", partyId: vendor } : {}) },
        ],
      });
      journalEntryId = je.id;
    }
    await newTxn(tx, organizationId, userId, a.id, "IMPROVEMENT", date, {
      costChange: dec(amt), lifeChangeMonths: ext || null, journalEntryId, memo: i.memo.trim(), reference: clean(i.reference),
      details: { before: snap(a), offsetAccountCode: i.postToGl ? clean(i.offsetAccountCode) : null },
    });
    const updated = await tx.fixedAsset.update({ where: { id: a.id }, data: { cost: dec(c(a.cost) + amt), usefulLifeMonths: a.usefulLifeMonths !== null ? a.usefulLifeMonths + ext : a.usefulLifeMonths } });
    await audit(tx, organizationId, userId, "asset.improve", a.id, { code: a.code, amount: fromCentavos(amt), extendLifeMonths: ext }, null, null, "fixed_asset");
    return updated;
  });
}

// ---------- transfers (location, custodian, department / cost center) ----------

export async function transferAsset(organizationId: string, userId: string, i: {
  assetId: string; date: Date; location?: string | null; custodianCode?: string | null; departmentCode?: string | null; costCenterCode?: string | null; reference?: string | null; memo?: string | null;
}) {
  return prisma.$transaction(async (tx) => transferTx(tx, organizationId, userId, i));
}

export async function transferTx(tx: Tx, organizationId: string, userId: string, i: Parameters<typeof transferAsset>[2]) {
  const a = await assetFor(tx, organizationId, i.assetId);
  const errors: string[] = [];
  if (OFF_BOOKS.includes(a.status)) errors.push(`Asset is ${a.status.toLowerCase()}`);
  const to = {
    location: i.location === undefined ? a.location : clean(i.location),
    custodianCode: i.custodianCode === undefined ? a.custodianCode : clean(i.custodianCode)?.toUpperCase() ?? null,
    departmentCode: i.departmentCode === undefined ? a.departmentCode : clean(i.departmentCode)?.toUpperCase() ?? null,
    costCenterCode: i.costCenterCode === undefined ? a.costCenterCode : clean(i.costCenterCode)?.toUpperCase() ?? null,
  };
  const from = { location: a.location, custodianCode: a.custodianCode, departmentCode: a.departmentCode, costCenterCode: a.costCenterCode };
  const changed = (Object.keys(to) as (keyof typeof to)[]).filter((k) => (to[k] ?? "") !== (from[k] ?? ""));
  if (!changed.length) errors.push("Nothing to transfer: the location, custodian, department and cost center are unchanged");
  if (to.custodianCode && !(await tx.employee.findUnique({ where: { organizationId_code: { organizationId, code: to.custodianCode } } }))) errors.push(`Employee ${to.custodianCode} not found`);
  for (const [type, code, label] of [["DEPARTMENT", to.departmentCode, "Department"], ["COST_CENTER", to.costCenterCode, "Cost center"]] as const) {
    if (code && !(await tx.dimensionValue.findUnique({ where: { organizationId_type_code: { organizationId, type, code } } }))) errors.push(`${label} ${code} not found in Dimensions`);
  }
  if (errors.length) throw new LedgerError(errors);
  const date = asDay(i.date);
  await newTxn(tx, organizationId, userId, a.id, "TRANSFER", date, { memo: clean(i.memo), reference: clean(i.reference), details: { before: snap(a), from, to, changed } });
  const moved = to.location !== from.location;
  const updated = await tx.fixedAsset.update({ where: { id: a.id }, data: { ...to, ...(moved && a.status === "MISSING" ? { status: "ACTIVE" } : {}) } });
  await audit(tx, organizationId, userId, "asset.transfer", a.id, { code: a.code, from, to }, null, null, "fixed_asset");
  return updated;
}

// ---------- disposals and retirements ----------

export async function disposeAsset(organizationId: string, userId: string, i: {
  assetId: string; type: "DISPOSAL" | "RETIREMENT"; date: Date; proceeds?: string | null; outputVat?: string | null; proceedsAccountCode?: string | null;
  gainLossAccountCode?: string | null; buyer?: string | null; customerCode?: string | null; reference?: string | null; memo: string;
}) {
  return prisma.$transaction(async (tx) => {
    const a = await assetFor(tx, organizationId, i.assetId);
    const errors: string[] = [];
    if (OFF_BOOKS.includes(a.status)) errors.push(`Asset is already ${a.status.toLowerCase()}`);
    if (!i.memo?.trim()) errors.push(i.type === "DISPOSAL" ? "Enter the reason / details of the sale" : "Enter the reason for retiring the asset (scrapped, lost, donated...)");
    const date = asDay(i.date);
    if (a.acquisitionDate && date < a.acquisitionDate) errors.push("The disposal date is before the asset was acquired");
    const proceeds = i.type === "DISPOSAL" ? money(i.proceeds, "Selling price") : 0n;
    const vat = i.type === "DISPOSAL" ? money(i.outputVat, "Output VAT") : 0n;
    if (proceeds < 0n || vat < 0n) errors.push("Amounts cannot be negative");
    const through = disposalThroughIdx(date);
    const done = throughIdx(a);
    if (done !== null && done > through) errors.push(`Depreciation is already charged through ${idxLabel(done)}. Date the disposal later, or undo the later depreciation run first.`);
    const st = stateOf(a);
    const why = notReady(st);
    const cu = catchUp(st, done, through);
    const accumBefore = c(a.accumulatedDepreciation);
    const cost = c(a.cost);
    const nbv = cost - accumBefore - cu.total;
    const gain = proceeds - nbv;
    const assetAcct = await accountId(tx, organizationId, a.accountCode, "GL asset account", errors);
    const accumAcct = accumBefore > 0n ? await accountId(tx, organizationId, a.accumDepAccountCode, "accumulated depreciation account", errors) : null;
    const expAcct = cu.total > 0n ? await accountId(tx, organizationId, a.depExpenseAccountCode, "depreciation expense account", errors) : null;
    const procAcct = proceeds + vat > 0n ? await accountId(tx, organizationId, clean(i.proceedsAccountCode), "account receiving the proceeds (cash or receivable)", errors) : null;
    let vatAcct: string | null = null;
    if (vat > 0n) {
      const v = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: "OUTPUT_VAT" } } });
      if (!v) errors.push("No account has the OUTPUT_VAT role"); else vatAcct = v.id;
    }
    let glAcct: string | null = null;
    if (gain !== 0n) {
      const code = clean(i.gainLossAccountCode) ?? (await defaultGainLossCode(tx, organizationId, gain > 0n));
      glAcct = await accountId(tx, organizationId, code, gain > 0n ? "gain on disposal account" : "loss on disposal account", errors);
    }
    if (errors.length) throw new LedgerError(errors);
    const dims = await dimsOf(tx, organizationId, a);
    const customer = clean(i.customerCode)?.toUpperCase();
    const lines: LineInput[] = [];
    const desc = `${a.code} ${a.name}`;
    if (cu.total > 0n) lines.push({ accountId: expAcct!, debit: fromCentavos(cu.total), description: `Depreciation to disposal date (${cu.months.map((m) => m.period).join(", ")})`, dims });
    if (accumBefore > 0n) lines.push({ accountId: accumAcct!, debit: fromCentavos(accumBefore), description: `Accumulated depreciation, ${desc}`, dims });
    if (proceeds + vat > 0n) lines.push({ accountId: procAcct!, debit: fromCentavos(proceeds + vat), description: `Proceeds, ${desc}${i.buyer ? ` (${i.buyer.trim()})` : ""}`, ...(customer ? { partyType: "CUSTOMER", partyId: customer } : {}) });
    if (vat > 0n) lines.push({ accountId: vatAcct!, credit: fromCentavos(vat), description: `Output VAT on sale of ${a.code}` });
    if (cost > 0n) lines.push({ accountId: assetAcct!, credit: fromCentavos(cost), description: `Cost derecognized, ${desc}`, dims });
    if (gain > 0n) lines.push({ accountId: glAcct!, credit: fromCentavos(gain), description: `Gain on ${i.type === "DISPOSAL" ? "sale" : "retirement"} of ${a.code}`, dims });
    if (gain < 0n) lines.push({ accountId: glAcct!, debit: fromCentavos(-gain), description: `Loss on ${i.type === "DISPOSAL" ? "sale" : "retirement"} of ${a.code}`, dims });
    const je = lines.length ? await recordJournalTx(tx, {
      organizationId, userId, date, memo: `${i.type === "DISPOSAL" ? "Sale" : "Retirement"} of ${desc}: ${i.memo.trim()}`, reference: clean(i.reference), source: "FIXED_ASSETS", sourceId: a.id, action: "post", lines,
    }) : null;
    const newThrough = !why && (done === null || through > done) ? monthEnd(through) : a.depreciatedThrough;
    await newTxn(tx, organizationId, userId, a.id, i.type, date, {
      costChange: dec(-cost), accumChange: dec(-accumBefore), depreciation: dec(cu.total), proceeds: dec(proceeds), gainLoss: dec(gain), journalEntryId: je?.id ?? null,
      memo: i.memo.trim(), reference: clean(i.reference), prevDepreciatedThrough: a.depreciatedThrough,
      details: { before: snap(a), buyer: clean(i.buyer), customerCode: customer ?? null, outputVat: fromCentavos(vat), months: cu.months.map((m) => ({ period: m.period, amount: fromCentavos(m.amount) })), nbv: fromCentavos(nbv) },
    });
    const updated = await tx.fixedAsset.update({ where: { id: a.id }, data: {
      status: i.type === "DISPOSAL" ? "DISPOSED" : "RETIRED", isActive: false, disposedAt: date,
      accumulatedDepreciation: dec(accumBefore + cu.total), depreciatedThrough: newThrough,
    } });
    await audit(tx, organizationId, userId, i.type === "DISPOSAL" ? "asset.dispose" : "asset.retire", a.id, { code: a.code, proceeds: fromCentavos(proceeds), gainLoss: fromCentavos(gain) }, null, null, "fixed_asset");
    return updated;
  });
}

async function defaultGainLossCode(tx: Tx, organizationId: string, gain: boolean) {
  const role = gain ? "FA_DISPOSAL_GAIN" : "FA_DISPOSAL_LOSS";
  const byRole = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: role } } });
  if (byRole) return byRole.code;
  const fallback = gain ? "7030" : "7545";
  if (await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: fallback } } })) return fallback;
  return "7030"; // net "gain (loss) on disposal" in other income
}

// ---------- undo the latest transaction on an asset ----------

export async function voidAssetTxn(organizationId: string, userId: string, txnId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const t = await tx.fixedAssetTxn.findFirst({ where: { id: txnId, organizationId } });
    if (!t || t.status !== "POSTED") throw new LedgerError(["Transaction not found or already void"]);
    if (!reason?.trim()) throw new LedgerError(["Enter the reason for undoing it"]);
    if (t.type === "DEPRECIATION") throw new LedgerError(["Depreciation is undone from the Depreciation screen (undo the whole run)"]);
    if (t.type === "OPENING") throw new LedgerError(["Opening balances are changed from the Master List upload or the asset's edit screen"]);
    const latest = await tx.fixedAssetTxn.findFirst({ where: { assetId: t.assetId, status: "POSTED" }, orderBy: [{ createdAt: "desc" }] });
    if (latest?.id !== t.id) throw new LedgerError([`Only the asset's latest transaction can be undone (latest is ${latest?.number})`]);
    const a = await assetFor(tx, organizationId, t.assetId);
    if (t.journalEntryId) await voidOrReverseTx(tx, organizationId, userId, t.journalEntryId, undefined, true);
    await tx.fixedAssetTxn.update({ where: { id: t.id }, data: { status: "VOID", details: { ...(t.details as object ?? {}), voidReason: reason.trim(), voidedById: userId } } });
    const before = (t.details as { before?: Snap } | null)?.before;
    if (t.type === "TRANSFER") await tx.fixedAsset.update({ where: { id: a.id }, data: (t.details as { from: Record<string, string | null> }).from });
    else if (t.type === "ADDITION") await tx.fixedAsset.update({ where: { id: a.id }, data: { status: "CANCELLED", isActive: false, cost: 0, apBillLineId: null } });
    else if (before) await tx.fixedAsset.update({ where: { id: a.id }, data: unsnap(before) });
    await audit(tx, organizationId, userId, "asset.txn_void", a.id, { code: a.code, number: t.number, type: t.type, reason: reason.trim() }, null, null, "fixed_asset");
  });
}

// ---------- monthly depreciation ----------

type PreviewRow = { asset: FixedAsset; amount: bigint; months: { period: string; amount: bigint }[] };

async function lastRun(tx: Tx | typeof prisma, organizationId: string) {
  return tx.depreciationRun.findFirst({ where: { organizationId, status: "POSTED" }, orderBy: [{ year: "desc" }, { month: "desc" }] });
}

/** What a run for year/month would charge, and which assets can't be depreciated yet and why. */
export async function previewDepreciation(organizationId: string, year: number, month: number, tx: Tx | typeof prisma = prisma) {
  const target = year * 12 + (month - 1);
  const assets = await tx.fixedAsset.findMany({ where: { organizationId, status: { notIn: OFF_BOOKS } }, orderBy: { code: "asc" } });
  const rows: PreviewRow[] = [];
  const skipped: { asset: FixedAsset; reason: string }[] = [];
  for (const a of assets) {
    const st = stateOf(a);
    if (a.depreciationMethod === "NONE") continue;
    const why = notReady(st);
    if (why) { skipped.push({ asset: a, reason: why }); continue; }
    if (!a.accumDepAccountCode || !a.depExpenseAccountCode) { skipped.push({ asset: a, reason: "no depreciation GL accounts" }); continue; }
    const cu = catchUp(st, throughIdx(a), target);
    if (cu.total > 0n) rows.push({ asset: a, amount: cu.total, months: cu.months });
  }
  const last = await lastRun(tx, organizationId);
  return { rows, skipped, total: rows.reduce((s, r) => s + r.amount, 0n), last, periodEnd: monthEnd(target) };
}

export async function runDepreciation(organizationId: string, userId: string, year: number, month: number) {
  return prisma.$transaction(async (tx) => {
    const target = year * 12 + (month - 1);
    const last = await lastRun(tx, organizationId);
    if (last && last.year * 12 + last.month - 1 >= target) throw new LedgerError([`Depreciation already ran for ${idxLabel(last.year * 12 + last.month - 1)}. Run a later month, or undo that run first.`]);
    const p = await previewDepreciation(organizationId, year, month, tx);
    if (!p.rows.length) throw new LedgerError(["Nothing to depreciate for this month"]);
    const accts = new Map<string, string>();
    const errors: string[] = [];
    for (const code of new Set(p.rows.flatMap((r) => [r.asset.accumDepAccountCode!, r.asset.depExpenseAccountCode!]))) {
      const id = await accountId(tx, organizationId, code, `account ${code}`, errors);
      if (id) accts.set(code, id);
    }
    if (errors.length) throw new LedgerError(errors);
    // One journal: Dr expense / Cr accumulated depreciation, grouped by account pair, department and cost center.
    const groups = new Map<string, { exp: string; acc: string; dims: Record<string, string | null>; amount: bigint; n: number }>();
    for (const r of p.rows) {
      const dims = await dimsOf(tx, organizationId, r.asset);
      const k = [r.asset.depExpenseAccountCode, r.asset.accumDepAccountCode, dims.departmentId, dims.costCenterId].join("|");
      const g = groups.get(k) ?? { exp: accts.get(r.asset.depExpenseAccountCode!)!, acc: accts.get(r.asset.accumDepAccountCode!)!, dims, amount: 0n, n: 0 };
      g.amount += r.amount; g.n++;
      groups.set(k, g);
    }
    const label = idxLabel(target);
    const lines: LineInput[] = [];
    for (const g of groups.values()) {
      lines.push({ accountId: g.exp, debit: fromCentavos(g.amount), description: `Depreciation ${label} (${g.n} asset${g.n === 1 ? "" : "s"})`, dims: g.dims });
      lines.push({ accountId: g.acc, credit: fromCentavos(g.amount), description: `Accumulated depreciation ${label}`, dims: g.dims });
    }
    const number = await nextNumber(tx, organizationId, "DEP", year);
    const run = await tx.depreciationRun.create({ data: { organizationId, number, year, month, periodEnd: p.periodEnd, total: dec(p.total), assetCount: p.rows.length, createdById: userId } });
    const je = await recordJournalTx(tx, { organizationId, userId, date: p.periodEnd, memo: `Depreciation for ${label} (${number})`, reference: number, source: "FIXED_ASSETS", sourceId: run.id, action: "post", lines });
    await tx.depreciationRun.update({ where: { id: run.id }, data: { journalEntryId: je.id } });
    for (const r of p.rows) {
      await newTxn(tx, organizationId, userId, r.asset.id, "DEPRECIATION", p.periodEnd, {
        accumChange: dec(r.amount), depreciation: dec(r.amount), runId: run.id, journalEntryId: je.id, prevDepreciatedThrough: r.asset.depreciatedThrough, reference: number,
        memo: r.months.length > 1 ? `Depreciation ${r.months[0].period} to ${label} (catch-up)` : `Depreciation ${label}`,
        details: { months: r.months.map((m) => ({ period: m.period, amount: fromCentavos(m.amount) })) },
      });
      await tx.fixedAsset.update({ where: { id: r.asset.id }, data: { accumulatedDepreciation: dec(c(r.asset.accumulatedDepreciation) + r.amount), depreciatedThrough: p.periodEnd } });
    }
    await audit(tx, organizationId, userId, "asset.depreciation_run", run.id, { number, period: label, total: fromCentavos(p.total), assets: p.rows.length }, null, null, "depreciation_run");
    return { ...run, journalEntryId: je.id };
  }, { timeout: 60_000 });
}

/** Undo the latest run: reverses its journal and restores each asset. */
export async function undoDepreciationRun(organizationId: string, userId: string, runId: string) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.depreciationRun.findFirst({ where: { id: runId, organizationId } });
    if (!run || run.status !== "POSTED") throw new LedgerError(["Run not found or already undone"]);
    const last = await lastRun(tx, organizationId);
    if (last?.id !== run.id) throw new LedgerError([`Undo the latest run first (${last?.number})`]);
    const txns = await tx.fixedAssetTxn.findMany({ where: { runId: run.id, status: "POSTED" } });
    const later = await tx.fixedAssetTxn.findFirst({ where: { assetId: { in: txns.map((t) => t.assetId) }, status: "POSTED", createdAt: { gt: run.createdAt }, type: { not: "TRANSFER" }, OR: [{ runId: null }, { runId: { not: run.id } }] }, include: { asset: true } });
    if (later) throw new LedgerError([`${later.asset.code} has a later transaction (${later.number}, ${TXN_LABEL[later.type] ?? later.type}). Undo it first.`]);
    if (run.journalEntryId) await voidOrReverseTx(tx, organizationId, userId, run.journalEntryId, run.periodEnd, true);
    for (const t of txns) {
      const a = await tx.fixedAsset.findUniqueOrThrow({ where: { id: t.assetId } });
      await tx.fixedAsset.update({ where: { id: a.id }, data: { accumulatedDepreciation: dec(c(a.accumulatedDepreciation) - c(t.depreciation)), depreciatedThrough: t.prevDepreciatedThrough } });
    }
    await tx.fixedAssetTxn.updateMany({ where: { runId: run.id }, data: { status: "VOID" } });
    await tx.depreciationRun.update({ where: { id: run.id }, data: { status: "REVERSED", reversedById: userId, reversedAt: new Date() } });
    await audit(tx, organizationId, userId, "asset.depreciation_undo", run.id, { number: run.number }, null, null, "depreciation_run");
  }, { timeout: 60_000 });
}

/** Accept the location seen in the last asset count as the asset's new location (records a transfer). */
export async function acceptSeenLocation(organizationId: string, userId: string, assetId: string) {
  return prisma.$transaction(async (tx) => {
    const a = await assetFor(tx, organizationId, assetId);
    if (!a.lastSeenLocation) throw new LedgerError(["This asset has not been scanned in a count yet"]);
    return transferTx(tx, organizationId, userId, { assetId, date: asDay(a.lastSeenAt ?? new Date()), location: a.lastSeenLocation, memo: "Location updated from asset count scan", reference: a.lastAuditId ? `Asset count` : null });
  });
}
