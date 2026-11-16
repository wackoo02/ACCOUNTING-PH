// Pure loan math: payment dates, amortization schedules and the effective interest rate (PFRS 9).
// Money is bigint centavos; rates are annual percentages (7.5 = 7.5% p.a.). No database access here.

export type DayCount = "ACT_365" | "ACT_360" | "30_360";
export type Frequency = "MONTHLY" | "QUARTERLY" | "SEMI_ANNUAL" | "ANNUAL" | "AT_MATURITY";
export type RepaymentType = "ANNUITY" | "EQUAL_PRINCIPAL" | "BULLET";

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  MONTHLY: "Monthly", QUARTERLY: "Quarterly", SEMI_ANNUAL: "Semi-annual", ANNUAL: "Annual", AT_MATURITY: "Single payment at maturity",
};
export const REPAYMENT_LABELS: Record<RepaymentType, string> = {
  ANNUITY: "Equal installments (principal + interest)",
  EQUAL_PRINCIPAL: "Equal principal + interest on balance",
  BULLET: "Interest only, principal at maturity (bullet)",
};
export const DAY_COUNT_LABELS: Record<DayCount, string> = { ACT_365: "Actual/365", ACT_360: "Actual/360", "30_360": "30/360" };
const MONTHS: Record<Frequency, number> = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12, AT_MATURITY: 0 };

export type Terms = {
  rate: number;                  // nominal annual rate, percent
  dayCount: DayCount;
  frequency: Frequency;
  repaymentType: RepaymentType;
  anchor: Date;                  // first payment date of the loan; later due dates step from it
  maturityDate: Date;
  principalFrom?: Date | null;   // grace period: no principal falls due on or before this date
};

export type Row = {
  seq: number;
  periodStart: Date;
  dueDate: Date;
  openingPrincipal: bigint;
  interest: bigint;         // contractual (nominal) interest for the period
  principal: bigint;
  payment: bigint;          // principal + interest
  closingPrincipal: bigint;
  openingCarrying: bigint;  // amortized cost
  eirInterest: bigint;      // interest expense at the effective rate
  amortization: bigint;     // eirInterest - interest: unamortized cost (or premium) released
  closingCarrying: bigint;
};

const DAY = 86_400_000;
export const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const utc = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

/** Add months, keeping the day of month where possible (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}

/** Fraction of a year between two dates under the day-count convention. */
export function yearFrac(a: Date, b: Date, dc: DayCount): number {
  if (dc === "30_360") {
    let d1 = a.getUTCDate(), d2 = b.getUTCDate();
    if (d1 === 31) d1 = 30;
    if (d2 === 31 && d1 === 30) d2 = 30;
    return ((b.getUTCFullYear() - a.getUTCFullYear()) * 360 + (b.getUTCMonth() - a.getUTCMonth()) * 30 + (d2 - d1)) / 360;
  }
  return days(a, b) / (dc === "ACT_360" ? 360 : 365);
}

const round = (x: number): bigint => BigInt(Math.round(x));

/** Due dates after `from`, up to and including maturity. */
export function dueDates(from: Date, t: Terms): Date[] {
  if (t.maturityDate <= from) return [];
  const step = MONTHS[t.frequency];
  if (!step) return [t.maturityDate];
  const out: Date[] = [];
  for (let k = 0; k < 2000; k++) {
    const d = addMonths(t.anchor, k * step);
    if (d >= t.maturityDate) break;
    if (d > from) out.push(d);
  }
  out.push(t.maturityDate);
  return out;
}

/**
 * Build the repayment schedule from `start` for the outstanding `principal`.
 * `carrying` is the amortized cost at `start` (principal less unamortized transaction costs);
 * the effective rate is solved so the carrying amount unwinds to zero at the last payment.
 */
