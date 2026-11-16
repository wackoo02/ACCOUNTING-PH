// Loads what a report needs per entity (accounts, dimension values, parties) and turns the
// definition's code-based filters into database conditions for that entity.
import type { Account, Prisma } from "@prisma/client";
import { prisma } from "../db";
import { DIMENSIONS, type DimKey } from "../ledger/dimensions";
import type { Filters } from "./definition";

export type ScopeOrg = { id: string; name: string; code: string | null; fiscalYearStartMonth: number; baseCurrency: string };
export type DimInfo = { id: string; key: DimKey; code: string; name: string };
export type PartyInfo = { type: string; code: string; name: string; termsDays: number };

export type OrgScope = {
  org: ScopeOrg;
  accounts: Account[];
  accountById: Map<string, Account>;
  dimById: Map<string, DimInfo>;
  dimIds: Map<DimKey, Map<string, string>>; // key -> code -> id
  allowedAccountIds: string[] | null; // null = no account filter
  partyFilterIds: string[] | null; // null = no party filter (ids and codes)
};

export async function loadScopes(orgs: ScopeOrg[], f: Filters): Promise<OrgScope[]> {
  return Promise.all(orgs.map(async (org) => {
    const [accounts, dims] = await Promise.all([
      prisma.account.findMany({ where: { organizationId: org.id }, orderBy: { code: "asc" } }),
      prisma.dimensionValue.findMany({ where: { organizationId: org.id } }),
    ]);
    const dimById = new Map<string, DimInfo>();
    const dimIds = new Map<DimKey, Map<string, string>>();
    for (const d of DIMENSIONS) dimIds.set(d.key, new Map());
    for (const v of dims) {
      const key = DIMENSIONS.find((d) => d.type === v.type)!.key;
      dimById.set(v.id, { id: v.id, key, code: v.code, name: v.name });
      dimIds.get(key)!.set(v.code.toUpperCase(), v.id);
    }
    const partyFilterIds = f.partyCodes?.length ? await partyIdsFor(org.id, f.partyCodes) : null;
    return { org, accounts, accountById: new Map(accounts.map((a) => [a.id, a])), dimById, dimIds, allowedAccountIds: allowedAccounts(accounts, f), partyFilterIds };
  }));
}

/** Account matches a code list / code range / type / IFRS group selection (all given criteria must match). */
export function accountMatches(a: Pick<Account, "code" | "type" | "ifrsGroup">, sel: { codes?: string[]; codeFrom?: string; codeTo?: string; types?: string[]; ifrsGroups?: string[] }) {
  if (sel.codes?.length && !sel.codes.some((c) => c.trim().toUpperCase() === a.code.toUpperCase())) return false;
  if (sel.codeFrom && a.code.localeCompare(sel.codeFrom.trim()) < 0) return false;
  if (sel.codeTo) { const to = sel.codeTo.trim(); if (a.code.localeCompare(to) > 0 && !a.code.startsWith(to)) return false; }
  if (sel.types?.length && !sel.types.includes(a.type)) return false;
  if (sel.ifrsGroups?.length && !sel.ifrsGroups.includes(a.ifrsGroup)) return false;
  return true;
}

function allowedAccounts(accounts: Account[], f: Filters): string[] | null {
  if (!f.accountCodes?.length && !f.accountCodeFrom && !f.accountCodeTo && !f.accountTypes?.length && !f.ifrsGroups?.length) return null;
  return accounts.filter((a) => accountMatches(a, { codes: f.accountCodes, codeFrom: f.accountCodeFrom, codeTo: f.accountCodeTo, types: f.accountTypes, ifrsGroups: f.ifrsGroups })).map((a) => a.id);
}

const NONE = "__no_match__";

/** Condition on one dimension: the selected codes (and optionally untagged lines). */
export function dimCondition(s: OrgScope, key: DimKey, codes: string[], untagged: boolean): Prisma.JournalLineWhereInput {
  const ids = codes.map((c) => s.dimIds.get(key)!.get(c.toUpperCase())).filter(Boolean) as string[];
  const opts: Prisma.JournalLineWhereInput[] = [];
  if (ids.length) opts.push({ [key]: { in: ids } });
  if (untagged) opts.push({ [key]: null });
  if (!opts.length) return { [key]: NONE };
  return opts.length === 1 ? opts[0] : { OR: opts };
}

export type LineWhereOpts = { date?: Prisma.DateTimeFilter; statuses?: string[]; ignoreAccountFilter?: boolean };

