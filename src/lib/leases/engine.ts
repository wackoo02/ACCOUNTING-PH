// PFRS 16 / IFRS 16 lessee calculations. Pure functions, no database access.
//
// Method (stated so auditors can re-perform it):
//  * Lease liability = present value of the lease payments not yet paid, discounted at the
//    annual discount rate (rate implicit in the lease, else the incremental borrowing rate),
//    as a monthly rate of annual / 12 compounded monthly. For a lease that starts on the 1st this
//    is exactly Excel's =PV(rate/12, months, -payment, 0, 1) (advance) or (..., 0, 0) (arrears).
//    Advance payments are made at the start of their due date, arrears payments at the end of it.
//  * Interest (effective interest method) accrues on the outstanding balance and is summarised per
//    calendar month (part-months pro rata by days within the lease month), so every month-end
//    close gets its own interest even when the lease starts mid-month.
//  * Right-of-use asset = liability + payments made on or before commencement + initial direct
//    costs + estimated restoration costs - lease incentives received. It is depreciated straight
//    line by days over the lease term (or the asset's useful life when ownership transfers).
//  * Short-term and low-value leases (PFRS 16.5-8) skip the liability and ROU asset: payments are
//    expensed straight line over the term, with the timing difference in accrued/prepaid rent.
// All money is integer centavos (bigint). Dates are "YYYY-MM-DD" strings (calendar days, UTC).

export type Frequency = "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL";
export type Timing = "ADVANCE" | "ARREARS";
export const FREQ_MONTHS: Record<Frequency, number> = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 };

export type Payment = { date: string; amount: bigint; eod?: boolean }; // eod: paid at the end of the day (arrears)

export type ScheduleRow = {
  periodStart: string;
  periodEnd: string;
  opening: bigint;      // lease liability at the start of the period (lease currency)
  interest: bigint;
  payment: bigint;
  closing: bigint;
  currentPortion: bigint; // part of the closing liability that falls due within 12 months
  depreciation: bigint;   // ROU depreciation (base currency); straight-line rent for exempt leases
  rouOpening: bigint;     // ROU carrying amount (net) at the start of the period
  rouClosing: bigint;
};

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY);
export const monthEnd = (d: string) => { const [y, m] = d.split("-").map(Number); return iso(Date.UTC(y, m, 0)); };
export const minDate = (a: string, b: string) => (a < b ? a : b);
export const maxDate = (a: string, b: string) => (a > b ? a : b);

/** Same day n months later, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: string, n: number) {
  const [y, m, dd] = d.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(dd, last)));
}

/** Whole months in a lease that runs from start to end inclusive (1 Jan - 31 Dec = 12). */
export function termMonths(start: string, endInclusive: string) {
  let n = 0;
  while (addMonths(start, n + 1) <= addDays(endInclusive, 1)) n++;
  return n;
}

const roundC = (x: number) => BigInt(Math.round(x));
/** a * num / den rounded half away from zero, all bigint. */
function mulDiv(a: bigint, num: bigint, den: bigint) {
  if (den === 0n) return 0n;
  const neg = (a < 0n) !== (num < 0n);
  const p = (a < 0n ? -a : a) * (num < 0n ? -num : num);
  const q = (p * 2n + den) / (2n * den);
  return neg ? -q : q;
}

export type PaymentTerms = {
  cadenceStart: string;       // payment periods run from this date (the commencement date)
  from?: string;              // only payments dated on/after this (remaining payments after a modification)
  end: string;                // last day of the lease term
  amount: bigint;             // payment per period before escalation
  frequency: Frequency;
  timing: Timing;
  escalationPct?: number;     // e.g. 5 = +5% every escalationEveryMonths (common in PH leases)
  escalationEveryMonths?: number;
};

/** The lease payments: one per period, on the period's first day (advance) or last day (arrears). */
export function generatePayments(t: PaymentTerms): Payment[] {
  const f = FREQ_MONTHS[t.frequency];
  const every = t.escalationEveryMonths && t.escalationEveryMonths > 0 ? t.escalationEveryMonths : 12;
  const esc = (t.escalationPct ?? 0) / 100;
  const from = t.from ?? t.cadenceStart;
  const out: Payment[] = [];
  let firstMonth: number | null = null;
  for (let k = 0; k < 2000; k++) {
    const ps = addMonths(t.cadenceStart, k * f);
    if (ps > t.end) break;
    const date = t.timing === "ADVANCE" ? ps : minDate(addDays(addMonths(t.cadenceStart, (k + 1) * f), -1), t.end);
    if (date < from) continue;
    if (firstMonth === null) firstMonth = k * f;
    const steps = Math.floor((k * f - firstMonth) / every);
    out.push({ date, amount: roundC(Number(t.amount) * Math.pow(1 + esc, steps)), ...(t.timing === "ARREARS" ? { eod: true } : {}) });
  }
  return out;
}

