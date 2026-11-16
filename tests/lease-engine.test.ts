import { describe, expect, it } from "vitest";
import { accrue, addMonths, buildSchedule, generatePayments, maturityBuckets, measureLease, monthsFrom, presentValue, termMonths } from "@/lib/leases/engine";

const P = (pesos: number) => BigInt(Math.round(pesos * 100));
// Excel =PV(rate, nper, -pmt, 0, type) for cross-checking.
const excelPV = (r: number, n: number, pmt: number, type: 0 | 1) => (pmt * (1 - Math.pow(1 + r, -n))) / r * (type ? 1 + r : 1);

describe("dates", () => {
  it("adds months with month-end clamping", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });
  it("counts lease months and fractional time", () => {
    expect(termMonths("2026-01-01", "2030-12-31")).toBe(60);
    expect(termMonths("2026-03-15", "2027-03-14")).toBe(12);
    expect(monthsFrom("2026-01-01", "2026-02-01")).toBe(1);
    expect(monthsFrom("2026-01-15", "2026-01-31")).toBeCloseTo(16 / 31);
  });
});

describe("payments", () => {
  it("generates advance and arrears payments with escalation", () => {
    const adv = generatePayments({ cadenceStart: "2026-01-01", end: "2028-12-31", amount: P(50000), frequency: "MONTHLY", timing: "ADVANCE", escalationPct: 5, escalationEveryMonths: 12 });
    expect(adv).toHaveLength(36);
    expect(adv[0]).toEqual({ date: "2026-01-01", amount: P(50000) });
    expect(adv[12].amount).toBe(P(52500));
    expect(adv[35].amount).toBe(P(55125));
    const arr = generatePayments({ cadenceStart: "2026-01-01", end: "2026-12-31", amount: P(300000), frequency: "QUARTERLY", timing: "ARREARS" });
    expect(arr.map((p) => p.date)).toEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]);
  });
});

