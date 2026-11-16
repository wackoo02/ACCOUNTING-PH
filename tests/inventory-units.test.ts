import { describe, expect, it } from "vitest";
import { code128B } from "@/lib/inventory/barcode";
import { formatQty, fromQty, share, toQty, toUnitCost, unitCostOf, valueOf } from "@/lib/inventory/qty";

describe("quantity and cost math", () => {
  it("is exact", () => {
    expect(toQty("1.5")).toBe(15000n);
    expect(fromQty(toQty("-2.25"))).toBe("-2.25");
    expect(formatQty(toQty("12345.5"))).toBe("12,345.5");
    expect(valueOf(toQty("3"), toUnitCost("33.333333"))).toBe(10000n); // 3 x 33.333333 = 99.999999 -> 100.00
    expect(unitCostOf(230000n, toQty("20"))).toBe(toUnitCost("115"));
    expect(share(1000n, 3n, 3n)).toBe(1000n);
    expect(share(1000n, 1n, 3n)).toBe(333n);
  });
});

describe("Code 128B", () => {
  it("encodes start, data, check digit and stop", () => {
    const w = code128B("A1");
    expect(w.reduce((s, x) => s + x, 0)).toBe(11 * 5 + 2);
    // start B, then "A" (33), "1" (17), check digit (104 + 33*1 + 17*2) % 103 = 68, then stop
    expect(w.slice(0, 6).join("")).toBe("211214");
    expect(w.slice(-7).join("")).toBe("2331112");
  });
});
