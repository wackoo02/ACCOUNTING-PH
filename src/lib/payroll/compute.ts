// Payslip computation for one employee and one payroll run (PH Labor Code, SSS, PhilHealth, Pag-IBIG, BIR).
// Pure function: the service gathers attendance, items and year-to-date figures and stores the result.
// Amounts are pesos rounded to centavos at every line.
import type { DayResult } from "./attendance";
import {
  DAY_RATES, NIGHT_DIFF, THIRTEENTH_EXEMPT_CEILING, deMinimisLimitPerRun, pagibigContribution, philhealthContribution, round2,
  sssContribution, withholdingTax, type DayType,
} from "./rates";

export type PayFrequency = "SEMI_MONTHLY" | "MONTHLY";
export type RunKind = "REGULAR" | "THIRTEENTH_MONTH" | "SPECIAL";

// Where each earnings line goes in the GL (account system roles).
export type EarningGroup = "BASIC" | "PREMIUM" | "NIGHT_DIFF" | "OVERTIME" | "ALLOWANCE" | "BONUS" | "COMMISSION" | "THIRTEENTH";
export const EARNING_ROLE: Record<EarningGroup, string> = {
  BASIC: "SALARIES_EXPENSE", PREMIUM: "SALARIES_EXPENSE", NIGHT_DIFF: "SALARIES_EXPENSE", OVERTIME: "OVERTIME_EXPENSE",
  ALLOWANCE: "ALLOWANCE_EXPENSE", BONUS: "BONUS_EXPENSE", COMMISSION: "COMMISSION_EXPENSE", THIRTEENTH: "BONUS_EXPENSE",
};

/** Kinds of recurring or one-off pay items an employee can have. */
export const ITEM_CATEGORIES = {
  EARNING: {
    ALLOWANCE_TAXABLE: "Taxable allowance",
    DE_MINIMIS: "De minimis benefit",
    BONUS: "Bonus / incentive",
    COMMISSION: "Commission",
    OTHER_TAXABLE: "Other taxable earning",
    OTHER_NONTAX: "Non-taxable earning (reimbursement)",
  },
  DEDUCTION: {
    SSS_LOAN: "SSS salary / calamity loan",
    HDMF_LOAN: "Pag-IBIG loan",
    COMPANY_LOAN: "Company loan / cash advance",
    GARNISHMENT: "Garnishment / court order",
    HDMF_VOLUNTARY: "Pag-IBIG voluntary (MP2 / additional)",
    OTHER: "Other deduction",
  },
  EMPLOYER: {
    HMO: "HMO / health insurance",
    INSURANCE: "Life / group insurance",
    RETIREMENT: "Retirement fund contribution",
    OTHER_BENEFIT: "Other employer benefit",
  },
} as const;
export type ItemKind = keyof typeof ITEM_CATEGORIES;

export const DEDUCTION_ROLE: Record<string, string> = {
  SSS_LOAN: "GOVT_LOANS_PAYABLE", HDMF_LOAN: "GOVT_LOANS_PAYABLE", HDMF_VOLUNTARY: "HDMF_PAYABLE",
  COMPANY_LOAN: "EMPLOYEE_ADVANCES", GARNISHMENT: "OTHER_PAYROLL_DEDUCTIONS", OTHER: "OTHER_PAYROLL_DEDUCTIONS",
};
export const EMPLOYER_ROLE: Record<string, string> = {
  HMO: "BENEFITS_EXPENSE", INSURANCE: "BENEFITS_EXPENSE", RETIREMENT: "RETIREMENT_EXPENSE", OTHER_BENEFIT: "BENEFITS_EXPENSE",
};

export type PayItem = {
  itemId?: string;
  kind: ItemKind;
  category: string;
  name: string;
  amount: number;
  deMinimisCode?: string | null;
  balance?: number | null; // loans: remaining balance caps the deduction
};

export type EmployeePay = {
  payBasis: "MONTHLY" | "DAILY";
  basicRate: number;         // monthly salary or daily rate
  workDaysPerYear: number;   // 261 (Mon-Fri), 313 (Mon-Sat), 365 ...
  minimumWageEarner: boolean;
};