describe("measurement", () => {
  it("matches Excel PV for a lease that starts on the 1st (advance and arrears)", () => {
    for (const timing of ["ADVANCE", "ARREARS"] as const) {
      const m = measureLease({ commencementDate: "2026-01-01", endDate: "2030-12-31", paymentAmount: P(100000), frequency: "MONTHLY", timing, discountRatePct: 9 });
      expect(Number(m.liability) / 100).toBeCloseTo(excelPV(0.09 / 12, 60, 100000, timing === "ADVANCE" ? 1 : 0), 1);
      // the schedule unwinds to exactly zero, and interest = total payments - liability
      const rows = m.rows;
      expect(rows).toHaveLength(60);
      expect(rows[rows.length - 1].closing).toBe(0n);
      const interest = rows.reduce((s, r) => s + r.interest, 0n);
      expect(interest).toBe(P(100000) * 60n - m.liability);
      // straight-line depreciation sums to the ROU asset
      expect(rows.reduce((s, r) => s + r.depreciation, 0n)).toBe(m.rou);
      for (const r of rows) expect(r.closing).toBe(r.opening + r.interest - r.payment);
    }
  });

  it("first month interest equals opening balance less advance payment x monthly rate", () => {
    const m = measureLease({ commencementDate: "2026-01-01", endDate: "2027-12-31", paymentAmount: P(20000), frequency: "MONTHLY", timing: "ADVANCE", discountRatePct: 12 });
    const r = m.rows[0];
    expect(Number(r.interest)).toBeCloseTo(Number(m.liability - P(20000)) * 0.01, -1);
  });

  it("adds initial direct costs, prepaid rent and restoration, less incentives, to the ROU asset", () => {
    const m = measureLease({ commencementDate: "2026-01-01", endDate: "2028-12-31", paymentAmount: P(40000), frequency: "MONTHLY", timing: "ADVANCE", discountRatePct: 8,
      initialDirectCosts: P(15000), prepaidPayments: P(80000), restorationCost: P(50000), incentives: P(20000) });
    expect(m.rou).toBe(m.liability + P(125000));
  });

  it("splits current and non-current liability", () => {
    const m = measureLease({ commencementDate: "2026-01-01", endDate: "2028-12-31", paymentAmount: P(40000), frequency: "MONTHLY", timing: "ADVANCE", discountRatePct: 8 });
    // at commencement: current = liability - balance 12 months later
    expect(m.currentAtStart).toBe(m.liability - m.rows[11].closing);
    // in the final year everything is current
    expect(m.rows[24].currentPortion).toBe(m.rows[24].closing);
  });

  it("starts mid-month: part-month rows at both ends", () => {
    const m = measureLease({ commencementDate: "2026-03-15", endDate: "2027-03-14", paymentAmount: P(10000), frequency: "MONTHLY", timing: "ADVANCE", discountRatePct: 6 });
    expect(m.rows[0]).toMatchObject({ periodStart: "2026-03-15", periodEnd: "2026-03-31" });
    expect(m.rows[m.rows.length - 1]).toMatchObject({ periodStart: "2027-03-01", periodEnd: "2027-03-14" });
    expect(m.rows.at(-1)!.closing).toBe(0n);
  });

  it("depreciates over useful life when ownership transfers", () => {
    const m = measureLease({ commencementDate: "2026-01-01", endDate: "2028-12-31", paymentAmount: P(30000), frequency: "MONTHLY", timing: "ARREARS", discountRatePct: 10, transfersOwnership: true, usefulLifeMonths: 60 });
    expect(m.rows).toHaveLength(60);
    expect(m.rows[36].closing).toBe(0n);
    expect(m.rows.reduce((s, r) => s + r.depreciation, 0n)).toBe(m.rou);
  });

  it("expenses short-term leases straight line", () => {
    const m = measureLease({ commencementDate: "2026-01-01", endDate: "2026-12-31", paymentAmount: P(30000), frequency: "QUARTERLY", timing: "ADVANCE", discountRatePct: 0, exempt: true });
    expect(m.liability).toBe(0n);
    expect(m.rou).toBe(0n);
    expect(m.rows.reduce((s, r) => s + r.depreciation, 0n)).toBe(P(120000));
    expect(m.rows[0].payment).toBe(P(30000));
  });
});

describe("remeasurement helpers", () => {
  it("accrue matches the schedule for a full month", () => {
    const m = measureLease({ commencementDate: "2026-01-01", endDate: "2027-12-31", paymentAmount: P(20000), frequency: "MONTHLY", timing: "ADVANCE", discountRatePct: 12 });
    const r = m.rows[3];
    const a = accrue(r.opening, r.periodStart, r.periodEnd, m.payments, 0.12, "2026-01-01");
    expect(a.interest).toBe(r.interest);
    expect(a.closing).toBe(r.closing);
  });
  it("rebuilding from a later date gives the same balance as the original schedule", () => {
    const m = measureLease({ commencementDate: "2026-01-01", endDate: "2027-12-31", paymentAmount: P(20000), frequency: "MONTHLY", timing: "ADVANCE", discountRatePct: 12 });
    const pv = presentValue(m.payments, "2026-07-01", 0.12, "2026-01-01");
    expect(Number(pv - m.rows[5].closing)).toBeLessThan(200); // within a few pesos of accumulated rounding
    const again = buildSchedule({ start: "2026-07-01", leaseEnd: "2027-12-31", depEnd: "2027-12-31", payments: m.payments, rate: 0.12, origin: "2026-01-01", rou: m.rows[5].rouClosing });
    expect(again.rows.at(-1)!.closing).toBe(0n);
  });
});

describe("maturity analysis", () => {
  it("buckets undiscounted payments after the reporting date", () => {
    const pays = generatePayments({ cadenceStart: "2026-01-01", end: "2032-12-31", amount: P(1000), frequency: "ANNUAL", timing: "ADVANCE" });
    const b = maturityBuckets(pays, "2026-12-31");
    expect(b).toEqual([P(1000), P(1000), P(1000), P(1000), P(1000), P(1000)]);
  });
});
