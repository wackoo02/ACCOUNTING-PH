// Fixed asset reports, rebuilt from FixedAssetTxn so they can be run as of any date:
// asset register, depreciation schedule, rollforward (PAS 16.73 reconciliation) and disposals.
import type { FixedAsset, FixedAssetTxn } from "@prisma/client";
import { prisma } from "../db";
import { toCentavos } from "../money";
import { OFF_BOOKS, stateOf } from "./service";
import { idxLabel, monthIdx, monthsRemaining, schedule, startIdx } from "./depreciation";

const c = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");
const day = (s: string) => new Date(s + "T00:00:00.000Z");

export type RegisterFilter = { categoryCode?: string | null; location?: string | null; status?: string | null; q?: string | null; departmentCode?: string | null; custodianCode?: string | null };

async function assetsAndTxns(organizationId: string, f: RegisterFilter = {}) {
  const assets = await prisma.fixedAsset.findMany({
    where: {
      organizationId, status: { not: "CANCELLED" },
      ...(f.categoryCode ? { categoryCode: f.categoryCode } : {}),
      ...(f.location ? { location: { equals: f.location, mode: "insensitive" as const } } : {}),
      ...(f.departmentCode ? { departmentCode: f.departmentCode } : {}),
      ...(f.custodianCode ? { custodianCode: f.custodianCode } : {}),
      ...(f.q ? { OR: [{ code: { contains: f.q, mode: "insensitive" as const } }, { name: { contains: f.q, mode: "insensitive" as const } }, { serialNo: { contains: f.q, mode: "insensitive" as const } }, { tagCode: { contains: f.q, mode: "insensitive" as const } }] } : {}),
    },
    orderBy: { code: "asc" },
  });
  const txns = await prisma.fixedAssetTxn.findMany({ where: { organizationId, status: "POSTED", assetId: { in: assets.map((a) => a.id) } }, orderBy: [{ date: "asc" }, { createdAt: "asc" }] });
  const byAsset = new Map<string, FixedAssetTxn[]>();
  for (const t of txns) byAsset.set(t.assetId, [...(byAsset.get(t.assetId) ?? []), t]);
  return { assets, byAsset };
}

/** Cost and accumulated depreciation of an asset at the end of a date, from its transactions. */
function balanceAt(txns: FixedAssetTxn[], asOf: Date) {
  let cost = 0n, accum = 0n;
  for (const t of txns) if (t.date <= asOf) { cost += c(t.costChange); accum += c(t.accumChange); }
  return { cost, accum };
}

const auditStatus = (a: FixedAsset) => {
  if (OFF_BOOKS.includes(a.status)) return null;
  if (a.status === "MISSING") return "Missing";
  if (!a.taggedAt) return "Not tagged";
  if (a.lastSeenLocation && a.location && a.lastSeenLocation.trim().toLowerCase() !== a.location.trim().toLowerCase()) return "Moved";
  return a.lastSeenAt ? "Found" : "Tagged";
};

export async function assetRegister(organizationId: string, asOf: string, f: RegisterFilter = {}) {
  const at = day(asOf);
  const { assets, byAsset } = await assetsAndTxns(organizationId, f);
  const rows = assets.map((a) => {
    const txns = byAsset.get(a.id) ?? [];
    const b = balanceAt(txns, at);
    const gone = a.disposedAt && a.disposedAt <= at;
    const status = gone ? a.status : a.status === "DISPOSED" || a.status === "RETIRED" ? "ACTIVE" : a.status;
    const exists = txns.some((t) => t.date <= at);
    return { asset: a, cost: b.cost, accum: b.accum, nbv: b.cost - b.accum, status, exists, audit: auditStatus(a), remaining: gone ? null : monthsRemaining(stateOf(a), monthIdx(at)) };
  }).filter((r) => r.exists && (!f.status ? !OFF_BOOKS.includes(r.status) : f.status === "ALL" ? true : r.status === f.status));
  const totals = rows.reduce((t, r) => ({ cost: t.cost + r.cost, accum: t.accum + r.accum, nbv: t.nbv + r.nbv }), { cost: 0n, accum: 0n, nbv: 0n });
  return { rows, totals };
}

