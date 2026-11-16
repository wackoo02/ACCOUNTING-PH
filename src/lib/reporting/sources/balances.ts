// Account balances matrix: trial balance, account activity, budget vs actual, cost per department,
// expense per employee/partner, and user-designed statements (custom rows with formulas).
import type { Account, Prisma } from "@prisma/client";
import { prisma } from "../../db";
import { toCentavos } from "../../money";
import { DIMENSIONS, DIM_KEYS, type DimKey } from "../../ledger/dimensions";
import type { CustomLine, Measure, RowField } from "../definition";
import type { RunContext } from "../context";
import { addVec, buildMatrixColumns, cellsFor, isZeroRow, mergeVecs, psKey, type MeasureDef, type ReportResult, type Row, type SplitValue } from "../result";
import { accountMatches, lineWhere, loadParties, loadScopes, PARTY_LABEL, type OrgScope, type PartyInfo } from "../scope";
import { fmtIso } from "../periods";

const c = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");

type GroupRow = Record<string, unknown> & { accountId: string; _sum: { debit: Prisma.Decimal | null; credit: Prisma.Decimal | null } };
/** groupBy with a field list chosen at run time (Prisma's types need it fixed at compile time). */
const groupLines = (by: string[], where: Prisma.JournalLineWhereInput) =>
  (prisma.journalLine.groupBy as unknown as (a: unknown) => Promise<GroupRow[]>)({ by, where, _sum: { debit: true, credit: true } });

// Additive vector: [opening, debit, credit, net, closing, budget, variance]
const V = { opening: 0, debit: 1, credit: 2, net: 3, closing: 4, budget: 5, variance: 6 } as const;
const VLEN = 7;

export const MEASURE_LABELS: Record<Measure, string> = {
  opening: "Opening", debit: "Debit", credit: "Credit", net: "Net movement", closing: "Closing balance",
  budget: "Budget", budgetVariance: "Variance", budgetVariancePct: "Variance %",
};
const MEASURE_INDEX: Record<Exclude<Measure, "budgetVariancePct">, number> = {
  opening: V.opening, debit: V.debit, credit: V.credit, net: V.net, closing: V.closing, budget: V.budget, budgetVariance: V.variance,
};

const TYPE_ORDER = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
export const TYPE_LABEL: Record<string, string> = { ASSET: "Assets", LIABILITY: "Liabilities", EQUITY: "Equity", INCOME: "Income", EXPENSE: "Expenses" };

type GroupVal = { key: string; label: string; sort: string; accountId?: string };

