// Philippine statutory payroll tables. All amounts in pesos; the engine works in centavos.
// Sources (verify before each year's first payroll):
// - SSS: RA 11199 schedule, 15% from January 2025 (EE 5%, ER 10%), MSC P5,000-P35,000, MPF above P20,000.
// - PhilHealth: RA 11223 / UHC, 5% of monthly basic salary, floor P10,000, ceiling P100,000, shared 50/50.
// - Pag-IBIG (HDMF): HDMF Circular 460, max fund salary P10,000; EE 1% (<= P1,500) or 2%, ER 2%.
// - BIR: TRAIN (RA 10963) withholding tax tables effective January 1, 2023 (RR 11-2018 as amended).
// - De minimis ceilings: RR 29-2025 (effective January 6, 2026). P90,000 ceiling on 13th month and other benefits.
// - Labor Code / DOLE Handbook on Workers' Statutory Monetary Benefits: OT, rest day, holiday and night differential premiums.

export const SSS = {
  rateEE: 0.05,
  rateER: 0.10,
  mscMin: 5000,
  mscMax: 35000,
  mpfFloor: 20000, // MSC above this goes to the Mandatory Provident Fund (WISP)
  ecLow: 10,       // employer EC when MSC < 15,000
  ecHigh: 30,
  ecThreshold: 15000,
};

/** Monthly salary credit for a month's total compensation (P500 brackets). */
export function sssMsc(monthlyComp: number): number {
  if (monthlyComp <= 0) return 0;
  const msc = Math.floor((monthlyComp + 250) / 500) * 500;
  return Math.min(SSS.mscMax, Math.max(SSS.mscMin, msc));
}

/** SSS contribution for the month, in pesos. */
export function sssContribution(monthlyComp: number) {
  const msc = sssMsc(monthlyComp);
  if (msc === 0) return { msc: 0, ee: 0, er: 0, ec: 0, mpfEE: 0, mpfER: 0 };
  const regular = Math.min(msc, SSS.mpfFloor);
  const mpf = Math.max(0, msc - SSS.mpfFloor);
  return {
    msc,
    ee: round2(regular * SSS.rateEE),
    er: round2(regular * SSS.rateER),
    mpfEE: round2(mpf * SSS.rateEE),
    mpfER: round2(mpf * SSS.rateER),
    ec: msc < SSS.ecThreshold ? SSS.ecLow : SSS.ecHigh,
  };
}

export const PHILHEALTH = { rate: 0.05, floor: 10000, ceiling: 100000 };

export function philhealthContribution(monthlyBasic: number) {
  if (monthlyBasic <= 0) return { base: 0, ee: 0, er: 0 };
  const base = Math.min(PHILHEALTH.ceiling, Math.max(PHILHEALTH.floor, monthlyBasic));
  const total = round2(base * PHILHEALTH.rate);
  const ee = round2(total / 2);
  return { base, ee, er: round2(total - ee) };
}

export const PAGIBIG = { maxFundSalary: 10000, lowThreshold: 1500, eeLow: 0.01, ee: 0.02, er: 0.02 };

export function pagibigContribution(monthlyComp: number) {
  if (monthlyComp <= 0) return { base: 0, ee: 0, er: 0 };
  const base = Math.min(PAGIBIG.maxFundSalary, monthlyComp);
  return { base, ee: round2(base * (monthlyComp <= PAGIBIG.lowThreshold ? PAGIBIG.eeLow : PAGIBIG.ee)), er: round2(base * PAGIBIG.er) };
}

// BIR withholding tax on compensation (TRAIN, 2023 onwards). [over, fixed tax, rate on excess]
type Bracket = [number, number, number];
export const WTAX_TABLES: Record<"ANNUAL" | "MONTHLY" | "SEMI_MONTHLY" | "WEEKLY", Bracket[]> = {
  ANNUAL: [[0, 0, 0], [250000, 0, 0.15], [400000, 22500, 0.20], [800000, 102500, 0.25], [2000000, 402500, 0.30], [8000000, 2202500, 0.35]],
  MONTHLY: [[0, 0, 0], [20833, 0, 0.15], [33333, 1875, 0.20], [66667, 8541.80, 0.25], [166667, 33541.80, 0.30], [666667, 183541.80, 0.35]],
  SEMI_MONTHLY: [[0, 0, 0], [10417, 0, 0.15], [16667, 937.50, 0.20], [33333, 4270.70, 0.25], [83333, 16770.70, 0.30], [333333, 91770.70, 0.35]],
  WEEKLY: [[0, 0, 0], [4808, 0, 0.15], [7692, 432.60, 0.20], [15385, 1971.20, 0.25], [38462, 7740.45, 0.30], [153846, 42355.65, 0.35]],
};