type RfBucket = {
  key: string; openCost: bigint; additions: bigint; improvements: bigint; disposals: bigint; closeCost: bigint;
  openAccum: bigint; depreciation: bigint; accumDisposals: bigint; closeAccum: bigint; openNbv: bigint; closeNbv: bigint;
};

/** Opening + additions + improvements - disposals = closing, for cost and accumulated depreciation, by category. */
export async function rollforward(organizationId: string, from: string, to: string, groupBy: "category" | "account" | "location" = "category") {
  const start = day(from), end = day(to);
  const { assets, byAsset } = await assetsAndTxns(organizationId);
  const cats = new Map((await prisma.assetCategory.findMany({ where: { organizationId } })).map((x) => [x.code, x.name]));
  const keyOf = (a: FixedAsset) => (groupBy === "account" ? a.accountCode : groupBy === "location" ? a.location : a.categoryCode ? cats.get(a.categoryCode) ?? a.category : a.category) || "Not set";
  const m = new Map<string, RfBucket>();
  for (const a of assets) {
    const k = keyOf(a);
    const b = m.get(k) ?? { key: k, openCost: 0n, additions: 0n, improvements: 0n, disposals: 0n, closeCost: 0n, openAccum: 0n, depreciation: 0n, accumDisposals: 0n, closeAccum: 0n, openNbv: 0n, closeNbv: 0n };
    for (const t of byAsset.get(a.id) ?? []) {
      const cost = c(t.costChange), dep = c(t.depreciation), accumOther = c(t.accumChange) - dep;
      if (t.date < start) { b.openCost += cost; b.openAccum += c(t.accumChange); continue; }
      if (t.date > end) continue;
      if (t.type === "DISPOSAL" || t.type === "RETIREMENT") {
        b.disposals += cost; b.depreciation += dep; b.accumDisposals += accumOther; // removes accum before + its own catch-up charge
      } else if (t.type === "IMPROVEMENT") { b.improvements += cost; b.depreciation += dep; b.accumDisposals += accumOther; }
      else if (t.type === "DEPRECIATION") b.depreciation += dep;
      else { b.additions += cost; b.accumDisposals += accumOther; } // ADDITION, OPENING (opening accum shows as acquired with the asset)
    }
    m.set(k, b);
  }
  const rows = [...m.values()].map((b) => {
    b.closeCost = b.openCost + b.additions + b.improvements + b.disposals;
    b.closeAccum = b.openAccum + b.depreciation + b.accumDisposals;
    b.openNbv = b.openCost - b.openAccum; b.closeNbv = b.closeCost - b.closeAccum;
    return b;
  }).filter((b) => b.openCost || b.closeCost || b.additions || b.disposals || b.depreciation).sort((x, y) => x.key.localeCompare(y.key));
  const zero: RfBucket = { key: "Total", openCost: 0n, additions: 0n, improvements: 0n, disposals: 0n, closeCost: 0n, openAccum: 0n, depreciation: 0n, accumDisposals: 0n, closeAccum: 0n, openNbv: 0n, closeNbv: 0n };
  const total = rows.reduce((t, r) => {
    const o = { ...t };
    for (const k of Object.keys(zero) as (keyof RfBucket)[]) if (k !== "key") (o[k] as bigint) = (t[k] as bigint) + (r[k] as bigint);
    return o;
  }, zero);
  return { rows, total };
}

