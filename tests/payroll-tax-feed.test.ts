// Payroll -> BIR tax engine mapping (pure parts): 1601-C monthly lines, 2316 -> Bir2316Data, 1604-C schedules.
import { describe, expect, it } from "vitest";
import { build2316 } from "@/lib/payroll/bir2316";
import { monthlyLines, toBir2316 } from "@/lib/payroll/tax-feed";
import { scheduleOf } from "@/lib/tax/lists";

const run = (id: string, payDate: string) => ({ id, number: id, payDate: new Date(payDate), journalEntryId: null });
const slip = (employeeId: string, r: ReturnType<typeof run>, basic: number, tax: number, mwe = false, extra: object[] = []) => ({
  employeeId, run: r, minimumWageEarner: mwe, withholdingTax: tax, sssEE: 500, mpfEE: 0, phicEE: 250, hdmfEE: 100,
  earnings: [{ code: "BASIC", label: "Basic", amount: basic, group: "BASIC", taxable: !mwe }, ...extra],
});
const emp = { code: "E1", lastName: "Cruz", firstName: "Jose", middleName: null, tin: "111-222-333-000", birthDate: null, address: null, minimumWageEarner: false, dateHired: new Date("2020-01-01"), separationDate: null };
const employer = { name: "Co", tin: null, address: null };

describe("1601-C monthly lines", () => {
  it("groups by pay month, splits non-taxable items and finds pay not subject to withholding", () => {
    const jun1 = run("R1", "2026-06-15"), jun2 = run("R2", "2026-06-30"), jul = run("R3", "2026-07-15");
    const lines = monthlyLines([
      slip("A", jun1, 30000, 1500), slip("A", jun2, 30000, 1500),
      slip("B", jun1, 9000, 0), // low earner, nothing withheld
      slip("M", jun1, 15000, 0, true, [{ code: "OT", label: "OT", amount: 800, group: "OVERTIME", taxable: false }]),
      slip("A", jul, 30000, 1500),
    ]);
    expect(lines.map((l) => l.month.toISOString().slice(0, 7))).toEqual(["2026-06", "2026-07"]);
    const j = lines[0];
    expect(j.employees).toBe(3);
    expect(j.taxWithheld).toBe("3000.00");
    expect(j.totalCompensation).toBe("84800.00");
    expect(j.breakdown!.smwMwe).toBe("14150.00"); // 15000 less 850 contributions
    expect(j.breakdown!.holidayOtNdHazardMwe).toBe("800.00");
    expect(j.breakdown!.govContributions).toBe("3400.00");
    expect(j.breakdown!.taxableNotWithheld).toBe("8150.00");
    expect(Number(j.taxableCompensation) + Number(j.nonTaxable)).toBeCloseTo(84800, 2);
    expect(j.runs!.map((r) => r.number)).toEqual(["R1", "R2"]);
  });
});

describe("2316 for the alphalist", () => {
  it("allows substituted filing only when withheld equals tax due for a full year with one employer", () => {
    const slips = Array.from({ length: 12 }, (_, i) => slip("E", run(`R${i}`, `2026-${String(i + 1).padStart(2, "0")}-28`), 50000, 0));
    const d = build2316(2026, emp, employer, slips);
    const under = toBir2316("E", d, emp, { formStatus: "NONE", taxWithheldJanNov: 0 });
    expect(Number(under.taxDue)).toBeGreaterThan(0);
    expect(under.substitutedFiling).toBe(false);
    d.i25a_withheldPresent = d.i24_taxDue; d.i26_totalWithheld = d.i24_taxDue;
    const ok = toBir2316("E", d, emp, { formStatus: "FINALIZED", taxWithheldJanNov: 0 });
    expect(ok.substitutedFiling).toBe(true);
    expect(scheduleOf(ok)).toBe("7.3");
    const left = toBir2316("E", d, { ...emp, separationDate: new Date("2026-08-31") }, { formStatus: "FINALIZED", taxWithheldJanNov: 0 });
    expect(left.substitutedFiling).toBe(false);
    expect(scheduleOf(left)).toBe("7.1");
    expect(scheduleOf({ ...ok, minimumWageEarner: true })).toBe("7.5");
    expect(scheduleOf({ ...ok, taxableFromPreviousEmployer: "100000.00" })).toBe("7.4");
  });
});