export type YearToDate = {
  monthCompensation: number; // SSS compensation already paid this month in earlier runs
  monthSssEE: number; monthSssER: number; monthMpfEE: number; monthMpfER: number; monthEc: number;
  monthPhicEE: number; monthPhicER: number; monthHdmfEE: number; monthHdmfER: number;
  ytdTaxable: number;        // taxable compensation (after contributions) so far this year
  ytdTax: number;            // tax withheld so far this year
  ytdExemptBenefits: number; // 13th month and other benefits already treated as exempt (P90,000 ceiling)
  ytdBasic: number;          // basic salary earned this year (13th month base)
  ytd13th: number;           // 13th month already paid this year
};
export const EMPTY_YTD: YearToDate = {
  monthCompensation: 0, monthSssEE: 0, monthSssER: 0, monthMpfEE: 0, monthMpfER: 0, monthEc: 0, monthPhicEE: 0, monthPhicER: 0,
  monthHdmfEE: 0, monthHdmfER: 0, ytdTaxable: 0, ytdTax: 0, ytdExemptBenefits: 0, ytdBasic: 0, ytd13th: 0,
};

export type RunSettings = {
  kind: RunKind;
  frequency: PayFrequency;
  deductContributions: boolean; // last run of the month: SSS / PhilHealth / Pag-IBIG are deducted here
  yearEndAdjustment: boolean;   // annualize tax (last run of the year or on separation)
  payUnworkedSpecialDays?: boolean; // company policy for monthly-paid (default true: no deduction)
};

export type Line = {
  code: string;
  label: string;
  amount: number;
  qty?: number;       // hours or days
  unit?: "hr" | "day" | "min";
  group?: EarningGroup;
  taxable?: boolean;
  role?: string;      // GL system role for deductions / employer costs
  itemId?: string;
};

export type PayslipResult = {
  dailyRate: number;
  hourlyRate: number;
  monthlyRate: number;
  earnings: Line[];
  deductions: Line[];
  employer: Line[];
  gross: number;
  basicPay: number;          // basic salary after absences/tardiness (13th month base)
  sssCompensation: number;   // compensation counted for SSS this run
  taxableEarnings: number;
  nonTaxable: number;        // de minimis, exempt 13th month / benefits, MWE exempt pay
  exemptBenefitsUsed: number;
  contributionsEE: number;
  taxableIncome: number;     // taxable earnings less employee contributions
  withholdingTax: number;
  otherDeductions: number;
  netPay: number;
  employerCost: number;
  sss: { msc: number; ee: number; er: number; ec: number; mpfEE: number; mpfER: number };
  philhealth: { ee: number; er: number };
  pagibig: { ee: number; er: number };
  warnings: string[];
};

export function ratesFor(e: EmployeePay) {
  const factor = e.workDaysPerYear > 0 ? e.workDaysPerYear : 261;
  const daily = e.payBasis === "MONTHLY" ? e.basicRate * 12 / factor : e.basicRate;
  const monthly = e.payBasis === "MONTHLY" ? e.basicRate : e.basicRate * factor / 12;
  return { daily, hourly: daily / 8, monthly };
}

const isRest = (t: DayType) => t === "REST" || t.endsWith("_REST");

