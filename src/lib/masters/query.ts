import { prisma } from "../db";
import { MASTERS, type MasterKind } from "./config";

/** Fetch a master list as plain records keyed by the config field names. */
export async function listMasters(kind: MasterKind, organizationId: string, code?: string, type?: string): Promise<Record<string, unknown>[]> {
  const model = MASTERS[kind].model;
  const where = { organizationId, ...(code ? { code } : {}), ...(type && kind === "dimensions" ? { type: type as never } : {}) };
  if (kind === "accounts") {
    const rows = await prisma.account.findMany({ where, orderBy: { code: "asc" }, include: { parent: { select: { code: true } } } });
    return rows.map((r) => ({ ...r, parentCode: r.parent?.code ?? null }));
  }
  if (kind === "dimensions") {
    const rows = await prisma.dimensionValue.findMany({ where, orderBy: [{ type: "asc" }, { code: "asc" }], include: { parent: { select: { code: true } } } });
    return rows.map((r) => ({ ...r, parentCode: r.parent?.code ?? null }));
  }
  if (kind === "banks") {
    const rows = await prisma.bankAccount.findMany({ where, orderBy: { code: "asc" }, include: { glAccount: { select: { code: true } } } });
    return rows.map((r) => ({ ...r, glAccountCode: r.glAccount.code }));
  }
  if (kind === "locations") {
    const rows = await prisma.warehouseLocation.findMany({
      where: { organizationId, ...(code ? { code } : {}), ...(type ? { warehouse: { code: type } } : {}) },
      orderBy: [{ warehouse: { code: "asc" } }, { code: "asc" }], include: { warehouse: { select: { code: true } } },
    });
    return rows.map((r) => ({ ...r, warehouseCode: r.warehouse.code }));
  }
  const delegate = (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<Record<string, unknown>[]> }>)[model];
  return delegate.findMany({ where, orderBy: { code: "asc" } });
}