/** Time of a date in months from the lease's origin (commencement): whole lease months + part of the current one by days. */
export function monthsFrom(origin: string, d: string) {
  const [oy, om] = origin.split("-").map(Number), [y, m] = d.split("-").map(Number);
  let n = (y - oy) * 12 + (m - om) + 1;
  while (n > -2400 && addMonths(origin, n) > d) n--;
  const a = addMonths(origin, n), b = addMonths(origin, n + 1);
  return n + daysBetween(a, d) / daysBetween(a, b);
}
const at = (origin: string, p: { date: string; eod?: boolean }) => monthsFrom(origin, p.eod ? addDays(p.date, 1) : p.date);
const growth = (rate: number, months: number) => Math.pow(1 + rate / 12, months);

/** Present value at `asOf` of the payments dated on/after it. rate is annual, e.g. 0.08. */
export function presentValue(payments: Payment[], asOf: string, rate: number, origin = asOf): bigint {
  let pv = 0;
  const t0 = monthsFrom(origin, asOf);
  for (const p of payments) if (p.date >= asOf) pv += Number(p.amount) / growth(rate, at(origin, p) - t0);
  return roundC(pv);
}

/** Liability movement from `from` to `to` inclusive (interest accrues through the end of `to`). */
export function accrue(opening: bigint, from: string, to: string, payments: Payment[], rate: number, origin = from) {
  let bal = Number(opening), interest = 0, paid = 0n, cursor = monthsFrom(origin, from);
  for (const p of payments) {
    if (p.date < from || p.date > to) continue;
    const t = at(origin, p);
    const g = growth(rate, t - cursor);
    interest += bal * (g - 1); bal *= g;
    bal -= Number(p.amount); paid += p.amount; cursor = t;
  }
  const g = growth(rate, monthsFrom(origin, addDays(to, 1)) - cursor);
  interest += bal * (g - 1);
  const i = roundC(interest);
  return { interest: i, payment: paid, closing: opening + i - paid };
}

export type ScheduleInput = {
  start: string;          // measurement date (commencement, or the modification's effective date)
  leaseEnd: string;       // last day of the lease term
  depEnd: string;         // last day of depreciation (lease end, or end of useful life)
  payments: Payment[];    // remaining payments (dated on/after start)
  rate: number;           // annual discount rate, e.g. 0.08
  origin?: string;        // commencement date (lease months are counted from it); defaults to start
  rou: bigint;            // ROU carrying amount to depreciate from `start` (0 for exempt leases)
  exempt?: boolean;       // short-term / low-value: straight-line expense, no liability
};

