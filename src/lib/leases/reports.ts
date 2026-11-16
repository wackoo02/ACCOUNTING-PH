// PFRS 16 disclosure reports: ROU rollforward, lease liability schedule, interest schedule, maturity analysis.
import { prisma } from "../db";
import { toCentavos } from "../money";
import { MATURITY_BUCKETS, maturityBuckets } from "./engine";
import { paymentsOf, rowOf } from "./service";

const c = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function booked(organizationId: string, leaseId?: string) {
  return prisma.lease.findMany({ where: { organizationId, status: { not: "DRAFT" }, ...(leaseId ? { id: leaseId } : {}) }, orderBy: { number: "asc" } });
}
/** Events grouped per lease, with the termination date (if any). */
async function eventsOf(organizationId: string) {
  const ev = await prisma.leaseEvent.findMany({ where: { organizationId }, orderBy: { date: "asc" } });
  const by = new Map<string, typeof ev>();
  for (const e of ev) by.set(e.leaseId, [...(by.get(e.leaseId) ?? []), e]);
  return by;
}

const ZERO_RF = { costOpening: 0n, additions: 0n, remeasurements: 0n, derecognized: 0n, costClosing: 0n, accOpening: 0n, depreciation: 0n, accDerecognized: 0n, accClosing: 0n, nbvOpening: 0n, nbvClosing: 0n };
export type RouLine = typeof ZERO_RF;

/** Right-of-use asset rollforward (PFRS 16.53 / PAS 16.73 style), base currency. */
export async function rouRollforward(organizationId: string, from: string, to: string) {
  const [leases, events] = await Promise.all([booked(organizationId), eventsOf(organizationId)]);
  const rows: (RouLine & { id: string; number: string; asset: string; type: string; lessor: string })[] = [];
  const total = { ...ZERO_RF };
  for (const l of leases) {
    if (l.exemption !== "NONE") continue;
    const r = { ...ZERO_RF };
    for (const e of events.get(l.id) ?? []) {
      const d = ymd(e.date);
      if (d > to) continue;
      const cost = c(e.rouAddition) + c(e.rouRemeasurement) - c(e.rouDerecognized);
      const acc = c(e.depreciation) - c(e.accumDepDerecognized);
      if (d < from) { r.costOpening += cost; r.accOpening += acc; continue; }
      r.additions += c(e.rouAddition); r.remeasurements += c(e.rouRemeasurement); r.derecognized += c(e.rouDerecognized);
      r.depreciation += c(e.depreciation); r.accDerecognized += c(e.accumDepDerecognized);
    }
    r.costClosing = r.costOpening + r.additions + r.remeasurements - r.derecognized;
    r.accClosing = r.accOpening + r.depreciation - r.accDerecognized;
    r.nbvOpening = r.costOpening - r.accOpening; r.nbvClosing = r.costClosing - r.accClosing;
    if (Object.values(r).every((v) => v === 0n)) continue;
    rows.push({ ...r, id: l.id, number: l.number, asset: l.assetDescription, type: l.leaseType, lessor: l.lessorName });
    for (const k of Object.keys(total) as (keyof RouLine)[]) total[k] += r[k];
  }
  return { rows, total };
}

