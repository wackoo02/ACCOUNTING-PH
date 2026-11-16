import { describe, expect, it } from "vitest";
import { accrualBetween, addMonths, buildSchedule, presentValue, tenPercentTest, utc } from "@/lib/debt/schedule";

const terms = { rate: 8, dayCount: "30_360" as const, frequency: "MONTHLY" as const, repaymentType: "ANNUITY" as const, anchor: utc("2026-02-01"), maturityDate: utc("2027-01-01") };

describe("loan schedule math", () => {
  it("keeps month-end dates sensible", () => expect(addMonths(utc("2026-01-31"), 1).toISOString().slice(0, 10)).toBe("2026-02-28"));
  it("repays the principal exactly and uses the contract rate when there are no costs", () => {
    const { rows, eir } = buildSchedule(utc("2026-01-01"), 120000000n, 120000000n, terms);
    expect(rows).toHaveLength(12);
    expect(rows.reduce((s, r) => s + r.principal, 0n)).toBe(120000000n);
    expect(rows[0].interest).toBe(800000n);
    expect(eir).toBe(8);
    expect(rows.every((r) => r.amortization === 0n)).toBe(true);
  });
  it("amortizes transaction costs fully at the effective rate", () => {
    const { rows, eir } = buildSchedule(utc("2026-01-01"), 120000000n, 118000000n, terms);
    expect(eir).toBeGreaterThan(8);
    expect(rows.reduce((s, r) => s + r.amortization, 0n)).toBe(2000000n);
    expect(rows.at(-1)!.closingCarrying).toBe(0n);
    expect(presentValue(rows, eir, "30_360")).toBe(118000000n);
  });
  it("bullet loans repay principal at maturity", () => {
    const { rows } = buildSchedule(utc("2026-01-01"), 100000000n, 100000000n, { ...terms, repaymentType: "BULLET", frequency: "QUARTERLY", anchor: utc("2026-04-01") });
    expect(rows.slice(0, -1).every((r) => r.principal === 0n)).toBe(true);
    expect(rows.at(-1)!.principal).toBe(100000000n);
  });
  it("accrues partial periods without double counting", () => {
    const { rows } = buildSchedule(utc("2026-01-01"), 120000000n, 118000000n, terms);
    const a = accrualBetween(rows, utc("2026-01-01"), utc("2026-01-20"));
    const b = accrualBetween(rows, utc("2026-01-20"), utc("2026-02-01"));
    expect(a.interest + b.interest).toBe(rows[0].interest);
    expect(a.eir + b.eir).toBe(rows[0].eirInterest);
  });
  it("applies the 10% test", () => {
    expect(tenPercentTest(100000000n, 95000000n, 0n).substantial).toBe(false);
    expect(tenPercentTest(100000000n, 85000000n, 0n).substantial).toBe(true);
  });
});
