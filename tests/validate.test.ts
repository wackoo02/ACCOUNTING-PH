import { describe, expect, it } from "vitest";
import { validateLines } from "@/lib/ledger/validate";
import { toCentavos, fromCentavos, formatPeso } from "@/lib/money";

describe("money", () => {
  it("parses and formats without float errors", () => {
    expect(toCentavos("0.1") + toCentavos("0.2")).toBe(30n);
    expect(toCentavos("1,234.5")).toBe(123450n);
    expect(fromCentavos(123450n)).toBe("1234.50");
    expect(formatPeso(-123456789n)).toBe("(1,234,567.89)");
    expect(() => toCentavos("1.234")).toThrow();
  });
});

describe("validateLines", () => {
  it("accepts a balanced entry", () => {
    const r = validateLines([{ accountId: "a", debit: "1000" }, { accountId: "b", credit: "1000.00" }]);
    expect(r.ok).toBe(true);
  });
  it("rejects unbalanced entries", () => {
    const r = validateLines([{ accountId: "a", debit: "1000" }, { accountId: "b", credit: "999.99" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/must be equal/);
  });
  it("rejects a line with both debit and credit, negatives, and single lines", () => {
    expect(validateLines([{ accountId: "a", debit: "1", credit: "1" }, { accountId: "b" }]).ok).toBe(false);
    expect(validateLines([{ accountId: "a", debit: "-5" }, { accountId: "b", credit: "-5" }]).ok).toBe(false);
    expect(validateLines([{ accountId: "a", debit: "5" }]).ok).toBe(false);
  });
  it("ignores blank rows", () => {
    const r = validateLines([{ accountId: "a", debit: "5" }, { accountId: "", debit: "", credit: "" }, { accountId: "b", credit: "5" }]);
    expect(r.ok).toBe(true);
  });
});
