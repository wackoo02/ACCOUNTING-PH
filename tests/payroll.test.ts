import { describe, expect, it } from "vitest";
import { sssContribution, philhealthContribution, pagibigContribution, withholdingTax } from "@/lib/payroll/rates";
import { evaluateDay, manilaInstant, nightMinutes, type ShiftDef } from "@/lib/payroll/attendance";
import { computePayslip, EMPTY_YTD, type EmployeePay } from "@/lib/payroll/compute";
import { easter, nationalHolidays } from "@/lib/payroll/holidays";

const day: ShiftDef = { start: 480, end: 1020, breakMinutes: 60, graceMinutes: 5, restDays: [0, 6] };
const night: ShiftDef = { start: 1320, end: 420, breakMinutes: 60, graceMinutes: 0, restDays: [0, 6] };
const at = (date: string, hhmm: string, nextDay = false) => {
  const [h, m] = hhmm.split(":").map(Number);
  return manilaInstant(date, h * 60 + m + (nextDay ? 1440 : 0));
};

describe("statutory tables", () => {
  it("SSS 2025 schedule: 5% / 10%, MSC 5,000-35,000, MPF over 20,000", () => {
    expect(sssContribution(4000)).toMatchObject({ msc: 5000, ee: 250, er: 500, ec: 10 });
    expect(sssContribution(25000)).toMatchObject({ msc: 25000, ee: 1000, er: 2000, mpfEE: 250, mpfER: 500, ec: 30 });
    expect(sssContribution(80000)).toMatchObject({ msc: 35000, mpfEE: 750, mpfER: 1500 });
    expect(sssContribution(14749.99).msc).toBe(14500);
    expect(sssContribution(14750).msc).toBe(15000);
  });
  it("PhilHealth 5% with floor and ceiling, Pag-IBIG capped at 200", () => {
    expect(philhealthContribution(8000)).toEqual({ base: 10000, ee: 250, er: 250 });
    expect(philhealthContribution(30000)).toEqual({ base: 30000, ee: 750, er: 750 });
    expect(philhealthContribution(150000)).toEqual({ base: 100000, ee: 2500, er: 2500 });
    expect(pagibigContribution(25000)).toEqual({ base: 10000, ee: 200, er: 200 });
    expect(pagibigContribution(1500)).toEqual({ base: 1500, ee: 15, er: 30 });
  });
  it("BIR TRAIN withholding tables", () => {
    expect(withholdingTax(20833, "MONTHLY")).toBe(0);
    expect(withholdingTax(30000, "MONTHLY")).toBe(1375.05);
    expect(withholdingTax(40000, "MONTHLY")).toBe(3208.4);
    expect(withholdingTax(15000, "SEMI_MONTHLY")).toBe(687.45);
    expect(withholdingTax(500000, "ANNUAL")).toBe(42500);
  });
});

describe("attendance", () => {
  it("late, undertime and approved overtime on a day shift", () => {
    const r = evaluateDay({ date: "2026-03-02", shift: day, restDay: false, holidays: [], timeIn: at("2026-03-02", "08:20"), timeOut: at("2026-03-02", "19:00"), otApprovedMinutes: 90 });
    expect(r).toMatchObject({ dayType: "ORDINARY", lateMinutes: 20, undertimeMinutes: 0, otMinutes: 90, regularMinutes: 460 });
  });
  it("grace period and absence", () => {
    expect(evaluateDay({ date: "2026-03-02", shift: day, restDay: false, holidays: [], timeIn: at("2026-03-02", "08:04"), timeOut: at("2026-03-02", "17:00") }).lateMinutes).toBe(0);
    expect(evaluateDay({ date: "2026-03-02", shift: day, restDay: false, holidays: [] }).absentDays).toBe(1);
    expect(evaluateDay({ date: "2026-03-02", shift: day, restDay: false, holidays: [], leave: { code: "VL", paid: true, fraction: 1 } }).absentDays).toBe(0);
  });
  it("night shift crossing midnight gets night differential", () => {
    expect(nightMinutes(1320, 1860)).toBe(480);
    const r = evaluateDay({ date: "2026-03-02", shift: night, restDay: false, holidays: [], timeIn: at("2026-03-02", "22:00"), timeOut: at("2026-03-02", "07:00", true) });
    expect(r.regularMinutes).toBe(480);
    expect(r.nightMinutes).toBe(480);
    expect(r.lateMinutes + r.undertimeMinutes).toBe(0);
  });
  it("holiday on a rest day", () => {
    const r = evaluateDay({ date: "2026-11-01", shift: day, restDay: true, holidays: ["SPECIAL"], timeIn: at("2026-11-01", "08:00"), timeOut: at("2026-11-01", "17:00") });
    expect(r.dayType).toBe("SPECIAL_REST");
  });
});

