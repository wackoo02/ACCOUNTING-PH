// Pure depreciation math (PAS 16). No database access; amounts in centavos (bigint).
//
// Months are counted as an index: year * 12 + (month - 1).
// Convention: an asset put in service on or before the 15th depreciates from that month;
// after the 15th it starts the next month. Disposals follow the same rule (see disposalMonths).
//
// Every method works on what is left to depreciate, so improvements, opening balances
// and changes in useful life are applied prospectively, as PAS 16 / PAS 8 require:
//   remaining = cost - salvage - accumulated depreciation
//   monthsLeft = useful life - months already elapsed since depreciation started
// Straight-line:      remaining / monthsLeft
// Sum-of-the-years:   remaining * 2 / (monthsLeft + 1)   (the monthly SYD fraction)
// Declining balance:  net book value * 2 / useful life, switching to straight-line once that is higher
// The last month takes whatever is left, so the asset lands exactly on its salvage value.

export const METHODS = ["STRAIGHT_LINE", "DECLINING_BALANCE", "SUM_OF_YEARS", "NONE"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_LABEL: Record<string, string> = {
  STRAIGHT_LINE: "Straight-line", DECLINING_BALANCE: "Double declining balance", SUM_OF_YEARS: "Sum-of-the-years' digits", NONE: "Not depreciated (e.g. land)",
};

export type DepState = {
  cost: bigint;
  salvage: bigint;
  accum: bigint;
  lifeMonths: number | null;
  method: string;
  inService: Date | null;
};

export const monthIdx = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
export const idxYear = (i: number) => Math.floor(i / 12);
export const idxMonth = (i: number) => (i % 12) + 1;
/** Last day of the month, UTC midnight. */
export const monthEnd = (i: number) => new Date(Date.UTC(idxYear(i), idxMonth(i), 0));
export const idxLabel = (i: number) => `${idxYear(i)}-${String(idxMonth(i)).padStart(2, "0")}`;

/** First month depreciation is charged for. */
export function startIdx(inService: Date) {
  return monthIdx(inService) + (inService.getUTCDate() > 15 ? 1 : 0);
}

/** Positive division rounded half up. */
function divRound(a: bigint, b: bigint) {
  if (b <= 0n) return 0n;
  return (a * 2n + b) / (b * 2n);
}

/** Why an asset can't be depreciated, or null when it can. */
export function notReady(s: DepState): string | null {
  if (s.method === "NONE") return null;
  if (!s.inService) return "no in-service / acquisition date";
  if (!s.lifeMonths || s.lifeMonths <= 0) return "no useful life";
  if (s.salvage > s.cost) return "salvage value is above cost";
  return null;
}

/** Depreciation for one month, given the state at the start of that month. */
export function depForMonth(s: DepState, i: number): bigint {
  if (s.method === "NONE" || notReady(s)) return 0n;
  const start = startIdx(s.inService!);
  if (i < start) return 0n;
  const remaining = s.cost - s.salvage - s.accum;
  if (remaining <= 0n) return 0n;
  const left = s.lifeMonths! - (i - start);
  if (left <= 1) return remaining;
  const L = BigInt(left);
  let dep: bigint;
  if (s.method === "SUM_OF_YEARS") dep = divRound(remaining * 2n, L + 1n);
  else if (s.method === "DECLINING_BALANCE") {
    const ddb = divRound((s.cost - s.accum) * 2n, BigInt(s.lifeMonths!));
    const sl = divRound(remaining, L);
    dep = ddb > sl ? ddb : sl;
  } else dep = divRound(remaining, L);
  return dep > remaining ? remaining : dep;
}

export type ScheduleRow = { idx: number; period: string; opening: bigint; depreciation: bigint; accum: bigint; nbv: bigint };

/** Project depreciation month by month from `fromIdx` to `toIdx` (inclusive). */
export function schedule(s: DepState, fromIdx: number, toIdx: number): ScheduleRow[] {
  const out: ScheduleRow[] = [];
  let accum = s.accum;
  for (let i = fromIdx; i <= toIdx; i++) {
    const opening = s.cost - accum;
    const d = depForMonth({ ...s, accum }, i);
    accum += d;
    out.push({ idx: i, period: idxLabel(i), opening, depreciation: d, accum, nbv: s.cost - accum });
  }
  return out;
}

/** Depreciation still to be charged for months after `throughIdx` up to and including `toIdx`. */
export function catchUp(s: DepState, throughIdx: number | null, toIdx: number) {
  if (s.method === "NONE" || notReady(s)) return { total: 0n, months: [] as { period: string; amount: bigint }[] };
  const start = startIdx(s.inService!);
  const from = throughIdx === null ? start : Math.max(throughIdx + 1, start);
  const rows = schedule(s, from, toIdx);
  const months = rows.filter((r) => r.depreciation > 0n).map((r) => ({ period: r.period, amount: r.depreciation }));
  return { total: rows.reduce((t, r) => t + r.depreciation, 0n), months };
}

/** On disposal: depreciate through the disposal month if disposed after the 15th, else through the month before. */
export function disposalThroughIdx(date: Date) {
  return monthIdx(date) - (date.getUTCDate() > 15 ? 0 : 1);
}

/** Months until fully depreciated (for display). */
export function monthsRemaining(s: DepState, asOfIdx: number) {
  if (notReady(s) || s.method === "NONE") return null;
  const start = startIdx(s.inService!);
  return Math.max(0, Math.min(s.lifeMonths!, s.lifeMonths! - (asOfIdx + 1 - start)));
}
