import { prisma } from "../db";
import { DIMENSIONS } from "../ledger/dimensions";

/** Options for the cash voucher form. Sub-ledger-only accounts are allowed: vouchers post as BANK. */
export async function cashFormData(organizationId: string) {
  const [banks, accounts, dimValues, taxCodes, customers, vendors, employees, currencies, org] = await Promise.all([
    prisma.bankAccount.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.account.findMany({ where: { organizationId, isPostable: true, isActive: true }, select: { id: true, code: true, name: true, type: true, currencyCode: true }, orderBy: { code: "asc" } }),
    prisma.dimensionValue.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.taxCode.findMany({ where: { organizationId, isActive: true, taxType: { in: ["EWT", "FWT"] } }, orderBy: { code: "asc" } }),
    prisma.customer.findMany({ where: { organizationId, isActive: true }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
    prisma.vendor.findMany({ where: { organizationId, isActive: true }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { organizationId, isActive: true }, select: { code: true, firstName: true, lastName: true, isPartner: true }, orderBy: { lastName: "asc" } }),
    prisma.currency.findMany({ where: { organizationId, isActive: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
  ]);
  const bankGl = new Set(banks.map((b) => b.glAccountId));
  return {
    banks: banks.map((b) => ({ id: b.id, code: b.code, name: b.name, kind: b.kind, currencyCode: b.currencyCode, nextCheckNo: b.nextCheckNo, custodian: b.custodian })),
    accounts: accounts.filter((a) => !bankGl.has(a.id)),
    dims: DIMENSIONS.map((d) => ({ key: d.key, label: d.label, values: dimValues.filter((v) => v.type === d.type).map((v) => ({ id: v.id, code: v.code, name: v.name })) })).filter((d) => d.values.length),
    taxCodes: taxCodes.map((t) => ({ id: t.id, code: t.code, name: t.name, rate: t.rate.toString() })),
    parties: [
      ...customers.map((c) => ({ value: `CUSTOMER:${c.code}`, label: `Customer · ${c.name}`, name: c.name })),
      ...vendors.map((v) => ({ value: `VENDOR:${v.code}`, label: `Vendor · ${v.name}`, name: v.name })),
      ...employees.map((e) => ({ value: `${e.isPartner ? "PARTNER" : "EMPLOYEE"}:${e.code}`, label: `${e.isPartner ? "Partner" : "Employee"} · ${e.lastName}, ${e.firstName}`, name: `${e.firstName} ${e.lastName}` })),
    ],
    currencies: currencies.map((c) => ({ code: c.code, rate: c.rateToBase.toString() })),
    baseCurrency: org.baseCurrency, requireApproval: org.requireApproval,
  };
}
export type CashFormData = Awaited<ReturnType<typeof cashFormData>>;
