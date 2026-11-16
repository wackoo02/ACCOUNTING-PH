// Pick lists for the fixed asset forms.
import { prisma } from "../db";

export async function assetFormData(organizationId: string) {
  const [categories, accounts, employees, vendors, customers, dims] = await Promise.all([
    prisma.assetCategory.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.account.findMany({ where: { organizationId, isActive: true, isPostable: true }, orderBy: { code: "asc" }, select: { code: true, name: true, type: true } }),
    prisma.employee.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" }, select: { code: true, firstName: true, lastName: true } }),
    prisma.vendor.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" }, select: { code: true, name: true } }),
    prisma.customer.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" }, select: { code: true, name: true } }),
    prisma.dimensionValue.findMany({ where: { organizationId, isActive: true, type: { in: ["DEPARTMENT", "COST_CENTER"] } }, orderBy: { code: "asc" }, select: { code: true, name: true, type: true } }),
  ]);
  const locations = (await prisma.fixedAsset.findMany({ where: { organizationId, location: { not: null } }, distinct: ["location"], select: { location: true } })).map((x) => x.location!).sort();
  return {
    categories, accounts, vendors, customers, locations,
    employees: employees.map((e) => ({ code: e.code, name: [e.firstName, e.lastName].filter(Boolean).join(" ") })),
    departments: dims.filter((d) => d.type === "DEPARTMENT"), costCenters: dims.filter((d) => d.type === "COST_CENTER"),
  };
}
export type AssetFormData = Awaited<ReturnType<typeof assetFormData>>;