export async function disposalReport(organizationId: string, from: string, to: string) {
  const txns = await prisma.fixedAssetTxn.findMany({
    where: { organizationId, status: "POSTED", type: { in: ["DISPOSAL", "RETIREMENT"] }, date: { gte: day(from), lte: day(to) } },
    include: { asset: true }, orderBy: [{ date: "asc" }, { number: "asc" }],
  });
  const rows = txns.map((t) => {
    const cost = -c(t.costChange), accum = -c(t.accumChange) + c(t.depreciation);
    const det = (t.details ?? {}) as { buyer?: string | null; outputVat?: string };
    return { txn: t, asset: t.asset, cost, accum, nbv: cost - accum, proceeds: c(t.proceeds), gainLoss: c(t.gainLoss), buyer: det.buyer ?? null, outputVat: toCentavos(det.outputVat ?? "0"), depToDate: c(t.depreciation) };
  });
  const totals = rows.reduce((s, r) => ({ cost: s.cost + r.cost, accum: s.accum + r.accum, nbv: s.nbv + r.nbv, proceeds: s.proceeds + r.proceeds, gainLoss: s.gainLoss + r.gainLoss }), { cost: 0n, accum: 0n, nbv: 0n, proceeds: 0n, gainLoss: 0n });
  return { rows, totals };
}

/** Per-asset monthly depreciation for a fiscal year: posted amounts for months already run, projected for the rest. */
export async function depreciationSchedule(organizationId: string, year: number, startMonth = 1, f: RegisterFilter = {}) {
  const first = year * 12 + (startMonth - 1);
  const months = Array.from({ length: 12 }, (_, i) => first + i);
  const { assets, byAsset } = await assetsAndTxns(organizationId, f);
  const rows = [] as { asset: FixedAsset; cells: { idx: number; amount: bigint; projected: boolean }[]; total: bigint }[];
  for (const a of assets) {
    if (a.depreciationMethod === "NONE") continue;
    const actual = new Map<number, bigint>();
    for (const t of byAsset.get(a.id) ?? []) {
      const ms = (t.details as { months?: { period: string; amount: string }[] } | null)?.months;
      if (!ms || !(t.type === "DEPRECIATION" || t.type === "DISPOSAL" || t.type === "RETIREMENT")) continue;
      for (const m of ms) { const [y, mo] = m.period.split("-").map(Number); const i = y * 12 + mo - 1; actual.set(i, (actual.get(i) ?? 0n) + toCentavos(m.amount)); }
    }
    const done = a.depreciatedThrough ? monthIdx(a.depreciatedThrough) : (a.inServiceDate ?? a.acquisitionDate) ? startIdx(a.inServiceDate ?? a.acquisitionDate!) - 1 : null;
    const live = !OFF_BOOKS.includes(a.status);
    const proj = live && done !== null ? new Map(schedule(stateOf(a), done + 1, months[11]).map((r) => [r.idx, r.depreciation])) : new Map<number, bigint>();
    const cells = months.map((i) => (done !== null && i <= done) || !live ? { idx: i, amount: actual.get(i) ?? 0n, projected: false } : { idx: i, amount: proj.get(i) ?? 0n, projected: true });
    const total = cells.reduce((s, x) => s + x.amount, 0n);
    if (total > 0n) rows.push({ asset: a, cells, total });
  }
  const monthTotals = months.map((_, k) => rows.reduce((s, r) => s + r.cells[k].amount, 0n));
  return { months: months.map(idxLabel), rows, monthTotals, total: monthTotals.reduce((s, x) => s + x, 0n) };
}

/** Whole-life schedule for one asset, by year: posted history plus projection. */
export async function assetLifeSchedule(a: FixedAsset) {
  const st = stateOf(a);
  const inService = st.inService;
  if (!inService || a.depreciationMethod === "NONE" || !a.usefulLifeMonths) return [];
  const done = a.depreciatedThrough ? monthIdx(a.depreciatedThrough) : startIdx(inService) - 1;
  const end = startIdx(inService) + a.usefulLifeMonths + 24;
  const rows = OFF_BOOKS.includes(a.status) ? [] : schedule(st, done + 1, end).filter((r) => r.depreciation > 0n);
  const years = new Map<number, { year: number; depreciation: bigint; closingNbv: bigint; months: number }>();
  for (const r of rows) {
    const y = Math.floor(r.idx / 12);
    const e = years.get(y) ?? { year: y, depreciation: 0n, closingNbv: 0n, months: 0 };
    e.depreciation += r.depreciation; e.closingNbv = r.nbv; e.months++;
    years.set(y, e);
  }
  return [...years.values()];
}
