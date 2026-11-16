import { prisma } from "./db";
import { DIMENSIONS } from "./ledger/dimensions";

/** Options the journal entry form needs: accounts, dimension values, currencies. */
export async function journalFormData(organizationId: string) {
  const [accounts, dimValues, currencies, org] = await Promise.all([
    prisma.account.findMany({
      where: { organizationId, isPostable: true, isActive: true, allowManualPosting: true },
      select: { id: true, code: true, name: true, type: true, currencyCode: true }, orderBy: { code: "asc" },
    }),
    prisma.dimensionValue.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.currency.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, include: { _count: { select: { children: true } } } }),
  ]);
  const dims = DIMENSIONS.map((d) => ({
    key: d.key, label: d.label,
    values: dimValues.filter((v) => v.type === d.type).map((v) => ({ id: v.id, code: v.code, name: v.name })),
  })).filter((d) => d.values.length);
  return {
    accounts, dims, baseCurrency: org.baseCurrency, requireApproval: org.requireApproval, hasGroup: org._count.children > 0,
    currencies: currencies.map((c) => ({ code: c.code, rate: c.rateToBase.toString() })),
  };
}
