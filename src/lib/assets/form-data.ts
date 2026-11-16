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

/** Posted supplier bill lines classified as fixed assets that are not in the register yet. */
export async function unregisteredBillLines(organizationId: string) {
  const lines = await prisma.apBillLine.findMany({
    where: { category: "FIXED_ASSET", bill: { organizationId, status: "POSTED" } },
    include: { bill: { include: { lines: false } }, poLine: { include: { purchaseOrder: { select: { number: true } } } } },
    orderBy: { bill: { date: "desc" } }, take: 200,
  });
  const used = new Set((await prisma.fixedAsset.findMany({ where: { organizationId, apBillLineId: { in: lines.map((l) => l.id) }, status: { not: "CANCELLED" } }, select: { apBillLineId: true } })).map((a) => a.apBillLineId));
  const open = lines.filter((l) => !used.has(l.id));
  const [vendors, accounts] = await Promise.all([
    prisma.vendor.findMany({ where: { id: { in: [...new Set(open.map((l) => l.bill.vendorId))] } }, select: { id: true, code: true, name: true } }),
    prisma.account.findMany({ where: { id: { in: [...new Set(open.map((l) => l.accountId))] } }, select: { id: true, code: true } }),
  ]);
  const toBase = (net: { toString(): string }, rate: { toString(): string }) => (Number(net.toString()) * Number(rate.toString())).toFixed(2);
  return open.map((l) => ({
    id: l.id, description: l.description, quantity: Number(l.quantity.toString()), cost: toBase(l.netAmount, l.bill.fxRate),
    date: l.bill.date.toISOString().slice(0, 10), billNumber: l.bill.number, supplierInvoiceNo: l.bill.supplierInvoiceNo,
    poNumber: l.poLine?.purchaseOrder.number ?? null, vendor: vendors.find((v) => v.id === l.bill.vendorId) ?? null,
    accountCode: accounts.find((a) => a.id === l.accountId)?.code ?? null,
  }));
}
