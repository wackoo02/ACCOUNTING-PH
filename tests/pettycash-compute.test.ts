import { describe, expect, it } from "vitest";
import { buildReplenishmentLines, computeVoucher, suggestAccountCode, type AccountInfo } from "@/lib/pettycash/compute";

const accounts = new Map<string, AccountInfo>([
  ["meals", { id: "meals", code: "6120", name: "Meals and Allowances", type: "EXPENSE", ifrsGroup: "Operating expenses" }],
  ["supplies", { id: "supplies", code: "6060", name: "Office Supplies", type: "EXPENSE", ifrsGroup: "Operating expenses" }],
  ["equip", { id: "equip", code: "1530", name: "Office Equipment", type: "ASSET", ifrsGroup: "Property, plant and equipment" }],
  ["cash", { id: "cash", code: "1010", name: "Cash in Bank", type: "ASSET", ifrsGroup: "Cash and cash equivalents" }],
]);
const base = { vendorVatRegistered: true, fixedAssetThreshold: "5000", accounts };

describe("computeVoucher", () => {
  it("splits 12% VAT out of VAT-inclusive prices and adds a handwritten tip", () => {
    const c = computeVoucher({ ...base, lines: [{ description: "Lunch meeting", quantity: 2, unitPrice: "560.00", accountId: "meals" }], tipAmount: "100" });
    expect(c.ok).toBe(true);
    expect(c.gross).toBe(112000n);
    expect(c.vat).toBe(12000n);
    expect(c.netOfVat).toBe(100000n);
    expect(c.totalPaid).toBe(122000n);
  });

  it("withholds EWT on the amount net of VAT and reduces the cash paid", () => {
    const c = computeVoucher({ ...base, lines: [{ description: "Bond paper", unitPrice: "1120", accountId: "supplies" }], ewtRate: "1" });
    expect(c.ewt).toBe(1000n); // 1% of 1,000.00
    expect(c.totalPaid).toBe(111000n);
  });

  it("allows no input VAT from a non-VAT supplier", () => {
    const c = computeVoucher({ ...base, vendorVatRegistered: false, vatAmount: "12", lines: [{ description: "Snacks", unitPrice: "112", accountId: "meals" }] });
    expect(c.ok).toBe(false);
    expect(c.errors.join()).toMatch(/non-VAT/);
    const ok = computeVoucher({ ...base, vendorVatRegistered: false, lines: [{ description: "Snacks", unitPrice: "112", accountId: "meals" }] });
    expect(ok.vat).toBe(0n);
    expect(ok.totalPaid).toBe(11200n);
  });

  it("requires an approved PO and an asset account at or above the threshold", () => {
    const line = { description: "Laptop", unitPrice: "56000", isFixedAsset: true };
    expect(computeVoucher({ ...base, lines: [{ ...line, accountId: "supplies" }] }).errors.join()).toMatch(/property and equipment account/);
    expect(computeVoucher({ ...base, lines: [{ ...line, accountId: "equip" }] }).errors.join()).toMatch(/approved PO/);
    expect(computeVoucher({ ...base, lines: [{ ...line, accountId: "equip" }], purchaseOrder: { status: "DRAFT", amount: "60000" } }).errors.join()).toMatch(/not approved/);
    expect(computeVoucher({ ...base, lines: [{ ...line, accountId: "equip" }], purchaseOrder: { status: "APPROVED", amount: "40000" } }).errors.join()).toMatch(/more than the approved PO/);
    const ok = computeVoucher({ ...base, lines: [{ ...line, accountId: "equip" }], purchaseOrder: { status: "APPROVED", amount: "56000" } });
    expect(ok.ok).toBe(true);
    expect(ok.capitalAmount).toBe(5000000n);
  });

  it("expenses equipment below the threshold", () => {
    const c = computeVoucher({ ...base, lines: [{ description: "Mouse", unitPrice: "800", isFixedAsset: true, accountId: "equip" }] });
    expect(c.errors.join()).toMatch(/below the fixed asset threshold/);
    const w = computeVoucher({ ...base, lines: [{ description: "Mouse", unitPrice: "800", isFixedAsset: true, accountId: "supplies" }] });
    expect(w.ok).toBe(true);
    expect(w.warnings.join()).toMatch(/expensed/);
  });

  it("rejects accounts that are not expenses or fixed assets", () => {
    expect(computeVoucher({ ...base, lines: [{ description: "x", unitPrice: "10", accountId: "cash" }] }).ok).toBe(false);
  });
});

describe("buildReplenishmentLines", () => {
  it("balances: expenses + tip + input VAT = EWT + cash replenished", () => {
    const lines = buildReplenishmentLines([
      { id: "a", number: "PCV-1", vendorName: "Cafe", vendorId: null, docType: "OR", docNumber: "123", vat: 12000n, ewt: 0n, tip: 10000n, totalPaid: 122000n, ewtAccountId: null, dims: {}, lines: [{ accountId: "meals", description: "Lunch", net: 100000n }] },
      { id: "b", number: "PCV-2", vendorName: "Store", vendorId: "v1", docType: "SI", docNumber: null, vat: 12000n, ewt: 1000n, tip: 0n, totalPaid: 111000n, ewtAccountId: "ewt", dims: {}, lines: [{ accountId: "supplies", description: "Paper", net: 100000n }] },
    ], "vat", "fund");
    const dr = lines.reduce((s, l) => s + Number(l.debit), 0), cr = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(dr).toBeCloseTo(cr, 2);
    expect(lines.at(-1)).toMatchObject({ accountId: "fund", credit: "2330.00" });
  });
});

describe("suggestAccountCode", () => {
  it("maps common Philippine receipt items", () => {
    expect(suggestAccountCode("Diesel 20L Petron")).toBe("6110");
    expect(suggestAccountCode("Grab ride to client")).toBe("6050");
    expect(suggestAccountCode("LBC padala")).toBe("6052");
    expect(suggestAccountCode("Meralco bill")).toBe("6040");
    expect(suggestAccountCode("Jollibee lunch")).toBe("6120");
    expect(suggestAccountCode("Bond paper A4")).toBe("6060");
    expect(suggestAccountCode("Laptop Lenovo")).toBe("1530");
    expect(suggestAccountCode("zzz")).toBeNull();
  });
});
