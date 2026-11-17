// Pick lists for master form fields that hold the code of another master record (Field.ref).
import "server-only";
import type { DimensionType } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { LookupOption } from "@/components/MasterLookup";
import type { Field, MasterKind } from "./config";

async function load(kind: MasterKind, organizationId: string, type?: string): Promise<LookupOption[]> {
  const where = { organizationId };
  const orderBy = { code: "asc" as const };
  const coded = (rows: { code: string; name: string }[]) => rows.map((r) => ({ value: r.code, code: r.code, label: r.name }));
  switch (kind) {
    case "accounts": return (await prisma.account.findMany({ where, orderBy, select: { code: true, name: true, type: true } })).map((a) => ({ value: a.code, code: a.code, label: a.name, group: a.type }));
    case "currencies": return coded(await prisma.currency.findMany({ where, orderBy, select: { code: true, name: true } }));
    case "dimensions": return coded(await prisma.dimensionValue.findMany({ where: { ...where, ...(type ? { type: type as DimensionType } : {}) }, orderBy, select: { code: true, name: true } }));
    case "warehouses": return coded(await prisma.warehouse.findMany({ where, orderBy, select: { code: true, name: true } }));
    case "locations": return (await prisma.warehouseLocation.findMany({ where, orderBy, select: { code: true, name: true, warehouse: { select: { code: true } } } }))
      .filter((l, i, all) => all.findIndex((x) => x.code === l.code) === i).map((l) => ({ value: l.code, code: l.code, label: l.name, hint: l.warehouse.code }));
    case "vendors": return coded(await prisma.vendor.findMany({ where, orderBy, select: { code: true, name: true } }));
    case "customers": return coded(await prisma.customer.findMany({ where, orderBy, select: { code: true, name: true } }));
    case "employees": return (await prisma.employee.findMany({ where, orderBy, select: { code: true, firstName: true, lastName: true } })).map((e) => ({ value: e.code, code: e.code, label: `${e.firstName} ${e.lastName}`.trim() }));
    case "asset-categories": return coded(await prisma.assetCategory.findMany({ where, orderBy, select: { code: true, name: true } }));
    default: return [];
  }
}

/** Options per field key. `dimType` is the dimension being edited, for a parent-code field of the same dimension. */
export async function refOptions(fields: Field[], organizationId: string, dimType?: string): Promise<Record<string, LookupOption[]>> {
  const cache = new Map<string, Promise<LookupOption[]>>();
  const out: Record<string, LookupOption[]> = {};
  for (const f of fields) {
    if (!f.ref) continue;
    const type = f.ref.sameType ? dimType : f.ref.type;
    const k = `${f.ref.kind}:${type ?? ""}`;
    if (!cache.has(k)) cache.set(k, load(f.ref.kind, organizationId, type));
    out[f.key] = await cache.get(k)!;
  }
  return out;
}
