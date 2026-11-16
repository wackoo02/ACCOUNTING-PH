// Financial statements (PAS 1 / PAS 7 layouts) with user-chosen columns: periods, comparisons,
// entities or dimension values side by side. Reuses the tested statement functions in ledger/reports.
import type { Prisma } from "@prisma/client";
import { balanceSheet, cashFlow, incomeStatement, type ReportFilter, type StatementSection } from "../../ledger/reports";
import type { RunContext } from "../context";
import { addVec, buildMatrixColumns, cellsFor, isZeroRow, psKey, type ReportResult, type Row } from "../result";
import { dimCondition, lineWhere, loadScopes, type OrgScope } from "../scope";
import { splitValues, subtitle } from "./balances";
import type { DimKey } from "../../ledger/dimensions";
import type { ResolvedPeriod } from "../periods";

type Kind = "income_statement" | "balance_sheet" | "cash_flow";
type Item = { key: string; kind: Row["kind"]; depth: number; label: string; amount: bigint; link?: string };

const TITLES: Record<Kind, string> = { income_statement: "Statement of Profit or Loss", balance_sheet: "Statement of Financial Position", cash_flow: "Statement of Cash Flows" };

function sectionItems(s: StatementSection, detail: boolean, sign = 1n): Item[] {
  const out: Item[] = [{ key: `${s.title}`, kind: "header", depth: 0, label: s.title, amount: 0n }];
  for (const l of s.lines) {
    out.push({ key: `${s.title}|${l.label}`, kind: "line", depth: 1, label: l.label, amount: sign * l.amount });
    if (detail) for (const a of l.accounts ?? []) out.push({ key: `${s.title}|${l.label}|${a.code}`, kind: "detail", depth: 2, label: `${a.code} · ${a.name}`, amount: sign * a.amount, link: a.id });
  }
  out.push({ key: `${s.title}|total`, kind: "subtotal", depth: 1, label: `Total ${s.title.toLowerCase()}`, amount: sign * s.total });
  return out;
}
const total = (key: string, label: string, amount: bigint, strong = false): Item => ({ key, kind: strong ? "total" : "subtotal", depth: 0, label, amount });

async function statementItems(kind: Kind, orgId: string, p: ResolvedPeriod, f: ReportFilter, detail: boolean): Promise<Item[]> {
  if (kind === "income_statement") {
    const r = await incomeStatement(orgId, p.from, p.to, f);
    return [
      ...sectionItems(r.revenue, detail), ...sectionItems(r.cos, detail), total("gp", "Gross profit", r.grossProfit),
      ...sectionItems(r.otherIncome, detail), ...sectionItems(r.opex, detail), ...sectionItems(r.otherExp, detail), total("op", "Operating profit", r.operatingProfit),
      ...sectionItems(r.finInc, detail), ...sectionItems(r.finCost, detail), total("pbt", "Profit before tax", r.profitBeforeTax),
      ...sectionItems(r.tax, detail), total("np", "Net profit (loss) for the period", r.netProfit, true),
    ];
  }
  if (kind === "balance_sheet") {
    const r = await balanceSheet(orgId, p.to, f);
    return [
      ...sectionItems(r.ca, detail), ...sectionItems(r.nca, detail), total("ta", "Total assets", r.totalAssets, true),
      ...sectionItems(r.cl, detail), ...sectionItems(r.ncl, detail), total("tl", "Total liabilities", r.totalLiabilities),
      ...sectionItems(r.equity, detail), total("te", "Total liabilities and equity", r.totalLE, true),
    ];
  }
  const r = await cashFlow(orgId, p.from, p.to, f);
  return [
    ...sectionItems(r.operating, false), ...sectionItems(r.investing, false), ...sectionItems(r.financing, false),
    total("net", "Net increase (decrease) in cash", r.netChange), total("open", "Cash at beginning of period", r.openingCash), total("close", "Cash at end of period", r.closingCash, true),
  ];
}