export function buildSchedule(s: ScheduleInput) {
  const pays = s.payments.filter((p) => p.date >= s.start).sort((a, b) => a.date.localeCompare(b.date));
  const origin = s.origin ?? s.start;
  const liability = s.exempt ? 0n : presentValue(pays, s.start, s.rate, origin);
  const lastPay = pays.length ? pays[pays.length - 1].date : s.start;
  const finalEnd = maxDate(s.leaseEnd, s.depEnd);
  const totalPay = pays.reduce((t, p) => t + p.amount, 0n);
  const depDays = BigInt(daysBetween(s.start, addDays(s.depEnd, 1)));
  const rentDays = BigInt(daysBetween(s.start, addDays(s.leaseEnd, 1)));

  const rows: ScheduleRow[] = [];
  let bal = liability, rou = s.rou, cumDep = 0n;
  for (let ps = s.start; ps <= finalEnd; ps = addDays(monthEnd(ps), 1)) {
    const pe = minDate(monthEnd(ps), finalEnd);
    const elapsed = BigInt(daysBetween(s.start, addDays(pe, 1)));
    let interest = 0n, payment = 0n, closing = 0n, dep: bigint;
    if (s.exempt) {
      payment = pays.filter((p) => p.date >= ps && p.date <= pe).reduce((t, p) => t + p.amount, 0n);
      const cum = mulDiv(totalPay, elapsed < rentDays ? elapsed : rentDays, rentDays);
      dep = cum - cumDep; cumDep = cum;
    } else {
      const a = accrue(bal, ps, pe, pays, s.rate, origin);
      interest = a.interest; payment = a.payment; closing = a.closing;
      // The last payment settles the liability exactly; any rounding goes into that month's interest.
      if (lastPay >= ps && lastPay <= pe) { interest = payment - bal; closing = 0n; }
      const cum = mulDiv(s.rou, elapsed < depDays ? elapsed : depDays, depDays);
      dep = cum - cumDep; cumDep = cum;
    }
    rows.push({ periodStart: ps, periodEnd: pe, opening: bal, interest, payment, closing, currentPortion: 0n, depreciation: dep, rouOpening: rou, rouClosing: s.exempt ? 0n : rou - dep });
    bal = closing;
    if (!s.exempt) rou -= dep;
  }
  const closingAt = (d: string) => { let c = 0n; for (const r of rows) if (r.periodEnd <= d) c = r.closing; return d >= finalEnd ? 0n : c; };
  for (const r of rows) r.currentPortion = s.exempt ? 0n : r.closing - closingAt(addMonths(r.periodEnd, 12));
  const currentAtStart = s.exempt ? 0n : liability - closingAt(addDays(addMonths(s.start, 12), -1));
  return { liability, rows, currentAtStart };
}

export type LeaseTerms = {
  commencementDate: string;
  endDate: string;
  paymentAmount: bigint;
  frequency: Frequency;
  timing: Timing;
  escalationPct?: number;
  escalationEveryMonths?: number;
  discountRatePct: number;      // annual %, e.g. 8.5
  exempt?: boolean;
  transfersOwnership?: boolean; // or purchase option reasonably certain: depreciate over useful life
  usefulLifeMonths?: number | null;
  initialDirectCosts?: bigint;
  prepaidPayments?: bigint;     // paid before commencement (already on the books, e.g. advance rent)
  incentives?: bigint;          // received from the lessor
  restorationCost?: bigint;     // estimated dismantling / restoration (PAS 37 provision)
  fxRate?: number;              // lease currency -> base at commencement; ROU (base) = liability x rate + the base-currency items above
};

export function depreciationEnd(t: Pick<LeaseTerms, "commencementDate" | "endDate" | "transfersOwnership" | "usefulLifeMonths">) {
  return t.transfersOwnership && t.usefulLifeMonths ? addDays(addMonths(t.commencementDate, t.usefulLifeMonths), -1) : t.endDate;
}

/** Initial measurement at commencement (PFRS 16.23-28) and the full schedule. */
export function measureLease(t: LeaseTerms) {
  const payments = generatePayments({
    cadenceStart: t.commencementDate, end: t.endDate, amount: t.paymentAmount, frequency: t.frequency, timing: t.timing,
    escalationPct: t.escalationPct, escalationEveryMonths: t.escalationEveryMonths,
  });
  const rate = t.discountRatePct / 100;
  const liability = t.exempt ? 0n : presentValue(payments, t.commencementDate, rate);
  const rou = t.exempt ? 0n
    : BigInt(Math.round(Number(liability) * (t.fxRate ?? 1))) + (t.prepaidPayments ?? 0n) + (t.initialDirectCosts ?? 0n) + (t.restorationCost ?? 0n) - (t.incentives ?? 0n);
  const depEnd = t.exempt ? t.endDate : depreciationEnd(t);
  const sched = buildSchedule({ start: t.commencementDate, leaseEnd: t.endDate, depEnd, payments, rate, rou, exempt: t.exempt });
  return { ...sched, payments, liability, rou, depEnd };
}

/** Undiscounted payments after `asOf`, in the PFRS 16.58 / PFRS 7.39 maturity buckets. */
export const MATURITY_BUCKETS = ["Within 1 year", "1-2 years", "2-3 years", "3-4 years", "4-5 years", "Over 5 years"] as const;
export function maturityBuckets(payments: Payment[], asOf: string) {
  const out = MATURITY_BUCKETS.map(() => 0n);
  for (const p of payments) {
    if (p.date <= asOf) continue;
    let b = 0;
    while (b < 5 && p.date > addMonths(asOf, 12 * (b + 1))) b++;
    out[b] += p.amount;
  }
  return out;
}