export async function runBalances(ctx: RunContext): Promise<ReportResult> {
  const { def, periods } = ctx;
  const f = def.filters;
  const scopes = await loadScopes(ctx.orgs, f);
  const custom = def.rows.mode === "custom";
  const rowFields: RowField[] = custom ? ["account"] : (def.rows.groupBy.length ? def.rows.groupBy : ["account"]);
  const split = def.split.by;
  const dimFields = new Set<DimKey>(rowFields.filter((r): r is DimKey => (DIM_KEYS as string[]).includes(r)));
  if (split !== "none" && split !== "entity") dimFields.add(split);
  const needParty = rowFields.includes("party") || rowFields.includes("partyType");
  const by = ["accountId", ...dimFields, ...(needParty ? ["partyType", "partyId"] : [])] as const;
  const measures: Measure[] = def.measures.length ? def.measures : ["closing"];
  const needBalance = measures.some((m) => m === "opening" || m === "closing");
  const needBudget = measures.some((m) => m.startsWith("budget"));
  const natural = def.rows.sign === "natural";

  // ---- split values ----
  const splitVals = await splitValues(ctx, scopes);

  // ---- leaf facts: row path -> period|split -> vector ----
  type Leaf = { path: GroupVal[]; account: Account; vecs: Map<string, bigint[]> };
  const leaves = new Map<string, Leaf>();
  const parties = needParty ? new Map(await Promise.all(scopes.map(async (s) => [s.org.id, await loadParties(s.org.id)] as const))) : new Map<string, Map<string, PartyInfo>>();

  const splitKeyOf = (s: OrgScope, row: Record<string, unknown>): string | null => {
    if (split === "none") return "";
    if (split === "entity") return s.org.id;
    const id = row[split] as string | null;
    const code = id ? s.dimById.get(id)?.code ?? "" : "__none";
    return code;
  };
  const allowedSplit = new Set(splitVals.filter((v) => v.key !== "__total").map((v) => v.key));

  const add = (s: OrgScope, row: Record<string, unknown>, periodId: string, vec: bigint[]) => {
    const account = s.accountById.get(row.accountId as string);
    if (!account) return;
    const sk = splitKeyOf(s, row);
    if (sk === null || !allowedSplit.has(sk)) return;
    const path = rowFields.map((rf) => groupValue(rf, s, account, row, parties.get(s.org.id)));
    const key = path.map((p) => p.key).join("\u0001");
    let leaf = leaves.get(key);
    if (!leaf) { leaf = { path, account, vecs: new Map() }; leaves.set(key, leaf); }
    addVec(leaf.vecs, psKey(periodId, sk), vec);
    if (split !== "none" && def.split.total) addVec(leaf.vecs, psKey(periodId, "__total"), vec);
  };

  const sgn = (a: Account) => (natural && a.normalBalance === "CREDIT" ? -1n : 1n);
  const natSign = (a: Account) => (a.normalBalance === "CREDIT" ? -1n : 1n);

  for (const s of scopes) {
    if (split === "entity" && !allowedSplit.has(s.org.id)) continue;
    for (const p of periods) {
      const movement = await groupLines([...by], lineWhere(s, f, { date: { gte: p.from, lte: p.to } }));
      for (const r of movement) {
        const a = s.accountById.get(r.accountId); if (!a) continue;
        const d = c(r._sum.debit), cr = c(r._sum.credit), k = sgn(a);
        const vec = new Array<bigint>(VLEN).fill(0n);
        vec[V.debit] = d; vec[V.credit] = cr; vec[V.net] = k * (d - cr); vec[V.closing] = k * (d - cr);
        if (needBudget) { const act = natSign(a) * (d - cr); vec[V.variance] = a.type === "INCOME" ? act : -act; } // variance = favourable; budget part added below
        add(s, r, p.id, vec);
      }
      if (needBalance && p.from.getUTCFullYear() > 1900) {
        const before = await groupLines([...by], lineWhere(s, f, { date: { lt: p.from } }));
        for (const r of before) {
          const a = s.accountById.get(r.accountId); if (!a) continue;
          const v = sgn(a) * (c(r._sum.debit) - c(r._sum.credit));
          const vec = new Array<bigint>(VLEN).fill(0n);
          vec[V.opening] = v; vec[V.closing] = v;
          add(s, r, p.id, vec);
        }
      }
      if (needBudget) {
        for (const b of await budgetFacts(s, p.from, p.to, dimFields, split, f.dims)) {
          const a = s.accountById.get(b.accountId); if (!a) continue;
          if (s.allowedAccountIds && !s.allowedAccountIds.includes(a.id)) continue;
          const vec = new Array<bigint>(VLEN).fill(0n);
          // Budgets are entered as positive natural amounts. Shown in natural sign, or debit-positive.
          vec[V.budget] = natural ? b.amount : natSign(a) * b.amount;
          vec[V.variance] = a.type === "INCOME" ? -b.amount : b.amount; // favourable = actual-budget (income) / budget-actual (expense)
          add(s, b.row, p.id, vec);
        }
      }
    }
  }
  if (needBudget) ctx.notes.push("Variance is favourable when positive: income above budget, or costs below budget.");

  const mdefs: MeasureDef[] = measures.map((m) => m === "budgetVariancePct"
    ? { id: m, label: MEASURE_LABELS[m], kind: "pct", pct: { num: V.variance, den: V.budget } }
    : { id: m, label: MEASURE_LABELS[m], kind: "amount" });
  // cellsFor reads vector index = measure index for "value" recipes, so map measure -> vector slot.
  const { cols, recipes } = buildMatrixColumns(def, periods, splitVals, mdefs);
  for (const r of recipes) if (r.t !== "ratio") r.mi = MEASURE_INDEX[measures[r.mi] as keyof typeof MEASURE_INDEX];

  const rows: Row[] = [];
  const link = (accountId: string | undefined, orgId: string | null) =>
    accountId && orgId === ctx.currentOrgId && periods[0] ? `/ledger?account=${accountId}&from=${fmtIso(periods[0].from.getUTCFullYear() > 1900 ? periods[0].from : new Date(Date.UTC(periods[0].to.getUTCFullYear(), 0, 1)))}&to=${fmtIso(periods[0].to)}` : undefined;
  const orgOfAccount = new Map<string, string>();
  for (const s of scopes) for (const a of s.accounts) orgOfAccount.set(a.id, s.org.id);

  if (custom) {
    // Accounts across entities share codes; combine leaves by account code.
    const byCode = new Map<string, { account: Account; vecs: Map<string, bigint[]> }>();
    for (const l of leaves.values()) {
      const e = byCode.get(l.account.code) ?? { account: l.account, vecs: new Map() };
      mergeVecs(e.vecs, l.vecs);
      byCode.set(l.account.code, e);
    }
    const lineVals = new Map<string, Map<string, bigint[]>>();
    for (const line of def.rows.lines) {
      if (line.kind === "header") { rows.push({ key: line.id, kind: "header", depth: 0, label: line.label, cells: cols.map(() => null) }); continue; }
      if (line.kind === "spacer") { rows.push({ key: line.id, kind: "spacer", depth: 0, label: "", cells: cols.map(() => null) }); continue; }
      const vecs = new Map<string, bigint[]>();
      const details: Row[] = [];
      if (line.kind === "accounts") {
        const sign = line.negate ? -1n : 1n;
        for (const e of [...byCode.values()].sort((a, b) => a.account.code.localeCompare(b.account.code))) {
          if (!accountMatches(e.account, { codes: line.codes, codeFrom: line.codeFrom, codeTo: line.codeTo, types: line.types, ifrsGroups: line.ifrsGroups })) continue;
          mergeVecs(vecs, e.vecs, sign);
          if (line.showAccounts) {
            const sv = new Map<string, bigint[]>(); mergeVecs(sv, e.vecs, sign);
            const cells = cellsFor(recipes, sv);
            if (!def.rows.hideZero || !isZeroRow(cells, cols)) details.push({ key: `${line.id}:${e.account.code}`, kind: "detail", depth: 1, label: `${e.account.code} · ${e.account.name}`, cells, link: link(e.account.id, orgOfAccount.get(e.account.id) ?? null) });
          }
        }
      } else {
        for (const term of parseFormula(line.formula ?? "")) {
          const src = lineVals.get(term.id);
          if (!src) { ctx.notes.push(`Row "${line.label}": ${term.id} is not a row above it, so it was left out of the formula.`); continue; }
          mergeVecs(vecs, src, term.sign);
        }
        if (line.negate) for (const v of vecs.values()) for (let i = 0; i < v.length; i++) v[i] = -v[i];
      }
      lineVals.set(line.id, vecs);
      const cells = cellsFor(recipes, vecs);
      rows.push({ key: line.id, kind: line.bold || line.kind === "formula" ? "subtotal" : "line", depth: 0, label: line.label, cells });
      rows.push(...details);
    }
    if (!def.rows.lines.length) ctx.notes.push("Add rows to your custom layout to see amounts.");
    return { title: def.title || "Custom statement", subtitle: subtitle(ctx), labelHead: "", columns: cols, rows, notes: ctx.notes };
  }

  // ---- grouped rows ----
  type Node = { val: GroupVal; vecs: Map<string, bigint[]>; children: Map<string, Node>; leaf?: Leaf };
  const root: Node = { val: { key: "", label: "", sort: "" }, vecs: new Map(), children: new Map() };
  for (const leaf of leaves.values()) {
    const cells = cellsFor(recipes, leaf.vecs);
    if (def.rows.hideZero && isZeroRow(cells, cols)) continue;
    let n = root;
    mergeVecs(root.vecs, leaf.vecs);
    leaf.path.forEach((g, depth) => {
      let ch = n.children.get(g.key);
      if (!ch) { ch = { val: { ...g }, vecs: new Map(), children: new Map() }; n.children.set(g.key, ch); }
      if (g.sort < ch.val.sort) ch.val.sort = g.sort;
      mergeVecs(ch.vecs, leaf.vecs);
      if (depth === leaf.path.length - 1) ch.leaf = leaf;
      n = ch;
    });
  }
  const firstAmountCol = cols.findIndex((x) => x.kind === "amount");
  const order = (nodes: Node[]) => nodes.sort((a, b) => {
    if (def.rows.sortBy === "amount" && firstAmountCol >= 0) {
      const av = BigInt(cellsFor([recipes[firstAmountCol]], a.vecs)[0] as string), bv = BigInt(cellsFor([recipes[firstAmountCol]], b.vecs)[0] as string);
      return bv > av ? 1 : bv < av ? -1 : 0;
    }
    if (def.rows.sortBy === "label") return a.val.label.localeCompare(b.val.label);
    return a.val.sort.localeCompare(b.val.sort) || a.val.label.localeCompare(b.val.label);
  });
  const levels = rowFields.length;
  const walk = (n: Node, depth: number) => {
    for (const ch of order([...n.children.values()])) {
      const isLeafLevel = depth === levels - 1;
      if (isLeafLevel) {
        rows.push({ key: `${depth}:${ch.val.key}:${rows.length}`, kind: "line", depth, label: ch.val.label, cells: cellsFor(recipes, ch.vecs), link: link(ch.val.accountId, ch.leaf ? orgOfAccount.get(ch.leaf.account.id) ?? null : null) });
      } else if (def.rows.subtotals) {
        rows.push({ key: `h${depth}:${ch.val.key}:${rows.length}`, kind: "header", depth, label: ch.val.label, cells: cols.map(() => null) });
        walk(ch, depth + 1);
        rows.push({ key: `t${depth}:${ch.val.key}:${rows.length}`, kind: "subtotal", depth, label: `Total ${ch.val.label}`, cells: cellsFor(recipes, ch.vecs) });
      } else {
        rows.push({ key: `g${depth}:${ch.val.key}:${rows.length}`, kind: "subtotal", depth, label: ch.val.label, cells: cellsFor(recipes, ch.vecs) });
        walk(ch, depth + 1);
      }
    }
  };
  walk(root, 0);
  if (rows.length === 0) ctx.notes.push("No posted amounts match this report's filters.");
  else {
    // In normal-balance signs, adding debit-normal and credit-normal accounts together means nothing.
    const sides = new Set([...leaves.values()].map((l) => l.account.normalBalance));
    if (natural && sides.size > 1) ctx.notes.push("No grand total: with normal-balance signs, income and expenses (or assets and liabilities) would be added together. Use subtotals by account type, or your own rows with a formula.");
    else rows.push({ key: "grand", kind: "total", depth: 0, label: "Total", cells: cellsFor(recipes, root.vecs) });
  }
  if (!natural && measures.some((m) => m === "closing" || m === "net" || m === "opening")) ctx.notes.push("Balances are debit-positive; credits show in parentheses. Switch the sign option to show each account in its normal balance.");
  return { title: def.title || "Account balances", subtitle: subtitle(ctx), labelHead: rowFields.map(fieldLabel).join(" / "), columns: cols, rows, notes: ctx.notes };
}

