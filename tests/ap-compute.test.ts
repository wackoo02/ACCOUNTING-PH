import { describe, expect, it } from "vitest";
import { bucketOf, calcLine, matchLine, netUnitCost, q4, totals } from "@/lib/ap/compute";
import { amountInWords } from "@/lib/ap/payments";

describe("AP line math", () => {
  it("VAT-inclusive line with 2% EWT on the net", () => {
    const l = calcLine({ quantity: "1", unitPrice: "11200", vatType: "VATABLE", ewtRate: "2" }, { vatInclusive: true, vendorVatRegistered: true });
    expect([l.net, l.vat, l.ewt]).toEqual([1000000n, 120000n, 20000n]);
  });
  it("VAT-exclusive, quantities with decimals", () => {
    const l = calcLine({ quantity: "2.5", unitPrice: "100", vatType: "VATABLE", ewtRate: "1.0000" }, { vatInclusive: false, vendorVatRegistered: true });
    expect([l.net, l.vat, l.ewt]).toEqual([25000n, 3000n, 250n]);
  });
  it("non-VAT supplier and exempt lines have no VAT", () => {
    expect(calcLine({ quantity: "1", unitPrice: "500" }, { vatInclusive: true, vendorVatRegistered: false }).vat).toBe(0n);
    expect(calcLine({ quantity: "1", unitPrice: "500", vatType: "EXEMPT" }, { vatInclusive: true, vendorVatRegistered: true }).vat).toBe(0n);
  });
  it("totals", () => {
    const t = totals([calcLine({ quantity: "1", unitPrice: "1120", ewtRate: "1" }, { vatInclusive: true, vendorVatRegistered: true })]);
    expect(t).toEqual({ subtotal: 100000n, vat: 12000n, total: 112000n, ewt: 1000n, netPayable: 111000n });
  });
  it("3-way match blocks over-billing and reports price variance", () => {
    const unit = netUnitCost(q4("1120"), "VATABLE", true, true);
    expect(unit).toBe(q4("1000"));
    const ok = matchLine({ lineNo: 1, billQty: q4("2"), billNet: 210000n, poNetUnit: unit, received: q4("2"), billedElsewhere: 0n, ordered: q4("5") });
    expect(ok.errors).toEqual([]);
    expect(ok.grni).toBe(200000n);
    expect(ok.variance).toBe(10000n);
    const over = matchLine({ lineNo: 1, billQty: q4("3"), billNet: 300000n, poNetUnit: unit, received: q4("2"), billedElsewhere: 0n, ordered: q4("5") });
    expect(over.errors.length).toBe(1);
  });
  it("aging buckets and amount in words", () => {
    expect([0, 1, 30, 31, 90, 121].map(bucketOf)).toEqual(["CURRENT", "D1_30", "D1_30", "D31_60", "D61_90", "OVER_120"]);
    expect(amountInWords(1234567n)).toBe("Twelve Thousand Three Hundred Forty-Five Pesos and 67/100 Only");
  });
});
