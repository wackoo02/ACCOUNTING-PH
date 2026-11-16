// Master List saves (manual form and Excel upload) for asset categories and the fixed asset register.
// New assets from the register upload are opening balances (already in the GL); they get an OPENING
// transaction. Changes to location / custodian / department / cost center are recorded as transfers.
import { Prisma } from "@prisma/client";
import { fromCentavos, toCentavos } from "../money";
import { LedgerError } from "../ledger/service";
import { MasterError } from "../masters/store-error";
import { OFF_BOOKS, addAssetTx, settleSetup, transferTx } from "./service";
import { METHODS, monthEnd, monthIdx } from "./depreciation";

type Tx = Prisma.TransactionClient;
const str = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());
const up = (v: unknown) => str(v)?.toUpperCase() ?? null;

export async function saveAssetCategory(tx: Tx, organizationId: string, d: Record<string, unknown>) {
  const code = String(d.code);
  const errs: string[] = [];
  const acct = async (key: string, label: string, type?: string) => {
    const v = up(d[key]);
    if (!v) return null;
    const a = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: v } } });
    if (!a) errs.push(`${code}: ${label} ${v} not found`);
    else if (!a.isPostable) errs.push(`${code}: ${label} ${v} is a header account`);
    else if (type && a.type !== type) errs.push(`${code}: ${label} ${v} must be an ${type.toLowerCase()} account`);
    return v;
  };
  const method = (str(d.depreciationMethod) ?? "STRAIGHT_LINE").toUpperCase();
  const data = {
    name: String(d.name), prefix: up(d.prefix),
    assetAccountCode: (await acct("assetAccountCode", "GL asset account", "ASSET"))!,
    accumDepAccountCode: await acct("accumDepAccountCode", "accumulated depreciation account", "ASSET"),
    depExpenseAccountCode: await acct("depExpenseAccountCode", "depreciation expense account", "EXPENSE"),
    usefulLifeMonths: Number(d.usefulLifeMonths ?? 60), depreciationMethod: method,
    salvagePct: new Prisma.Decimal(String(d.salvagePct ?? 0)), isActive: (d.isActive as boolean | undefined) ?? true,
  };
  if (data.prefix && !/^[A-Z0-9]{1,8}$/.test(data.prefix)) errs.push(`${code}: prefix must be 1 to 8 letters or digits`);
  if (!(METHODS as readonly string[]).includes(method)) errs.push(`${code}: unknown depreciation method`);
  if (method !== "NONE" && (!data.accumDepAccountCode || !data.depExpenseAccountCode)) errs.push(`${code}: set the accumulated depreciation and depreciation expense accounts (or method NONE for land)`);
  if (data.usefulLifeMonths <= 0) errs.push(`${code}: useful life must be at least 1 month`);
  if (Number(data.salvagePct) < 0 || Number(data.salvagePct) > 100) errs.push(`${code}: salvage % must be 0 to 100`);
  if (errs.length) throw new MasterError(errs);
  const r = await tx.assetCategory.upsert({ where: { organizationId_code: { organizationId, code } }, create: { ...data, organizationId, code }, update: data });
  await tx.fixedAsset.updateMany({ where: { organizationId, categoryCode: code }, data: { category: data.name } });
  return r;
}

const cents = (v: unknown) => toCentavos(v === null || v === undefined || v === "" ? "0" : String(v));

