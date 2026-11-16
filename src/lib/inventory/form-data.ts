import { prisma } from "../db";
import { DIMENSIONS } from "../ledger/dimensions";

/** Options for the inventory document form. */
export async function inventoryFormData(organizationId: string) {
  const [items, warehouses, locations, accounts, dimValues, customers, vendors, employees] = await Promise.all([
    prisma.product.findMany({ where: { organizationId, isStocked: true, isActive: true }, orderBy: { code: "asc" } }),
    prisma.warehouse.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.warehouseLocation.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.account.findMany({ where: { organizationId, isPostable: true, isActive: true }, select: { id: true, code: true, name: true, type: true }, orderBy: { code: "asc" } }),
    prisma.dimensionValue.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    prisma.customer.findMany({ where: { organizationId, isActive: true }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
    prisma.vendor.findMany({ where: { organizationId, isActive: true }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
    prisma.employee.findMany({ where: { organizationId, isActive: true }, select: { code: true, firstName: true, lastName: true }, orderBy: { lastName: "asc" } }),
  ]);
  const lots = await prisma.inventoryLayer.findMany({
    where: { organizationId, qtyRemaining: { gt: 0 }, lotNo: { not: null }, item: { costingMethod: "SPECIFIC" } },
    select: { itemId: true, warehouseId: true, lotNo: true, qtyRemaining: true },
  });
  return {
    items: items.map((i) => ({ id: i.id, code: i.code, name: i.name, unit: i.unit, barcode: i.barcode, method: i.costingMethod, standardCost: i.standardCost.toString(), purchaseCost: i.purchaseCost.toString() })),
    warehouses: warehouses.map((w) => ({ id: w.id, code: w.code, name: w.name })),
    locations: locations.map((l) => ({ id: l.id, warehouseId: l.warehouseId, code: l.code, name: l.name })),
    accounts,
    dims: DIMENSIONS.map((d) => ({ key: d.key, label: d.label, values: dimValues.filter((v) => v.type === d.type).map((v) => ({ id: v.id, code: v.code, name: v.name })) })).filter((d) => d.values.length),
    parties: [
      ...vendors.map((v) => ({ value: `VENDOR:${v.code}`, label: `Vendor · ${v.name}` })),
      ...customers.map((c) => ({ value: `CUSTOMER:${c.code}`, label: `Customer · ${c.name}` })),
      ...employees.map((e) => ({ value: `EMPLOYEE:${e.code}`, label: `Employee · ${e.lastName}, ${e.firstName}` })),
    ],
    lots: lots.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId, lotNo: l.lotNo!, qty: l.qtyRemaining.toString() })),
  };
}
export type InventoryFormData = Awaited<ReturnType<typeof inventoryFormData>>;
