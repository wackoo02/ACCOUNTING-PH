// The common shape every report source returns, and the column builder for amount matrices
// (periods x split values x measures, then comparisons).
import type { ReportDefinition } from "./definition";
import type { ResolvedPeriod } from "./periods";

export type CellKind = "amount" | "pct" | "text" | "date" | "number";
export type Column = { key: string; head: string[]; kind: CellKind; align?: "left" | "right" };
/** Amount cells are centavos as strings (JSON-safe); pct cells are numbers; text cells strings. */
export type Cell = string | number | null;
export type Row = { key: string; kind: "header" | "line" | "detail" | "subtotal" | "total" | "spacer"; depth: number; label: string; cells: Cell[]; link?: string };
export type ReportResult = {
  title: string;
  subtitle: string;
  labelHead: string | null; // header of the row label column; null = no label column (detail listings)
  columns: Column[];
  rows: Row[];
  notes: string[];
  truncated?: boolean;
};

export type SplitValue = { key: string; label: string };
export type MeasureDef = { id: string; label: string; kind: "amount" | "pct"; pct?: { num: number; den: number } };

/** Column recipe used to compute one cell from a row's per-(period|split) vectors. */
export type ColRecipe =
  | { t: "value"; ps: string; mi: number }
  | { t: "ratio"; ps: string; num: number; den: number }
  | { t: "diff"; a: string; b: string; mi: number }
  | { t: "cpct"; a: string; b: string; mi: number };

export const psKey = (periodId: string, splitKey: string) => `${periodId}|${splitKey}`;

export function buildMatrixColumns(def: ReportDefinition, periods: ResolvedPeriod[], splits: SplitValue[], measures: MeasureDef[]) {
  const cols: Column[] = [];
  const recipes: ColRecipe[] = [];
  const showSplit = splits.length > 1 || splits[0]?.key !== "";
  const showMeasure = measures.length > 1;
  const head = (...parts: (string | false)[]) => parts.filter((x): x is string => x !== false);
  const amountMeasures = measures.map((m, i) => ({ m, i })).filter((x) => x.m.kind === "amount");
  const addPeriod = (p: ResolvedPeriod, s: SplitValue) => {
    measures.forEach((m, i) => {
      cols.push({ key: `${p.id}|${s.key}|${m.id}`, head: head(p.label, showSplit && s.label, showMeasure && m.label), kind: m.kind });
      recipes.push(m.kind === "pct" ? { t: "ratio", ps: psKey(p.id, s.key), num: m.pct!.num, den: m.pct!.den } : { t: "value", ps: psKey(p.id, s.key), mi: i });
    });
  };
  const addComparison = (c: ReportDefinition["comparisons"][number], s: SplitValue) => {
    const a = periods.find((p) => p.id === c.base), b = periods.find((p) => p.id === c.against);
    if (!a || !b) return;
    const label = c.label?.trim() || `${a.label} vs ${b.label}`;
    for (const { m, i } of amountMeasures) {
      if (c.show !== "pct") { cols.push({ key: `${c.id}|${s.key}|${m.id}|d`, head: head(label, showSplit && s.label, showMeasure ? `${m.label} change` : "Change"), kind: "amount" }); recipes.push({ t: "diff", a: psKey(a.id, s.key), b: psKey(b.id, s.key), mi: i }); }
      if (c.show !== "diff") { cols.push({ key: `${c.id}|${s.key}|${m.id}|p`, head: head(label, showSplit && s.label, showMeasure ? `${m.label} %` : "%"), kind: "pct" }); recipes.push({ t: "cpct", a: psKey(a.id, s.key), b: psKey(b.id, s.key), mi: i }); }
    }
  };
  if (def.columnOrder === "split_first") {
    for (const s of splits) { for (const p of periods) addPeriod(p, s); for (const c of def.comparisons) addComparison(c, s); }
  } else {
    for (const p of periods) for (const s of splits) addPeriod(p, s);
    for (const c of def.comparisons) for (const s of splits) addComparison(c, s);
  }
  // A single column with no header levels still needs a name.
  for (const c of cols) if (c.head.length === 0) c.head = [measures[0]?.label ?? "Amount"];
  return { cols, recipes };
}

const ZERO: bigint[] = [];
export function pct(num: bigint, den: bigint): number | null {
  if (den === 0n) return null;
  const d = den < 0n ? -den : den;
  return Number((num * 100000n) / d) / 1000;
}

/** Compute a row's cells from its vectors keyed by period|split. */
export function cellsFor(recipes: ColRecipe[], vecs: Map<string, bigint[]>): Cell[] {
  const v = (ps: string, i: number) => (vecs.get(ps) ?? ZERO)[i] ?? 0n;
  return recipes.map((r) => {
    switch (r.t) {
      case "value": return v(r.ps, r.mi).toString();
      case "ratio": return pct(v(r.ps, r.num), v(r.ps, r.den));
      case "diff": return (v(r.a, r.mi) - v(r.b, r.mi)).toString();
      case "cpct": return pct(v(r.a, r.mi) - v(r.b, r.mi), v(r.b, r.mi));
    }
  });
}

export const isZeroRow = (cells: Cell[], cols: Column[]) => cells.every((c, i) => cols[i].kind !== "amount" || c === null || c === "0");

export function addVec(into: Map<string, bigint[]>, ps: string, vec: bigint[]) {
  const cur = into.get(ps);
  if (!cur) { into.set(ps, [...vec]); return; }
  for (let i = 0; i < vec.length; i++) cur[i] = (cur[i] ?? 0n) + vec[i];
}
export function mergeVecs(into: Map<string, bigint[]>, from: Map<string, bigint[]>, sign = 1n) {
  for (const [k, v] of from) addVec(into, k, sign === 1n ? v : v.map((x) => -x));
}