export function subtitle(ctx: RunContext) {
  const ents = ctx.orgs.map((o) => o.name).join(", ");
  return `${ents} · amounts in ${ctx.orgs[0]?.baseCurrency ?? "PHP"}`;
}

export function fieldLabel(f: string) {
  const d = DIMENSIONS.find((x) => x.key === f);
  if (d) return d.label;
  return ({ account: "Account", type: "Account type", ifrsGroup: "IFRS line item", parentAccount: "Parent account", entity: "Entity", party: "Customer / vendor / employee", partyType: "Party type", entry: "Journal entry" } as Record<string, string>)[f] ?? f;
}

function groupValue(rf: RowField, s: OrgScope, a: Account, row: Record<string, unknown>, parties?: Map<string, PartyInfo>): GroupVal {
  switch (rf) {
    case "account": return { key: a.code, label: `${a.code} · ${a.name}`, sort: a.code, accountId: a.id };
    case "type": return { key: a.type, label: TYPE_LABEL[a.type], sort: String(TYPE_ORDER.indexOf(a.type)) };
    case "ifrsGroup": return { key: a.ifrsGroup, label: a.ifrsGroup, sort: a.code };
    case "parentAccount": {
      const p = a.parentId ? s.accountById.get(a.parentId) : null;
      return p ? { key: p.code, label: `${p.code} · ${p.name}`, sort: p.code } : { key: a.code, label: `${a.code} · ${a.name}`, sort: a.code };
    }
    case "entity": return { key: s.org.id, label: s.org.name, sort: s.org.code ?? s.org.name };
    case "partyType": { const t = row.partyType as string | null; return { key: t ?? "", label: t ? PARTY_LABEL[t] ?? t : "(no party)", sort: t ?? "~" }; }
    case "party": {
      const t = row.partyType as string | null, id = row.partyId as string | null;
      if (!t || !id) return { key: "", label: "(no customer / vendor / employee)", sort: "~" };
      const p = parties?.get(`${t}:${id}`);
      return { key: `${t}:${p?.code ?? id}`, label: p ? `${p.code} · ${p.name}` : `${PARTY_LABEL[t] ?? t} ${id}`, sort: p ? `${t}${p.name}` : `${t}${id}` };
    }
    default: {
      const id = row[rf] as string | null;
      const v = id ? s.dimById.get(id) : null;
      return v ? { key: v.code, label: `${v.code} · ${v.name}`, sort: v.code } : { key: "", label: "(not tagged)", sort: "~" };
    }
  }
}