/** Lease liability rollforward for a period (lease currency) plus current / non-current at the end. */
export async function leaseLiabilitySummary(organizationId: string, asOf: string, from?: string) {
  const [leases, events] = await Promise.all([booked(organizationId), eventsOf(organizationId)]);
  const sched = await prisma.leaseScheduleLine.findMany({ where: { organizationId, periodEnd: { lte: new Date(asOf) } }, orderBy: { periodEnd: "asc" } });
  const out = [];
  for (const l of leases) {
    if (l.exemption !== "NONE") continue;
    const evs = events.get(l.id) ?? [];
    if (!evs.length || ymd(evs[0].date) > asOf) continue;
    const r = { opening: 0n, additions: 0n, remeasurements: 0n, interest: 0n, payments: 0n, derecognized: 0n, closing: 0n, current: 0n, nonCurrent: 0n };
    for (const e of evs) {
      const d = ymd(e.date);
      if (d > asOf) continue;
      const move = c(e.liabilityAddition) + c(e.liabilityRemeasurement) + c(e.interest) - c(e.payment) - c(e.liabilityDerecognized);
      if (from && d < from) { r.opening += move; continue; }
      r.additions += c(e.liabilityAddition); r.remeasurements += c(e.liabilityRemeasurement); r.interest += c(e.interest);
      r.payments += c(e.payment); r.derecognized += c(e.liabilityDerecognized);
    }
    r.closing = r.opening + r.additions + r.remeasurements + r.interest - r.payments - r.derecognized;
    // Current portion from the schedule row at the reporting date (zero once the lease is closed).
    const last = sched.filter((s) => s.leaseId === l.id).at(-1);
    r.current = r.closing === 0n ? 0n : last ? c(last.currentPortion) : r.closing;
    if (r.current > r.closing) r.current = r.closing;
    r.nonCurrent = r.closing - r.current;
    out.push({ ...r, id: l.id, number: l.number, asset: l.assetDescription, currency: l.currencyCode, status: l.status });
  }
  return { rows: out };
}

/** Month-by-month interest on lease liabilities (posted and still to come). */
export async function interestSchedule(organizationId: string, from: string, to: string) {
  const leases = (await booked(organizationId)).filter((l) => l.exemption === "NONE");
  const rows = await prisma.leaseScheduleLine.findMany({
    where: { organizationId, leaseId: { in: leases.map((l) => l.id) }, periodEnd: { gte: new Date(from), lte: new Date(to) } },
    orderBy: { periodEnd: "asc" },
  });
  const months = [...new Set(rows.map((r) => ymd(r.periodEnd).slice(0, 7)))].sort();
  const table = leases.map((l) => {
    const mine = rows.filter((r) => r.leaseId === l.id);
    const byMonth = months.map((m) => mine.filter((r) => ymd(r.periodEnd).startsWith(m)).reduce((s, r) => s + c(r.interest), 0n));
    const posted = mine.filter((r) => r.postedAt).reduce((s, r) => s + c(r.interest), 0n);
    return { id: l.id, number: l.number, asset: l.assetDescription, currency: l.currencyCode, byMonth, total: byMonth.reduce((s, x) => s + x, 0n), posted };
  }).filter((r) => r.total !== 0n);
  return { months, rows: table };
}

/** Undiscounted remaining lease payments by maturity, reconciled to the carrying amount (PFRS 16.58). */
export async function maturityAnalysis(organizationId: string, asOf: string) {
  const [leases, events] = await Promise.all([booked(organizationId), eventsOf(organizationId)]);
  const sched = await prisma.leaseScheduleLine.findMany({ where: { organizationId, periodEnd: { lte: new Date(asOf) } }, orderBy: { periodEnd: "asc" } });
  const rows = [];
  for (const l of leases) {
    if (l.exemption !== "NONE") continue;
    const evs = events.get(l.id) ?? [];
    if (!evs.length || ymd(evs[0].date) > asOf) continue;
    const term = evs.find((e) => e.type === "TERMINATION");
    if (term && ymd(term.date) <= asOf) continue;
    const pays = paymentsOf(l).filter((p) => !term || p.date <= ymd(term.date));
    const buckets = maturityBuckets(pays, asOf);
    const total = buckets.reduce((s, x) => s + x, 0n);
    const last = sched.filter((s) => s.leaseId === l.id).at(-1);
    const carrying = last ? rowOf(last).closing : c(l.initialLiability);
    if (total === 0n && carrying === 0n) continue;
    rows.push({ id: l.id, number: l.number, asset: l.assetDescription, currency: l.currencyCode, buckets, total, carrying, futureInterest: total - carrying });
  }
  return { buckets: MATURITY_BUCKETS, rows };
}