export function buildSchedule(start: Date, principal: bigint, carrying: bigint, t: Terms): { rows: Row[]; eir: number } {
  const dates = dueDates(start, t);
  if (!dates.length) throw new Error("The maturity date must be after the schedule start date");
  if (principal <= 0n) return { rows: [], eir: t.rate };
  const r = t.rate / 100;
  const starts = dates.map((_, i) => (i === 0 ? start : dates[i - 1]));
  const yf = dates.map((d, i) => yearFrac(starts[i], d, t.dayCount));
  let amortizing = dates.map((d) => !t.principalFrom || d > t.principalFrom);
  if (!amortizing.some(Boolean)) amortizing = dates.map((_, i) => i === dates.length - 1);
  if (t.repaymentType === "BULLET") amortizing = dates.map((_, i) => i === dates.length - 1);
  const n = amortizing.filter(Boolean).length;

  // Level installment for annuities, on the nominal periodic rate (bank practice).
  const perYear = MONTHS[t.frequency] ? 12 / MONTHS[t.frequency] : 1;
  const pr = r / perYear;
  const level = pr === 0 ? Number(principal) / n : (Number(principal) * pr) / (1 - Math.pow(1 + pr, -n));
  const equal = principal / BigInt(n);

  const rows: Row[] = [];
  let open = principal;
  let left = n;
  dates.forEach((due, i) => {
    const interest = round(Number(open) * r * yf[i]);
    let prin = 0n;
    if (amortizing[i]) {
      left--;
      if (left === 0) prin = open;
      else if (t.repaymentType === "EQUAL_PRINCIPAL") prin = equal;
      else prin = round(level) - interest;
      if (prin < 0n) prin = 0n;
      if (prin > open) prin = open;
    }
    rows.push({
      seq: i + 1, periodStart: starts[i], dueDate: due, openingPrincipal: open, interest, principal: prin, payment: prin + interest,
      closingPrincipal: open - prin, openingCarrying: 0n, eirInterest: 0n, amortization: 0n, closingCarrying: 0n,
    });
    open -= prin;
  });

  const eir = carrying === principal ? t.rate : solveEir(carrying, rows, yf);
  applyEir(rows, carrying, eir, yf, carrying === principal);
  return { rows, eir };
}

/** Carrying amount left after rolling forward at annual rate e (percent); zero at the right rate. */
function rollForward(carrying: bigint, rows: Row[], yf: number[], e: number) {
  let c = Number(carrying);
  rows.forEach((row, i) => { c = c * (1 + (e / 100) * yf[i]) - Number(row.payment); });
  return c;
}

/** The effective rate: discounts the contractual payments exactly to the carrying amount. */
export function solveEir(carrying: bigint, rows: Row[], yf: number[]) {
  let lo = -99, hi = 500;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (rollForward(carrying, rows, yf, mid) > 0) hi = mid; else lo = mid;
  }
  return Math.round(((lo + hi) / 2) * 1e8) / 1e8;
}

function applyEir(rows: Row[], carrying: bigint, eir: number, yf: number[], nominal: boolean) {
  let c = carrying;
  rows.forEach((row, i) => {
    row.openingCarrying = c;
    const last = i === rows.length - 1;
    row.eirInterest = nominal ? row.interest : last ? row.payment - c : round(Number(c) * (eir / 100) * yf[i]);
    row.amortization = row.eirInterest - row.interest;
    c = c + row.eirInterest - row.payment;
    row.closingCarrying = last ? 0n : c;
  });
}

/** Present value of the schedule's payments at annual rate e (percent), same convention as the EIR. */
export function presentValue(rows: Pick<Row, "payment" | "periodStart" | "dueDate">[], e: number, dc: DayCount) {
  let v = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    v = (v + Number(rows[i].payment)) / (1 + (e / 100) * yearFrac(rows[i].periodStart, rows[i].dueDate, dc));
  }
  return round(v);
}

/** Portion of a row's amount earned by date `t` (straight-line by days within the period). */
export function earnedBy(amount: bigint, periodStart: Date, dueDate: Date, t: Date) {
  if (t <= periodStart) return 0n;
  if (t >= dueDate) return amount;
  const total = days(periodStart, dueDate);
  return total <= 0 ? amount : round((Number(amount) * days(periodStart, t)) / total);
}

/** Nominal interest and EIR interest earned in (from, to] across the schedule rows. */
export function accrualBetween(rows: Pick<Row, "periodStart" | "dueDate" | "interest" | "eirInterest">[], from: Date, to: Date) {
  let interest = 0n, eir = 0n;
  for (const r of rows) {
    if (r.dueDate <= from || r.periodStart >= to) continue;
    interest += earnedBy(r.interest, r.periodStart, r.dueDate, to) - earnedBy(r.interest, r.periodStart, r.dueDate, from);
    eir += earnedBy(r.eirInterest, r.periodStart, r.dueDate, to) - earnedBy(r.eirInterest, r.periodStart, r.dueDate, from);
  }
  return { interest, eir };
}

/** PFRS 9 B3.3.6 "10 per cent test": a modification is substantial if the PV of the new cash flows
 *  (net of fees paid, at the original EIR) differs by at least 10% from the old carrying amount. */
export function tenPercentTest(oldCarrying: bigint, pvNew: bigint, feesPaid: bigint) {
  const diff = pvNew + feesPaid - oldCarrying;
  const pct = oldCarrying === 0n ? 100 : (Math.abs(Number(diff)) / Number(oldCarrying)) * 100;
  return { pct: Math.round(pct * 100) / 100, substantial: pct >= 10 };
}