/** Split columns in order, plus the total column. Shared with the statement sources. */
export async function splitValues(ctx: RunContext, scopes?: OrgScope[]): Promise<SplitValue[]> {
  const sp = ctx.def.split;
  if (sp.by === "none") return [{ key: "", label: "" }];
  let vals: SplitValue[];
  if (sp.by === "entity") {
    vals = ctx.orgs.filter((o) => !sp.values?.length || sp.values.includes(o.id)).map((o) => ({ key: o.id, label: o.name }));
  } else {
    const type = DIMENSIONS.find((d) => d.key === sp.by)!.type;
    const dv = await prisma.dimensionValue.findMany({ where: { organizationId: { in: ctx.orgs.map((o) => o.id) }, type }, orderBy: { code: "asc" } });
    const seen = new Map<string, string>();
    for (const v of dv) if (!seen.has(v.code)) seen.set(v.code, v.name);
    vals = [...seen].filter(([code]) => !sp.values?.length || sp.values.includes(code)).map(([code, name]) => ({ key: code, label: `${code} · ${name}` }));
    if (sp.untagged && !sp.values?.length) vals.push({ key: "__none", label: "Not tagged" });
  }
  void scopes;
  if (sp.total) vals.push({ key: "__total", label: "Total" });
  return vals;
}

