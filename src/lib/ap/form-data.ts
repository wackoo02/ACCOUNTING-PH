import { prisma } from "../db";
import { DIMENSIONS } from "../ledger/dimensions";

/** Options for purchasing and payables forms. */
export async function apFormData(organizationId: string) {
  const [vendors, accounts, dimValues, taxCodes, products, banks, currencies, org] = await Promise.all([
    prisma.vendor.findMany({ where: { organizationId, isActive: true }, orderBy: { name: "asc" } }),
    prisma.account.findMany({ where: { organizationId, isPostable: true, isActive: true, OR: [{ type: "EXPENSE" }, { type: "ASSET" }] }, select: { id: true, code: true, name: true, type: true, ifrsGroup: true }, orderBy: { code: "asc" } }),
    prisma.dimensionValue.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.taxCode.findMany({ where: { organizationId, isActive: true, taxType: "EWT" }, orderBy: { code: "asc" } }),
    prisma.product.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.bankAccount.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.currency.findMany({ where: { organizationId, isActive: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
  ]);
  const accountByCode = new Map(accounts.map((a) => [a.code, a.id]));
  return {
    vendors: vendors.map((v) => ({ id: v.id, code: v.code, name: v.name, tin: v.tin, terms: v.paymentTermsDays, vat: v.vatRegistered, currency: v.currencyCode, ewtTaxCodeId: taxCodes.find((t) => v.atcCode && (t.atcCode ?? t.code).toUpperCase() === v.atcCode.toUpperCase())?.id ?? "" })),
    accounts: accounts.filter((a) => !banks.some((b) => b.glAccountId === a.id)),
    dims: DIMENSIONS.map((d) => ({ key: d.key, label: d.label, values: dimValues.filter((v) => v.type === d.type).map((v) => ({ id: v.id, code: v.code, name: v.name })) })).filter((d) => d.values.length),
    taxCodes: taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate.toString(), atc: t.atcCode })),
    products: products.map((p) => ({ id: p.id, code: p.code, name: p.name, unit: p.unit, cost: p.purchaseCost.toString(), vatType: p.vatType, accountId: (p.expenseAccountCode && accountByCode.get(p.expenseAccountCode)) || "" })),
    banks: banks.map((b) => ({ id: b.id, code: b.code, name: b.name, kind: b.kind, currencyCode: b.currencyCode, nextCheckNo: b.nextCheckNo })),
    currencies: currencies.map((c) => ({ code: c.code, rate: c.rateToBase.toString() })),
    baseCurrency: org.baseCurrency,
    fixedAssetThreshold: org.fixedAssetThreshold.toString(),
  };
}
export type ApFormData = Awaited<ReturnType<typeof apFormData>>;