export function computePayslip(emp: EmployeePay, days: DayResult[], items: PayItem[], ytd: YearToDate, run: RunSettings): PayslipResult {
  const { daily, hourly, monthly } = ratesFor(emp);
  const runsPerMonth = run.frequency === "SEMI_MONTHLY" ? 2 : 1;
  const earnings: Line[] = [];
  const deductions: Line[] = [];
  const employer: Line[] = [];
  const warnings: string[] = [];
  const add = (l: Line) => { l.amount = round2(l.amount); if (l.amount !== 0) earnings.push(l); };

  // ---- Time-based pay (regular runs only) ----
  if (run.kind === "REGULAR") {
    if (emp.payBasis === "MONTHLY") {
      add({ code: "BASIC", label: "Basic salary", amount: emp.basicRate / runsPerMonth, group: "BASIC", taxable: true });
      const absentDays = days.reduce((n, d) => n + d.absentDays + (d.leave && !d.leave.paid && d.scheduled ? d.leave.fraction : 0), 0);
      if (absentDays) add({ code: "ABSENT", label: "Absences / unpaid leave", qty: absentDays, unit: "day", amount: -absentDays * daily, group: "BASIC", taxable: true });
      if (run.payUnworkedSpecialDays === false) {
        const sp = days.filter((d) => d.scheduled && !d.worked && d.unworkedHoliday === "SPECIAL" && !d.leave).length;
        if (sp) add({ code: "SPECIAL_UNPAID", label: "Unworked special days (no work, no pay)", qty: sp, unit: "day", amount: -sp * daily, group: "BASIC", taxable: true });
      }
      const late = days.filter((d) => d.dayType === "ORDINARY").reduce((n, d) => n + d.lateMinutes + d.undertimeMinutes, 0);
      if (late) add({ code: "LATE", label: "Tardiness / undertime", qty: late, unit: "min", amount: -late * hourly / 60, group: "BASIC", taxable: true });
    } else {
      const ordMin = days.filter((d) => d.dayType === "ORDINARY").reduce((n, d) => n + d.regularMinutes, 0);
      if (ordMin) add({ code: "BASIC", label: "Basic pay (days worked)", qty: round2(ordMin / 60), unit: "hr", amount: ordMin / 60 * hourly, group: "BASIC", taxable: true });
      const leaveDays = days.filter((d) => d.leave?.paid && d.dayType === "ORDINARY").reduce((n, d) => n + d.leave!.fraction, 0);
      if (leaveDays) add({ code: "PAID_LEAVE", label: "Paid leave", qty: leaveDays, unit: "day", amount: leaveDays * daily, group: "BASIC", taxable: true });
      const hol = days.filter((d) => !d.worked && (d.unworkedHoliday === "REGULAR" || d.unworkedHoliday === "DOUBLE"))
        .reduce((n, d) => n + (d.unworkedHoliday === "DOUBLE" ? 2 : 1), 0);
      if (hol) add({ code: "HOLIDAY_UNWORKED", label: "Regular holiday pay (unworked)", qty: hol, unit: "day", amount: hol * daily, group: "BASIC", taxable: true });
    }

    // Work on rest days and holidays, overtime and night differential, grouped by type of day.
    const byType = new Map<DayType, { reg: number; ot: number; nd: number; otNd: number; rest: boolean }>();
    for (const d of days) {
      const g = byType.get(d.dayType) ?? { reg: 0, ot: 0, nd: 0, otNd: 0, rest: isRest(d.dayType) };
      g.reg += d.dayType === "ORDINARY" ? 0 : d.regularMinutes;
      g.ot += d.otMinutes; g.nd += d.nightMinutes; g.otNd += d.otNightMinutes;
      byType.set(d.dayType, g);
    }
    for (const [t, g] of byType) {
      const r = DAY_RATES[t];
      if (g.reg) {
        // Monthly pay already covers ordinary working days incl. holidays that fall on them; rest days are not covered.
        const covered = emp.payBasis === "MONTHLY" && !g.rest ? 1 : 0;
        const mult = r.rate - covered;
        if (mult > 0) add({ code: `PREM_${t}`, label: `${r.label} work (${Math.round(r.rate * 100)}%${covered ? ", premium only" : ""})`, qty: round2(g.reg / 60), unit: "hr", amount: g.reg / 60 * hourly * mult, group: "PREMIUM", taxable: true });
      }
      if (g.ot) add({ code: `OT_${t}`, label: `Overtime - ${r.label.toLowerCase()} (${Math.round(r.ot * 100)}%)`, qty: round2(g.ot / 60), unit: "hr", amount: g.ot / 60 * hourly * r.ot, group: "OVERTIME", taxable: true });
      const nd = g.nd / 60 * hourly * r.rate * NIGHT_DIFF + g.otNd / 60 * hourly * r.ot * NIGHT_DIFF;
      if (nd) add({ code: `ND_${t}`, label: `Night differential - ${r.label.toLowerCase()}`, qty: round2((g.nd + g.otNd) / 60), unit: "hr", amount: nd, group: "NIGHT_DIFF", taxable: true });
    }
  }

  // ---- 13th month pay (PD 851): 1/12 of basic salary earned in the year, less what was already paid ----
  if (run.kind === "THIRTEENTH_MONTH") {
    const due = round2(ytd.ytdBasic / 12 - ytd.ytd13th);
    if (due > 0) add({ code: "THIRTEENTH", label: "13th month pay", amount: due, group: "THIRTEENTH", taxable: false });
  }

  // ---- Allowances, bonuses, commissions ----
  let benefitsPool = 0; // 13th month + other benefits + excess de minimis (P90,000 ceiling)
  const poolLines: Line[] = [];
  for (const l of earnings) if (l.group === "THIRTEENTH") { benefitsPool += l.amount; poolLines.push(l); }
  for (const it of items.filter((i) => i.kind === "EARNING")) {
    const amt = round2(it.amount);
    if (!amt) continue;
    if (it.category === "DE_MINIMIS") {
      const limit = it.deMinimisCode ? deMinimisLimitPerRun(it.deMinimisCode, runsPerMonth) : null;
      const exempt = limit === null ? amt : Math.min(amt, round2(limit));
      add({ code: "DM", label: it.name, amount: exempt, group: "ALLOWANCE", taxable: false, itemId: it.itemId });
      if (amt > exempt) {
        const ex: Line = { code: "DM_EXCESS", label: `${it.name} (over de minimis ceiling)`, amount: round2(amt - exempt), group: "ALLOWANCE", taxable: false, itemId: it.itemId };
        add(ex); benefitsPool += ex.amount; poolLines.push(ex);
      }
    } else if (it.category === "BONUS") {
      const l: Line = { code: "BONUS", label: it.name, amount: amt, group: "BONUS", taxable: false, itemId: it.itemId };
      add(l); benefitsPool += l.amount; poolLines.push(l);
    } else if (it.category === "COMMISSION") add({ code: "COMMISSION", label: it.name, amount: amt, group: "COMMISSION", taxable: true, itemId: it.itemId });
    else if (it.category === "OTHER_NONTAX") add({ code: "NONTAX", label: it.name, amount: amt, group: "ALLOWANCE", taxable: false, itemId: it.itemId });
    else add({ code: "ALLOWANCE", label: it.name, amount: amt, group: it.category === "OTHER_TAXABLE" ? "BONUS" : "ALLOWANCE", taxable: true, itemId: it.itemId });
  }
  // Benefits over the P90,000 ceiling are taxable. Split the pool lines so the excess is visible.
  const exemptRoom = Math.max(0, THIRTEENTH_EXEMPT_CEILING - ytd.ytdExemptBenefits);
  const exemptBenefitsUsed = round2(Math.min(benefitsPool, exemptRoom));
  let excessBenefits = round2(benefitsPool - exemptBenefitsUsed);
  for (const l of [...poolLines].reverse()) {
    if (excessBenefits <= 0) break;
    const take = Math.min(l.amount, excessBenefits);
    if (take === l.amount) l.taxable = true;
    else {
      l.amount = round2(l.amount - take);
      earnings.splice(earnings.indexOf(l) + 1, 0, { ...l, code: `${l.code}_TAXABLE`, label: `${l.label} - taxable portion (over P90,000)`, amount: round2(take), taxable: true });
    }
    excessBenefits = round2(excessBenefits - take);
  }

  const gross = round2(earnings.reduce((n, l) => n + l.amount, 0));
  const basicPay = round2(earnings.filter((l) => l.group === "BASIC").reduce((n, l) => n + l.amount, 0));
  const timeGroups: EarningGroup[] = ["BASIC", "PREMIUM", "NIGHT_DIFF", "OVERTIME"];
  const sssCompensation = round2(earnings.filter((l) => timeGroups.includes(l.group!) || (l.taxable && (l.group === "ALLOWANCE" || l.group === "COMMISSION"))).reduce((n, l) => n + l.amount, 0));

  // ---- Statutory contributions (monthly; deducted in the last run of the month) ----
  let sss = { msc: 0, ee: 0, er: 0, ec: 0, mpfEE: 0, mpfER: 0 }, phic = { ee: 0, er: 0 }, hdmf = { ee: 0, er: 0 };
  if (run.deductContributions && run.kind === "REGULAR") {
    const s = sssContribution(ytd.monthCompensation + sssCompensation);
    sss = {
      msc: s.msc, ee: round2(s.ee - ytd.monthSssEE), er: round2(s.er - ytd.monthSssER), ec: round2(s.ec - ytd.monthEc),
      mpfEE: round2(s.mpfEE - ytd.monthMpfEE), mpfER: round2(s.mpfER - ytd.monthMpfER),
    };
    const p = philhealthContribution(monthly);
    phic = { ee: round2(p.ee - ytd.monthPhicEE), er: round2(p.er - ytd.monthPhicER) };
    const h = pagibigContribution(monthly);
    hdmf = { ee: round2(h.ee - ytd.monthHdmfEE), er: round2(h.er - ytd.monthHdmfER) };
  }
  const contributionsEE = round2(sss.ee + sss.mpfEE + phic.ee + hdmf.ee);
  const ded = (l: Line) => { l.amount = round2(l.amount); if (l.amount !== 0) deductions.push(l); };
  ded({ code: "SSS", label: `SSS contribution (MSC ${sss.msc.toLocaleString("en-PH")})`, amount: sss.ee, role: "SSS_PAYABLE" });
  ded({ code: "SSS_MPF", label: "SSS Mandatory Provident Fund (WISP)", amount: sss.mpfEE, role: "SSS_PAYABLE" });
  ded({ code: "PHIC", label: "PhilHealth contribution", amount: phic.ee, role: "PHIC_PAYABLE" });
  ded({ code: "HDMF", label: "Pag-IBIG contribution", amount: hdmf.ee, role: "HDMF_PAYABLE" });

  // ---- Withholding tax on compensation ----
  const mweExempt: EarningGroup[] = ["BASIC", "PREMIUM", "NIGHT_DIFF", "OVERTIME"];
  const taxableEarnings = round2(earnings.filter((l) => l.taxable && !(emp.minimumWageEarner && mweExempt.includes(l.group!))).reduce((n, l) => n + l.amount, 0));
  const nonTaxable = round2(gross - taxableEarnings);
  // Mandatory employee contributions are excluded from taxable compensation (MWEs: already exempt).
  const taxableIncome = round2(Math.max(0, taxableEarnings - (emp.minimumWageEarner ? 0 : contributionsEE)));
  let tax = 0;
  if (run.yearEndAdjustment) {
    tax = round2(withholdingTax(ytd.ytdTaxable + taxableIncome, "ANNUAL") - ytd.ytdTax);
    if (tax < 0) warnings.push(`Year-end adjustment: P${(-tax).toFixed(2)} of tax over-withheld this year is refunded in this payslip.`);
  } else {
    tax = withholdingTax(taxableIncome, run.frequency);
  }
  ded({ code: "WTAX", label: tax < 0 ? "Withholding tax refund (year-end adjustment)" : "Withholding tax", amount: tax, role: "WTC_PAYABLE" });

  // ---- Loans and other deductions ----
  let otherDeductions = 0;
  for (const it of items.filter((i) => i.kind === "DEDUCTION")) {
    let amt = round2(it.amount);
    if (it.balance !== null && it.balance !== undefined) amt = Math.min(amt, round2(it.balance));
    if (amt <= 0) continue;
    ded({ code: it.category, label: it.name, amount: amt, role: DEDUCTION_ROLE[it.category] ?? "OTHER_PAYROLL_DEDUCTIONS", itemId: it.itemId });
    otherDeductions = round2(otherDeductions + amt);
  }

  // ---- Employer share and benefits ----
  const er = (l: Line) => { l.amount = round2(l.amount); if (l.amount !== 0) employer.push(l); };
  er({ code: "SSS_ER", label: "SSS employer share", amount: sss.er, role: "SSS_PAYABLE" });
  er({ code: "SSS_MPF_ER", label: "SSS MPF employer share", amount: sss.mpfER, role: "SSS_PAYABLE" });
  er({ code: "SSS_EC", label: "SSS Employees' Compensation (EC)", amount: sss.ec, role: "SSS_PAYABLE" });
  er({ code: "PHIC_ER", label: "PhilHealth employer share", amount: phic.er, role: "PHIC_PAYABLE" });
  er({ code: "HDMF_ER", label: "Pag-IBIG employer share", amount: hdmf.er, role: "HDMF_PAYABLE" });
  for (const it of items.filter((i) => i.kind === "EMPLOYER")) er({ code: it.category, label: it.name, amount: it.amount, role: EMPLOYER_ROLE[it.category] ?? "BENEFITS_EXPENSE", itemId: it.itemId });

  const totalDeductions = round2(deductions.reduce((n, l) => n + l.amount, 0));
  const netPay = round2(gross - totalDeductions);
  if (netPay < 0) warnings.push("Net pay is negative. Reduce loan or other deductions for this payroll.");
  if (gross === 0 && run.kind === "REGULAR") warnings.push("No pay computed: check the employee's rate and attendance.");
  const employerCost = round2(employer.reduce((n, l) => n + l.amount, 0));

  return {
    dailyRate: round2(daily), hourlyRate: round2(hourly), monthlyRate: round2(monthly),
    earnings, deductions, employer, gross, basicPay, sssCompensation, taxableEarnings, nonTaxable, exemptBenefitsUsed,
    contributionsEE, taxableIncome, withholdingTax: tax, otherDeductions, netPay, employerCost,
    sss, philhealth: phic, pagibig: hdmf, warnings,
  };
}