/** Budget amounts for months starting inside [from, to]. Picks the budget dimension that matches the report. */
async function budgetFacts(s: OrgScope, from: Date, to: Date, dimFields: Set<DimKey>, split: string, dimFilter?: Partial<Record<DimKey, string[]>>) {
  const sm = s.org.fiscalYearStartMonth;
  const out: { accountId: string; amount: bigint; row: Record<string, unknown> }[] = [];
  const startFY = (from.getUTCFullYear() < 1900 ? 1900 : from.getUTCFullYear()) - 1, endFY = to.getUTCFullYear() + 1;
  const budgets = await prisma.budget.findMany({ where: { organizationId: s.org.id, fiscalYear: { gte: Math.max(startFY, to.getUTCFullYear() - 30), lte: endFY } } });
  if (!budgets.length) return out;
  // Which dimension do budgets need to be split by? The first grouped/split dimension that has budgets.
  const keyOfBudget = (b: (typeof budgets)[number]) => (b.dimensionValueId ? s.dimById.get(b.dimensionValueId)?.key ?? null : null);
  const wanted = [...dimFields, ...(Object.keys(dimFilter ?? {}).filter((k) => dimFilter?.[k as DimKey]?.length) as DimKey[])];
  const budgetKey = wanted.find((k) => budgets.some((b) => keyOfBudget(b) === k)) ?? null;
  for (const b of budgets) {
    const k = keyOfBudget(b);
    if (k !== budgetKey) continue;
    const dv = b.dimensionValueId ? s.dimById.get(b.dimensionValueId) : null;
    if (budgetKey && dimFilter?.[budgetKey]?.length && (!dv || !dimFilter[budgetKey]!.map((x) => x.toUpperCase()).includes(dv.code.toUpperCase()))) continue;
    const fyStartYear = sm === 1 ? b.fiscalYear : b.fiscalYear - 1;
    let amount = 0n;
    for (let i = 1; i <= 12; i++) {
      const ms = new Date(Date.UTC(fyStartYear, sm - 1 + i - 1, 1));
      if (ms >= from && ms <= to) amount += c((b as unknown as Record<string, { toString(): string }>)[`m${i}`]);
    }
    if (amount === 0n) continue;
    const row: Record<string, unknown> = { accountId: b.accountId, partyType: null, partyId: null };
    for (const dk of DIM_KEYS) row[dk] = null;
    if (budgetKey && dv) row[budgetKey] = dv.id;
    if (split !== "none" && split !== "entity" && split !== budgetKey) row[split] = null;
    out.push({ accountId: b.accountId, amount, row });
  }
  return out;
}

export function parseFormula(f: string): { id: string; sign: bigint }[] {
  const out: { id: string; sign: bigint }[] = [];
  const re = /([+-])?\s*([A-Za-z][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(f))) out.push({ id: m[2], sign: m[1] === "-" ? -1n : 1n });
  return out;
}

export type { CustomLine };
