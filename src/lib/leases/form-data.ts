import { prisma } from "../db";
import { DIMENSIONS } from "../ledger/dimensions";
import { defaultLeaseAccounts } from "./service";

/** Options for the lease form. */
export async function leaseFormData(organizationId: string) {
  const [accounts, vendors, taxCodes, currencies, dimValues, org, defaults] = await Promise.all([
    prisma.account.findMany({ where: { organizationId, isPostable: true, isActive: true }, select: { id: true, code: true, name: true, type: true }, orderBy: { code: "asc" } }),
    prisma.vendor.findMany({ where: { organizationId, isActive: true }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
    prisma.taxCode.findMany({ where: { organizationId, isActive: true, taxType: "EWT" }, orderBy: { code: "asc" } }),
    prisma.currency.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.dimensionValue.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    defaultLeaseAccounts(organizationId),
  ]);
  return {
    accounts, vendors,
    taxCodes: taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate.toString() })),
    currencies: currencies.map((c) => ({ code: c.code, rate: c.rateToBase.toString() })),
    dims: DIMENSIONS.map((d) => ({ key: d.key, label: d.label, values: dimValues.filter((v) => v.type === d.type).map((v) => ({ id: v.id, code: v.code, name: v.name })) })).filter((d) => d.values.length),
    baseCurrency: org.baseCurrency, defaults,
  };
}
export type LeaseFormData = Awaited<ReturnType<typeof leaseFormData>>;