describe("payslip", () => {
  const monthly: EmployeePay = { payBasis: "MONTHLY", basicRate: 30000, workDaysPerYear: 261, minimumWageEarner: false };
  const run = { kind: "REGULAR" as const, frequency: "SEMI_MONTHLY" as const, deductContributions: true, yearEndAdjustment: false };
  const worked = (date: string, extra: Partial<Parameters<typeof evaluateDay>[0]> = {}) =>
    evaluateDay({ date, shift: day, restDay: false, holidays: [], timeIn: at(date, "08:00"), timeOut: at(date, "17:00"), ...extra });

  it("monthly-paid: half month, absence, overtime, holiday premium, contributions and tax", () => {
    const days = [
      worked("2026-06-01"), worked("2026-06-02", { timeOut: at("2026-06-02", "19:00"), otApprovedMinutes: 120 }),
      evaluateDay({ date: "2026-06-03", shift: day, restDay: false, holidays: [] }),
      worked("2026-06-12", { holidays: ["REGULAR"] }),
    ];
    const p = computePayslip(monthly, days, [{ kind: "EARNING", category: "DE_MINIMIS", name: "Rice subsidy", amount: 1500, deMinimisCode: "RICE" }], EMPTY_YTD, run);
    const daily = 30000 * 12 / 261, hourly = daily / 8;
    const line = (code: string) => p.earnings.find((l) => l.code === code)?.amount;
    expect(line("BASIC")).toBe(15000);
    expect(line("ABSENT")).toBeCloseTo(-daily, 2);
    expect(line("OT_ORDINARY")).toBeCloseTo(2 * hourly * 1.25, 2);
    expect(line("PREM_REGULAR")).toBeCloseTo(8 * hourly * 1.0, 2); // monthly pay already covers the first 100%
    expect(line("DM")).toBe(1250);   // rice ceiling 2,500/month = 1,250 per semi-monthly run
    expect(line("DM_EXCESS")).toBe(250);
    expect(p.sss.msc).toBe(15500); // basic less absence plus OT and holiday premium
    expect(p.sss.ee).toBe(775);
    expect(p.philhealth.ee).toBe(750);
    expect(p.pagibig.ee).toBe(200);
    expect(p.netPay).toBeCloseTo(p.gross - p.contributionsEE - p.withholdingTax, 2);
    expect(p.withholdingTax).toBe(withholdingTax(p.taxableIncome, "SEMI_MONTHLY"));
  });

  it("daily-paid gets unworked regular holiday and rest-day premium", () => {
    const dailyEmp: EmployeePay = { payBasis: "DAILY", basicRate: 700, workDaysPerYear: 313, minimumWageEarner: true };
    const days = [
      worked("2026-05-01", { holidays: ["REGULAR"], timeIn: null, timeOut: null }),
      worked("2026-05-02", { restDay: true }),
      worked("2026-05-04"),
    ];
    const p = computePayslip(dailyEmp, days, [], EMPTY_YTD, { ...run, deductContributions: false });
    expect(p.earnings.find((l) => l.code === "HOLIDAY_UNWORKED")?.amount).toBe(700);
    expect(p.earnings.find((l) => l.code === "PREM_REST")?.amount).toBe(910);
    expect(p.earnings.find((l) => l.code === "BASIC")?.amount).toBe(700);
    expect(p.withholdingTax).toBe(0); // minimum wage earner
  });

  it("13th month and bonuses are exempt up to 90,000 for the year", () => {
    const p = computePayslip(monthly, [], [{ kind: "EARNING", category: "BONUS", name: "Christmas bonus", amount: 70000 }],
      { ...EMPTY_YTD, ytdBasic: 330000 }, { kind: "THIRTEENTH_MONTH", frequency: "MONTHLY", deductContributions: false, yearEndAdjustment: false });
    expect(p.earnings.find((l) => l.code === "THIRTEENTH")?.amount).toBe(27500);
    expect(p.exemptBenefitsUsed).toBe(90000);
    expect(p.taxableEarnings).toBe(7500);
  });

  it("year-end adjustment refunds over-withheld tax", () => {
    const p = computePayslip(monthly, [worked("2026-12-01")], [], { ...EMPTY_YTD, ytdTaxable: 300000, ytdTax: 20000 }, { ...run, yearEndAdjustment: true });
    expect(p.withholdingTax).toBeLessThan(0);
  });
});

describe("holidays", () => {
  it("uses the 2026 proclamation and computes later years", () => {
    expect(nationalHolidays(2026).holidays.find((h) => h.name === "Good Friday")?.date).toBe("2026-04-03");
    expect(easter(2027)).toBe("2027-03-28");
    const h27 = nationalHolidays(2027).holidays;
    expect(h27.find((h) => h.name === "National Heroes Day")?.date).toBe("2027-08-30");
  });
});
