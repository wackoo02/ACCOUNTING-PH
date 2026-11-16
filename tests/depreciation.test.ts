import { describe, expect, it } from "vitest";
import { catchUp, depForMonth, disposalThroughIdx, monthIdx, schedule, startIdx, type DepState } from "@/lib/assets/depreciation";

const d = (s: string) => new Date(s + "T00:00:00Z");
const base: DepState = { cost: 3_600_000n, salvage: 0n, accum: 0n, lifeMonths: 36, method: "STRAIGHT_LINE", inService: d("2026-01-10") };
const total = (s: DepState) => schedule(s, startIdx(s.inService!), startIdx(s.inService!) + (s.lifeMonths ?? 0) + 5).reduce((t, r) => t + r.depreciation, 0n);

describe("depreciation engine", () => {
  it("starts in the month of service on or before the 15th, else the next month", () => {
    expect(startIdx(d("2026-01-15"))).toBe(monthIdx(d("2026-01-01")));
    expect(startIdx(d("2026-01-16"))).toBe(monthIdx(d("2026-02-01")));
    expect(disposalThroughIdx(d("2026-06-10"))).toBe(monthIdx(d("2026-05-01")));
    expect(disposalThroughIdx(d("2026-06-20"))).toBe(monthIdx(d("2026-06-01")));
  });

  it("straight-line: equal months and exactly cost less salvage over the life", () => {
    const s = { ...base, salvage: 100_000n };
    const rows = schedule(s, startIdx(s.inService!), startIdx(s.inService!) + 40);
    expect(rows[0].depreciation).toBe(97_222n); // (36,000 - 1,000) / 36 = 972.22
    expect(rows.filter((r) => r.depreciation > 0n)).toHaveLength(36);
    expect(total(s)).toBe(3_500_000n);
    expect(rows.at(-1)!.nbv).toBe(100_000n);
  });

  it("sum-of-the-years and double declining balance fully depreciate to salvage", () => {
    for (const method of ["SUM_OF_YEARS", "DECLINING_BALANCE"]) {
      const s = { ...base, method, salvage: 360_000n };
      const rows = schedule(s, startIdx(s.inService!), startIdx(s.inService!) + 40);
      expect(rows[0].depreciation).toBeGreaterThan(rows[20].depreciation);
      expect(total(s)).toBe(3_240_000n);
    }
    // SYD first month = base * 36 / 666
    expect(depForMonth({ ...base, method: "SUM_OF_YEARS" }, startIdx(base.inService!))).toBe(194_595n);
    // DDB first month = cost * 2 / 36
    expect(depForMonth({ ...base, method: "DECLINING_BALANCE" }, startIdx(base.inService!))).toBe(200_000n);
  });

  it("charges nothing for land, before service, or with no useful life", () => {
    expect(depForMonth({ ...base, method: "NONE" }, startIdx(base.inService!))).toBe(0n);
    expect(depForMonth(base, startIdx(base.inService!) - 1)).toBe(0n);
    expect(depForMonth({ ...base, lifeMonths: null }, startIdx(base.inService!))).toBe(0n);
  });

  it("catches up missed months and spreads opening balances over the remaining life", () => {
    const cu = catchUp(base, null, monthIdx(d("2026-03-01")));
    expect(cu.months.map((m) => m.period)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(cu.total).toBe(300_000n);
    // Brought in with 12 months already charged: next month is still 1,000.
    const opening = { ...base, accum: 1_200_000n };
    expect(catchUp(opening, monthIdx(d("2026-12-01")), monthIdx(d("2027-01-01"))).total).toBe(100_000n);
    // An improvement of 12,000 after 12 months is spread over the 24 months left: 1,000 + 500.
    expect(depForMonth({ ...opening, cost: 4_800_000n }, monthIdx(d("2027-01-01")))).toBe(150_000n);
  });
});