export async function saveAssetMaster(tx: Tx, organizationId: string, userId: string, d: Record<string, unknown>) {
  const code = String(d.code);
  try {
    const existing = await tx.fixedAsset.findUnique({ where: { organizationId_code: { organizationId, code } } });
    const input = {
      code, name: String(d.name), categoryCode: up(d.categoryCode), serialNo: str(d.serialNo), location: str(d.location),
      departmentCode: up(d.departmentCode), costCenterCode: up(d.costCenterCode), custodianCode: up(d.custodianCode),
      vendorCode: up(d.vendorCode), poNumber: str(d.poNumber),
      acquisitionDate: (d.acquisitionDate as Date | undefined) ?? null, inServiceDate: (d.inServiceDate as Date | undefined) ?? null,
      cost: String(d.cost ?? "0"), salvageValue: str(d.salvageValue), usefulLifeMonths: (d.usefulLifeMonths as number | undefined) ?? null,
      depreciationMethod: str(d.depreciationMethod), accountCode: up(d.accountCode), accumDepAccountCode: up(d.accumDepAccountCode), depExpenseAccountCode: up(d.depExpenseAccountCode),
      openingAccum: str(d.accumulatedDepreciation), depreciatedThrough: (d.depreciatedThrough as Date | undefined) ?? null, postToGl: false as const,
    };
    const extra = { tagCode: up(d.tagCode), isActive: (d.isActive as boolean | undefined) ?? true };
    const status = str(d.status)?.toUpperCase();

    if (!existing) {
      const a = await addAssetTx(tx, organizationId, userId, { ...input, memo: "Brought into the register (Master List)" });
      return tx.fixedAsset.update({ where: { id: a.id }, data: { ...extra, category: a.category ?? str(d.category), ...(status ? { status } : {}) } });
    }

    // Existing asset: financial fields can change only while it has nothing but its opening balance.
    const errors: string[] = [];
    const s = await settleSetup(tx, organizationId, { ...input, usefulLifeMonths: input.usefulLifeMonths ?? existing.usefulLifeMonths }, errors, false);
    const accum = input.openingAccum === null ? toCentavos(existing.accumulatedDepreciation.toString()) : cents(input.openingAccum);
    const through = input.depreciatedThrough ? monthEnd(monthIdx(input.depreciatedThrough)) : null;
    const costChanged = s.cost !== toCentavos(existing.cost.toString());
    const accumChanged = accum !== toCentavos(existing.accumulatedDepreciation.toString());
    const throughChanged = (through?.getTime() ?? null) !== (existing.depreciatedThrough?.getTime() ?? null);
    if (costChanged || accumChanged || throughChanged) {
      const moved = await tx.fixedAssetTxn.findFirst({ where: { assetId: existing.id, status: "POSTED", type: { not: "OPENING" } } });
      if (moved) errors.push(`${code}: cost, accumulated depreciation and "depreciated through" can't be changed here because the asset has transactions (${moved.number}). Use an improvement, disposal or the depreciation run instead.`);
      if (accum < 0n || accum > s.cost - s.salvage) errors.push(`${code}: opening accumulated depreciation must be between zero and cost less salvage`);
    }
    if (OFF_BOOKS.includes(existing.status) && status && status !== existing.status) errors.push(`${code}: the asset is ${existing.status.toLowerCase()}; its status can't be changed here`);
    if (errors.length) throw new LedgerError(errors.map((e) => (e.startsWith(code) ? e : `${code}: ${e}`)));

    if (costChanged || accumChanged || throughChanged) {
      const opening = await tx.fixedAssetTxn.findFirst({ where: { assetId: existing.id, type: "OPENING", status: "POSTED" } });
      if (opening) await tx.fixedAssetTxn.update({ where: { id: opening.id }, data: { costChange: fromCentavos(s.cost), accumChange: fromCentavos(accum), ...(input.acquisitionDate ? { date: input.acquisitionDate } : {}) } });
      else await tx.fixedAssetTxn.create({ data: { organizationId, assetId: existing.id, number: `FAO-${code}`, type: "OPENING", date: input.acquisitionDate ?? new Date(), costChange: fromCentavos(s.cost), accumChange: fromCentavos(accum), memo: "Opening balance (Master List)", createdById: userId } });
    }
    const placement = { location: input.location, custodianCode: input.custodianCode, departmentCode: input.departmentCode, costCenterCode: input.costCenterCode };
    const placementChanged = (Object.keys(placement) as (keyof typeof placement)[]).some((k) => (placement[k] ?? "") !== (existing[k] ?? ""));
    if (placementChanged && !OFF_BOOKS.includes(existing.status)) {
      await transferTx(tx, organizationId, userId, { assetId: existing.id, date: new Date(), ...placement, memo: "Changed in the Master List" });
    }
    return tx.fixedAsset.update({ where: { id: existing.id }, data: {
      name: input.name, categoryCode: s.cat?.code ?? null, category: s.cat?.name ?? str(d.category) ?? existing.category, serialNo: input.serialNo,
      vendorCode: input.vendorCode, poNumber: input.poNumber, acquisitionDate: input.acquisitionDate, inServiceDate: input.inServiceDate ?? input.acquisitionDate,
      cost: fromCentavos(s.cost), salvageValue: fromCentavos(s.salvage), usefulLifeMonths: s.life, depreciationMethod: s.method,
      accountCode: s.accountCode, accumDepAccountCode: s.accumDepAccountCode, depExpenseAccountCode: s.depExpenseAccountCode,
      accumulatedDepreciation: fromCentavos(accum), depreciatedThrough: throughChanged ? through : existing.depreciatedThrough,
      ...placement, ...extra, ...(OFF_BOOKS.includes(existing.status) ? { isActive: false } : status ? { status } : {}),
    } });
  } catch (e) {
    if (e instanceof LedgerError) throw new MasterError(e.errors.map((x) => (x.startsWith(`${code}:`) ? x : `${code}: ${x}`)));
    throw e;
  }
}