/** Filters from the builder, as an extra line condition the statement functions apply. */
function extraWhere(s: OrgScope, f: RunContext["def"]["filters"], splitDim?: { key: DimKey; code: string }): Prisma.JournalLineWhereInput {
  const w = lineWhere(s, f);
  const je = w.journalEntry as Prisma.JournalEntryWhereInput;
  const out: Prisma.JournalLineWhereInput = { AND: [...((w.AND as Prisma.JournalLineWhereInput[]) ?? [])] };
  if (je.source) (out.AND as Prisma.JournalLineWhereInput[]).push({ journalEntry: { source: je.source } });
  if (w.accountId) out.accountId = w.accountId;
  if (splitDim) (out.AND as Prisma.JournalLineWhereInput[]).push(splitDim.code === "__none" ? { [splitDim.key]: null } : dimCondition(s, splitDim.key, [splitDim.code], false));
  return out;
}

export async function runStatement(ctx: RunContext, kind: Kind): Promise<ReportResult> {
  const { def, periods } = ctx;
  const scopes = await loadScopes(ctx.orgs, def.filters);
  const splits = await splitValues(ctx, scopes);
  const detail = def.rows.detail && kind !== "cash_flow";
  const order: string[] = [];
  const meta = new Map<string, Omit<Item, "amount">>();
  const vecs = new Map<string, Map<string, bigint[]>>();
  const accountOrg = new Map<string, string>();
  for (const s of scopes) for (const a of s.accounts) accountOrg.set(a.id, s.org.id);
  const split = def.split.by;

  const absorb = (items: Item[], ps: string) => {
    let prev = -1;
    for (const it of items) {
      let idx = order.indexOf(it.key);
      if (idx < 0) { order.splice(prev + 1, 0, it.key); idx = prev + 1; meta.set(it.key, it); }
      prev = idx;
      if (it.kind === "header") continue;
      let m = vecs.get(it.key);
      if (!m) { m = new Map(); vecs.set(it.key, m); }
      addVec(m, ps, [it.amount]);
    }
  };

  for (const p of periods) {
    for (const sv of splits) {
      for (const s of scopes) {
        if (split === "entity" && sv.key !== "__total" && sv.key !== s.org.id) continue;
        if (split === "entity" && sv.key === "__total" && def.split.values?.length && !def.split.values.includes(s.org.id)) continue;
        let splitDim: { key: DimKey; code: string } | undefined;
        if (split !== "none" && split !== "entity" && sv.key !== "__total") splitDim = { key: split, code: sv.key };
        const base: ReportFilter = { includeConsolidation: def.filters.includeConsolidation, where: extraWhere(s, def.filters, splitDim) };
        if (split !== "none" && split !== "entity" && sv.key === "__total" && def.split.values?.length) {
          (base.where!.AND as Prisma.JournalLineWhereInput[]).push(dimCondition(s, split, def.split.values, def.split.untagged));
        }
        absorb(await statementItems(kind, s.org.id, p, base, detail), psKey(p.id, sv.key));
      }
    }
  }

  const { cols, recipes } = buildMatrixColumns(def, periods, splits, [{ id: "amount", label: "Amount", kind: "amount" }]);
  const rows: Row[] = [];
  const p0 = periods[0];
  for (const key of order) {
    const m = meta.get(key)!;
    const cells = m.kind === "header" ? cols.map(() => null) : cellsFor(recipes, vecs.get(key) ?? new Map());
    if (def.rows.hideZero && (m.kind === "line" || m.kind === "detail") && isZeroRow(cells, cols)) continue;
    const link = m.link && accountOrg.get(m.link) === ctx.currentOrgId && p0 ? `/ledger?account=${m.link}&from=${p0.from.toISOString().slice(0, 10)}&to=${p0.to.toISOString().slice(0, 10)}` : undefined;
    rows.push({ key, kind: m.kind, depth: m.depth, label: m.label, cells, link });
  }
  if (kind === "balance_sheet") ctx.notes.push("Balances are as of the end of each period.");
  if (kind !== "balance_sheet") ctx.notes.push("Excludes year-end closing entries.");
  if (scopes.length > 1 && split !== "entity") ctx.notes.push("Entities are added together without intercompany eliminations. Use the Consolidated TB for eliminated group figures.");
  return { title: def.title || TITLES[kind], subtitle: subtitle(ctx), labelHead: "", columns: cols, rows, notes: ctx.notes };
}
