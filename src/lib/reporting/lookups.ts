// Pick lists for the report builder screen (server only).
import { prisma } from "../db";
import { DIMENSIONS } from "../ledger/dimensions";
import { ROLE_LABELS } from "../permissions";
import { reportableEntities } from "./run";
import type { BuilderLookups } from "@/components/reporting/ReportBuilder";
import type { Role } from "@prisma/client";

const JOURNAL_SOURCES = ["MANUAL", "OPENING_BALANCE", "SALES", "PURCHASES", "BANK", "INVENTORY", "FIXED_ASSETS", "PREPAID", "LEASE", "DEBT", "PAYROLL", "EXPENSE_CLAIM", "PETTY_CASH", "TAX", "CLOSING", "REVERSAL", "INTERCOMPANY", "CONSOLIDATION", "FX_REVALUATION"];

export async function builderLookups(userId: string, orgId: string): Promise<BuilderLookups> {
  const entities = await reportableEntities(userId);
  const ids = entities.map((e) => e.id);
  const [dims, accounts, members] = await Promise.all([
    prisma.dimensionValue.findMany({ where: { organizationId: { in: ids } }, orderBy: { code: "asc" } }),
    prisma.account.findMany({ where: { organizationId: orgId }, orderBy: { code: "asc" }, select: { code: true, name: true, type: true, ifrsGroup: true } }),
    prisma.membership.findMany({ where: { organizationId: orgId }, include: { user: { select: { id: true, name: true } } } }),
  ]);
  return {
    currentOrgId: orgId,
    entities: entities.map((e) => ({ id: e.id, name: e.name })),
    dims: DIMENSIONS.map((d) => {
      const seen = new Map<string, string>();
      for (const v of dims) if (v.type === d.type && !seen.has(v.code)) seen.set(v.code, v.name);
      return { key: d.key, label: d.label, values: [...seen].map(([code, name]) => ({ code, name })) };
    }).filter((d) => d.values.length > 0),
    accounts,
    ifrsGroups: [...new Set(accounts.map((a) => a.ifrsGroup))].sort(),
    journalSources: JOURNAL_SOURCES,
    members: members.filter((m) => m.userId !== userId).map((m) => ({ id: m.user.id, name: m.user.name, role: m.role })),
    roles: (Object.keys(ROLE_LABELS) as Role[]).map((r) => ({ id: r, label: ROLE_LABELS[r] })),
  };
}
