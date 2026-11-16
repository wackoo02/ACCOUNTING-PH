// Custom report definitions: what a user picks in the report builder, saved as JSON.
// Everything here is plain data so it can be stored, shared and sent between browser and server.
// Codes (account codes, dimension codes) are used instead of database ids so a definition works
// across entities that share the same chart of accounts and dimension codes.
import { z } from "zod";
import { DIM_KEYS, type DimKey } from "../ledger/dimensions";

export const SOURCE_IDS = ["balances", "income_statement", "balance_sheet", "cash_flow", "gl_detail", "journal_entries", "aging"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

const dimKey = z.enum(DIM_KEYS as [DimKey, ...DimKey[]]);

/** A period relative to the report date, so saved reports stay current (e.g. "this month", "same month last year"). */
export const periodSchema = z.object({
  id: z.string().min(1).max(20),
  label: z.string().max(60).optional(),
  // month / quarter / ytd / fy are fiscal-year aware. "custom" uses from/to. "to_date" = everything up to the report date.
  kind: z.enum(["month", "quarter", "ytd", "fy", "custom", "to_date"]),
  // 0 = current, -1 = previous (months for "month", quarters for "quarter", years for ytd/fy/to_date).
  offset: z.number().int().min(-120).max(12).default(0),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type PeriodSpec = z.infer<typeof periodSchema>;

export const ROW_FIELDS = ["account", "type", "ifrsGroup", "parentAccount", "entity", "party", "partyType", ...DIM_KEYS] as const;
export type RowField = (typeof ROW_FIELDS)[number];

export const MEASURES = ["opening", "debit", "credit", "net", "closing", "budget", "budgetVariance", "budgetVariancePct"] as const;
export type Measure = (typeof MEASURES)[number];

export const customLineSchema = z.object({
  id: z.string().min(1).max(20).regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Line ids start with a letter and use letters, digits or _"),
  label: z.string().max(120),
  kind: z.enum(["accounts", "formula", "header", "spacer"]),
  codeFrom: z.string().max(30).optional(),
  codeTo: z.string().max(30).optional(),
  codes: z.array(z.string().max(30)).max(500).optional(),
  types: z.array(z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"])).optional(),
  ifrsGroups: z.array(z.string().max(120)).optional(),
  formula: z.string().max(400).optional(), // e.g. "REV - COS"
  negate: z.boolean().optional(),
  showAccounts: z.boolean().optional(),
  bold: z.boolean().optional(),
});
export type CustomLine = z.infer<typeof customLineSchema>;

export const filtersSchema = z.object({
  entityIds: z.array(z.string()).max(50).optional(), // empty = the company you are signed in to
  dims: z.record(dimKey, z.array(z.string().max(40)).max(200)).optional(), // dimension codes
  includeUntagged: z.boolean().optional(), // with a dimension filter, also include lines without that dimension
  accountCodes: z.array(z.string().max(30)).max(2000).optional(),
  accountCodeFrom: z.string().max(30).optional(),
  accountCodeTo: z.string().max(30).optional(),
  accountTypes: z.array(z.enum(["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"])).optional(),
  ifrsGroups: z.array(z.string().max(120)).optional(),
  sources: z.array(z.string().max(30)).optional(), // journal source modules
  partyTypes: z.array(z.enum(["CUSTOMER", "VENDOR", "EMPLOYEE", "PARTNER"])).optional(),
  partyCodes: z.array(z.string().max(60)).optional(),
  statuses: z.array(z.enum(["DRAFT", "PENDING_APPROVAL", "POSTED", "VOID"])).optional(), // detail reports only
  excludeClosing: z.boolean().optional(),
  includeConsolidation: z.boolean().optional(),
  text: z.string().max(100).optional(), // memo / description / reference contains
});
export type Filters = z.infer<typeof filtersSchema>;

export const definitionSchema = z.object({
  version: z.literal(1).default(1),
  source: z.enum(SOURCE_IDS),
  title: z.string().max(120).optional(),
  // Report date: "today", "end_of_last_month", or a fixed YYYY-MM-DD.
  asOf: z.string().max(20).default("today"),
  periods: z.array(periodSchema).min(1).max(24),
  comparisons: z.array(z.object({
    id: z.string().max(20),
    label: z.string().max(60).optional(),
    base: z.string(), against: z.string(), // period ids
    show: z.enum(["diff", "pct", "both"]).default("both"),
  })).max(12).default([]),
  split: z.object({
    by: z.union([z.literal("none"), z.literal("entity"), dimKey]).default("none"),
    values: z.array(z.string()).max(50).optional(), // entity ids or dimension codes; empty = every value used
    total: z.boolean().default(true),
    untagged: z.boolean().default(true), // show a column for lines without the dimension
  }).default({ by: "none", total: true, untagged: true }),
  columnOrder: z.enum(["period_first", "split_first"]).default("period_first"),
  measures: z.array(z.enum(MEASURES)).max(8).default(["closing"]),
  rows: z.object({
    mode: z.enum(["grouped", "custom"]).default("grouped"),
    groupBy: z.array(z.enum(ROW_FIELDS)).max(4).default(["account"]),
    subtotals: z.boolean().default(true),
    lines: z.array(customLineSchema).max(200).default([]),
    hideZero: z.boolean().default(true),
    sign: z.enum(["debit", "natural"]).default("debit"),
    detail: z.boolean().default(false), // statements: show accounts under each line item
    sortBy: z.enum(["code", "label", "amount"]).default("code"),
  }).default({}),
  // Detail reports (GL lines, journal entries): which columns, in order.
  columns: z.array(z.string().max(40)).max(40).default([]),
  sort: z.enum(["date", "number", "amount", "account"]).default("date"),
  groupDetailBy: z.union([z.literal("none"), z.enum(ROW_FIELDS), z.literal("entry")]).default("none"),
  aging: z.object({
    buckets: z.array(z.number().int().min(1).max(3650)).min(1).max(8).default([30, 60, 90, 120]),
    basis: z.enum(["date", "transactionDate", "dueDate"]).default("transactionDate"),
    showItems: z.boolean().default(false),
  }).default({}),
  filters: filtersSchema.default({}),
});
export type ReportDefinition = z.infer<typeof definitionSchema>;
export type ReportDefinitionInput = z.input<typeof definitionSchema>;

export function parseDefinition(input: unknown): { ok: true; def: ReportDefinition } | { ok: false; errors: string[] } {
  const r = definitionSchema.safeParse(input);
  if (!r.success) return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "report"}: ${i.message}`) };
  const def = r.data;
  const ids = new Set(def.periods.map((p) => p.id));
  const errors: string[] = [];
  if (ids.size !== def.periods.length) errors.push("Each period needs its own id");
  for (const p of def.periods) if (p.kind === "custom" && (!p.from || !p.to)) errors.push(`Period ${p.label ?? p.id}: enter both dates`);
  for (const c of def.comparisons) if (!ids.has(c.base) || !ids.has(c.against)) errors.push(`Comparison ${c.label ?? c.id}: pick two of the report's periods`);
  if (def.rows.mode === "custom") {
    const lineIds = new Set<string>();
    for (const l of def.rows.lines) {
      if (lineIds.has(l.id)) errors.push(`Row ${l.id} is used twice`);
      lineIds.add(l.id);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, def };
}
