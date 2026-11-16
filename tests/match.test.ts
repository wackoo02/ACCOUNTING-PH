import { describe, expect, it } from "vitest";
import { guessAdjustment, normCheck, suggestMatches } from "@/lib/bank/match";

const d = (s: string) => new Date(`2026-${s}T00:00:00Z`);

describe("suggested bank matches", () => {
  it("prefers check number, then reference, then nearest date", () => {
    const s = suggestMatches(
      [
        { id: "b1", date: d("10-09"), amount: -47500n, checkNo: "001001" },
        { id: "b2", date: d("10-05"), amount: 1000n, reference: "OR-5521" },
        { id: "b3", date: d("10-06"), amount: 1000n },
      ],
      [
        { id: "k0", date: d("10-01"), amount: -47500n, checkNo: "1002" },
        { id: "k1", date: d("10-01"), amount: -47500n, checkNo: "1001" },
        { id: "k2", date: d("10-06"), amount: 1000n },
        { id: "k3", date: d("10-04"), amount: 1000n, reference: "OR-5521" },
      ],
    );
    expect(s.find((x) => x.bankIds[0] === "b1")).toMatchObject({ bookIds: ["k1"], confidence: "high" });
    expect(s.find((x) => x.bankIds[0] === "b2")!.bookIds).toEqual(["k3"]);
    expect(s.find((x) => x.bankIds[0] === "b3")!.bookIds).toEqual(["k2"]);
  });

  it("never pairs different check numbers, and suggests batched deposits", () => {
    const s = suggestMatches(
      [{ id: "b1", date: d("10-09"), amount: -500n, checkNo: "9" }, { id: "b2", date: d("10-03"), amount: 3000n }],
      [{ id: "k1", date: d("10-01"), amount: -500n, checkNo: "8" }, { id: "k2", date: d("10-02"), amount: 1000n }, { id: "k3", date: d("10-02"), amount: 2000n }],
    );
    expect(s.find((x) => x.bankIds[0] === "b1")).toBeUndefined();
    expect(s.find((x) => x.bankIds[0] === "b2")!.bookIds.sort()).toEqual(["k2", "k3"]);
  });

  it("guesses accounts for bank-initiated items", () => {
    expect(guessAdjustment("SERVICE CHARGE", -25000n).role).toBe("BANK_CHARGES");
    expect(guessAdjustment("INTEREST EARNED", 100n).code).toBe("7010");
    expect(guessAdjustment("W/TAX ON INTEREST", -20n).code).toBe("7540");
    expect(guessAdjustment("RETURNED CHECK DAIF", -500000n).role).toBe("AR_CONTROL");
    expect(normCheck("Chk #000123")).toBe("123");
  });
});