/** Journal line conditions for one entity. Balances use posted entries only unless statuses are given. */
export function lineWhere(s: OrgScope, f: Filters, o: LineWhereOpts = {}): Prisma.JournalLineWhereInput {
  const and: Prisma.JournalLineWhereInput[] = [];
  const je: Prisma.JournalEntryWhereInput = {
    status: o.statuses?.length ? { in: o.statuses as Prisma.EnumJournalStatusFilter["in"] } : "POSTED",
    ...(o.date ? { date: o.date } : {}),
    ...(f.includeConsolidation ? {} : { book: "STATUTORY" }),
  };
  const srcNot = f.excludeClosing ? ["CLOSING"] : [];
  if (f.sources?.length) je.source = { in: f.sources.filter((x) => !srcNot.includes(x)) as Prisma.EnumJournalSourceFilter["in"] };
  else if (srcNot.length) je.source = { notIn: srcNot as Prisma.EnumJournalSourceFilter["notIn"] };
  if (f.text?.trim()) {
    const t = f.text.trim();
    and.push({ OR: [{ description: { contains: t, mode: "insensitive" } }, { journalEntry: { memo: { contains: t, mode: "insensitive" } } }, { journalEntry: { reference: { contains: t, mode: "insensitive" } } }, { journalEntry: { number: { contains: t, mode: "insensitive" } } }] });
  }
  for (const [key, codes] of Object.entries(f.dims ?? {}) as [DimKey, string[]][]) {
    if (codes?.length) and.push(dimCondition(s, key, codes, !!f.includeUntagged));
  }
  if (f.partyTypes?.length) and.push({ partyType: { in: f.partyTypes } });
  if (s.partyFilterIds) and.push({ partyId: { in: s.partyFilterIds.length ? s.partyFilterIds : [NONE] } });
  const w: Prisma.JournalLineWhereInput = { organizationId: s.org.id, journalEntry: je };
  if (!o.ignoreAccountFilter && s.allowedAccountIds) w.accountId = { in: s.allowedAccountIds.length ? s.allowedAccountIds : [NONE] };
  if (and.length) w.AND = and;
  return w;
}

/** Party names by "TYPE:id" and "TYPE:code" (lines store either, depending on the module). */
export async function loadParties(organizationId: string) {
  const [customers, vendors, employees] = await Promise.all([
    prisma.customer.findMany({ where: { organizationId }, select: { id: true, code: true, name: true, paymentTermsDays: true } }),
    prisma.vendor.findMany({ where: { organizationId }, select: { id: true, code: true, name: true, paymentTermsDays: true } }),
    prisma.employee.findMany({ where: { organizationId }, select: { id: true, code: true, firstName: true, lastName: true, isPartner: true } }),
  ]);
  const m = new Map<string, PartyInfo>();
  const put = (type: string, id: string, code: string, info: PartyInfo) => { m.set(`${type}:${id}`, info); m.set(`${type}:${code}`, info); m.set(`${type}:${code.toUpperCase()}`, info); };
  for (const c of customers) put("CUSTOMER", c.id, c.code, { type: "CUSTOMER", code: c.code, name: c.name, termsDays: c.paymentTermsDays });
  for (const v of vendors) put("VENDOR", v.id, v.code, { type: "VENDOR", code: v.code, name: v.name, termsDays: v.paymentTermsDays });
  for (const e of employees) {
    const info = (type: string) => ({ type, code: e.code, name: `${e.lastName}, ${e.firstName}`, termsDays: 0 });
    put("EMPLOYEE", e.id, e.code, info("EMPLOYEE"));
    put("PARTNER", e.id, e.code, info("PARTNER"));
  }
  return m;
}

/** Party filter values for one entity: the codes typed plus the matching record ids. */
export async function partyIdsFor(organizationId: string, codes: string[]) {
  const up = codes.map((c) => c.trim()).filter(Boolean);
  if (!up.length) return [];
  const parties = await loadParties(organizationId);
  const out = new Set(up);
  for (const [k] of parties) {
    const [, idOrCode] = k.split(/:(.*)/);
    const info = parties.get(k)!;
    if (up.some((c) => c.toUpperCase() === info.code.toUpperCase())) out.add(idOrCode);
  }
  return [...out];
}

export const PARTY_LABEL: Record<string, string> = { CUSTOMER: "Customer", VENDOR: "Vendor", EMPLOYEE: "Employee", PARTNER: "Partner" };