export function withholdingTax(taxable: number, table: keyof typeof WTAX_TABLES): number {
  if (taxable <= 0) return 0;
  const rows = WTAX_TABLES[table];
  let b = rows[0];
  for (const r of rows) if (taxable > r[0]) b = r;
  return round2(b[1] + (taxable - b[0]) * b[2]);
}

/** Exempt ceiling for 13th month pay and other benefits (per year). */
export const THIRTEENTH_EXEMPT_CEILING = 90000;

// De minimis ceilings (RR 29-2025). period: MONTH | YEAR | SEMESTER. Excess counts toward the P90,000 "other benefits" ceiling.
export const DE_MINIMIS: Record<string, { label: string; limit: number; period: "MONTH" | "YEAR" | "SEMESTER" }> = {
  RICE: { label: "Rice subsidy", limit: 2500, period: "MONTH" },
  UNIFORM: { label: "Uniform and clothing allowance", limit: 8000, period: "YEAR" },
  MEDICAL_CASH: { label: "Medical cash allowance to dependents", limit: 1500, period: "SEMESTER" },
  MEDICAL_ACTUAL: { label: "Actual medical assistance", limit: 12000, period: "YEAR" },
  LAUNDRY: { label: "Laundry allowance", limit: 400, period: "MONTH" },
  ACHIEVEMENT: { label: "Employee achievement award", limit: 12000, period: "YEAR" },
  GIFTS: { label: "Christmas and anniversary gifts", limit: 6000, period: "YEAR" },
  CBA: { label: "CBA and productivity incentives", limit: 12000, period: "YEAR" },
  MEAL_OT: { label: "Overtime meal allowance", limit: 0, period: "MONTH" }, // 30% of regional minimum wage per day; treat as fully exempt when within policy
};

/** Per-payroll limit for a de minimis item (semi-monthly runs get half the monthly limit). */
export function deMinimisLimitPerRun(code: string, runsPerMonth: number): number | null {
  const d = DE_MINIMIS[code];
  if (!d || d.limit === 0) return null; // no ceiling enforced
  if (d.period === "MONTH") return d.limit / runsPerMonth;
  if (d.period === "SEMESTER") return d.limit / 6 / runsPerMonth;
  return d.limit / 12 / runsPerMonth;
}

// Labor Code premiums. First number = rate for the first 8 hours (x daily/hourly rate),
// second = overtime rate per hour. Night differential = +10% of the applicable hourly rate.
export type DayType = "ORDINARY" | "REST" | "SPECIAL" | "SPECIAL_REST" | "REGULAR" | "REGULAR_REST" | "DOUBLE" | "DOUBLE_REST";
export const DAY_RATES: Record<DayType, { label: string; rate: number; ot: number }> = {
  ORDINARY: { label: "Ordinary day", rate: 1.0, ot: 1.25 },
  REST: { label: "Rest day", rate: 1.3, ot: 1.69 },
  SPECIAL: { label: "Special non-working day", rate: 1.3, ot: 1.69 },
  SPECIAL_REST: { label: "Special day on rest day", rate: 1.5, ot: 1.95 },
  REGULAR: { label: "Regular holiday", rate: 2.0, ot: 2.6 },
  REGULAR_REST: { label: "Regular holiday on rest day", rate: 2.6, ot: 3.38 },
  DOUBLE: { label: "Double holiday", rate: 3.0, ot: 3.9 },
  DOUBLE_REST: { label: "Double holiday on rest day", rate: 3.9, ot: 5.07 },
};
export const NIGHT_DIFF = 0.10;
export const NIGHT_START = 22 * 60; // 10:00 PM
export const NIGHT_END = 6 * 60;    // 6:00 AM

export function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
