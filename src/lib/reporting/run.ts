// Runs a report definition for a signed-in user. Checks every entity in the report against the
// user's own memberships, so a shared report never shows another company's data to someone
// who is not a member of it.
import type { Role } from "@prisma/client";
import { prisma } from "../db";
import { can } from "../permissions";
import type { RunContext } from "./context";
import { parseDefinition, type ReportDefinition } from "./definition";
import { resolveAsOf, resolvePeriod } from "./periods";
import type { ReportResult } from "./result";
import { runBalances } from "./sources/balances";
import { runStatement } from "./sources/statements";
import { runGlDetail, runJournalRegister } from "./sources/detail";
import { runAging } from "./sources/aging";

const RUNNERS: Record<ReportDefinition["source"], (ctx: RunContext) => Promise<ReportResult>> = {
  balances: runBalances,
  income_statement: (c) => runStatement(c, "income_statement"),
  balance_sheet: (c) => runStatement(c, "balance_sheet"),
  cash_flow: (c) => runStatement(c, "cash_flow"),
  gl_detail: runGlDetail,
  journal_entries: runJournalRegister,
  aging: runAging,
};

export type Viewer = { userId: string; currentOrgId: string };

/** Entities this user may report on: their memberships with report access. */
export async function reportableEntities(userId: string) {
  const ms = await prisma.membership.findMany({ where: { userId }, include: { organization: true }, orderBy: { createdAt: "asc" } });
  return ms.filter((m) => can(m.role as Role, "reports.view")).map((m) => ({
    id: m.organizationId, name: m.organization.name, code: m.organization.code, fiscalYearStartMonth: m.organization.fiscalYearStartMonth, baseCurrency: m.organization.baseCurrency, parentId: m.organization.parentId,
  }));
}

export async function runReport(viewer: Viewer, input: unknown, now = new Date()): Promise<{ ok: true; result: ReportResult; def: ReportDefinition } | { ok: false; errors: string[] }> {
  const parsed = parseDefinition(input);
  if (!parsed.ok) return parsed;
  const def = parsed.def;
  const allowed = await reportableEntities(viewer.userId);
  const notes: string[] = [];
  const wanted = def.filters.entityIds?.length ? def.filters.entityIds : [viewer.currentOrgId];
  const orgs = wanted.map((id) => allowed.find((a) => a.id === id)).filter((x): x is NonNullable<typeof x> => !!x);
  const dropped = wanted.length - orgs.length;
  if (dropped > 0) notes.push(`${dropped} ${dropped === 1 ? "entity was" : "entities were"} left out because you do not have access to ${dropped === 1 ? "it" : "them"}.`);
  if (!orgs.length) return { ok: false, errors: ["You do not have access to any of the entities in this report."] };
  const currencies = new Set(orgs.map((o) => o.baseCurrency));
  if (currencies.size > 1) notes.push(`These entities use different base currencies (${[...currencies].join(", ")}); amounts are added as recorded, without translation.`);
  const asOf = resolveAsOf(def.asOf, now);
  const fy = orgs[0].fiscalYearStartMonth;
  const periods = def.periods.map((p) => resolvePeriod(p, asOf, fy));
  const result = await RUNNERS[def.source]({ def, orgs, currentOrgId: viewer.currentOrgId, asOf, periods, notes });
  return { ok: true, result, def };
}
