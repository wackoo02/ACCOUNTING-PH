import { describe, expect, it } from "vitest";
import { findSimilar, nameScore, nextCode, normalize, prefillFromText } from "../src/lib/masters/similar";

const vendors = [
  { id: "1", code: "V-0001", label: "ABC Office Supplies Inc.", tin: "000-123-456-00000" },
  { id: "2", code: "V-0002", label: "Mercury Drug Corporation" },
  { id: "3", code: "V-0003", label: "Manila Electric Company" },
  { id: "4", code: "V-0004", label: "Globe Telecom" },
];

describe("normalize", () => {
  it("drops suffixes, punctuation and accents", () => {
    expect(normalize("ABC Office Supplies, Inc.")).toBe("abc office supplies");
    expect(normalize("Peñafrancia Trading Corp")).toBe("penafrancia trading");
  });
});

describe("nameScore", () => {
  it("treats company suffix variations as the same", () => {
    expect(nameScore("ABC Office Supplies Corporation", "ABC Office Supplies Inc.")).toBe(1);
  });
  it("ignores word order for people", () => {
    expect(nameScore("Dela Cruz, Juan", "Juan Dela Cruz")).toBeGreaterThan(0.9);
  });
  it("catches typos", () => {
    expect(nameScore("Mercury Drgu", "Mercury Drug Corporation")).toBeGreaterThan(0.7);
  });
  it("keeps unrelated names apart", () => {
    expect(nameScore("Globe Telecom", "Mercury Drug")).toBeLessThan(0.5);
  });
});

describe("findSimilar", () => {
  it("flags a near-duplicate supplier", () => {
    const m = findSimilar({ name: "abc office supply" }, vendors);
    expect(m[0].id).toBe("1");
  });
  it("flags the same TIN even with a different name", () => {
    const m = findSimilar({ name: "Totally New Name", tin: "000123456" }, vendors);
    expect(m).toHaveLength(1);
    expect(m[0].reason).toBe("Same TIN");
  });
  it("returns nothing for a new name", () => {
    expect(findSimilar({ name: "Jollibee Foods" }, vendors)).toEqual([]);
  });
  it("matches a typed code", () => {
    expect(findSimilar({ name: "v-0004" }, vendors)[0].reason).toBe("Same code");
  });
});

describe("nextCode", () => {
  it("continues the usual pattern", () => {
    expect(nextCode(["V-0001", "V-0009", "V-0002"])).toBe("V-0010");
    expect(nextCode(["E-001", "E-002", "X"])).toBe("E-003");
    expect(nextCode([])).toBeNull();
  });
});

describe("prefillFromText", () => {
  it("splits Filipino names", () => {
    expect(prefillFromText("employees", "Juan dela Cruz")).toEqual({ firstName: "Juan", lastName: "dela Cruz" });
    expect(prefillFromText("employees", "Santos, Maria")).toEqual({ lastName: "Santos", firstName: "Maria" });
    expect(prefillFromText("employees", "Maria Clara Reyes")).toEqual({ firstName: "Maria Clara", lastName: "Reyes" });
  });
  it("puts codes in the code field", () => {
    expect(prefillFromText("currencies", "jpy")).toEqual({ code: "JPY" });
    expect(prefillFromText("accounts", "6130")).toEqual({ code: "6130" });
    expect(prefillFromText("vendors", "Jollibee")).toEqual({ name: "Jollibee" });
  });
});

describe("typeaheadScore", async () => {
  const { typeaheadScore } = await import("../src/lib/masters/similar");
  it("finds accounts despite typos", () => {
    expect(typeaheadScore("cahs bdo", "1020 Cash in Bank - BDO Current")).toBeGreaterThan(0.7);
    expect(typeaheadScore("rnet exp", "6030 Rent Expense")).toBeGreaterThan(0.7);
    expect(typeaheadScore("payroll", "6030 Rent Expense")).toBeLessThan(0.7);
  });
});
