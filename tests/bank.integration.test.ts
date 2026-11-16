// Cash management and bank reconciliation against the real database in DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { recordJournal, voidOrReverse } from "@/lib/ledger/service";
import { importMasters } from "@/lib/masters/store";
import { approveCash, bookBalance, rejectCash, replenishPettyCash, saveCashTransaction, submitCash, unreplenished, voidCash } from "@/lib/bank/cash";
import {
  clearWithoutStatement, confirmMatches, finalizeStatement, importStatement, postAdjustments, reconciliation, reopenStatement, statementTemplate,
  suggestedAccountId, unmatch, workbench,
} from "@/lib/bank/recon";

let org = "", owner = "", clerk = "", accountant = "";
let bdo = "", pcf = "", usd = "";
const Y = 2026;
const d = (s: string) => new Date(`${Y}-${s}`);
const acct = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
const bankId = async (code: string) => (await prisma.bankAccount.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;

async function statement(rows: (string | number | null)[][]) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await statementTemplate()) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Statement")!;
  rows.forEach((r, i) => { ws.getRow(i + 2).values = r; });
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; clerk = (await mk("clerk")).id; accountant = (await mk("accountant")).id;
  org = (await provisionOrganization({ name: "Bank Test Co", ownerUserId: owner })).id;
  await prisma.membership.createMany({ data: [
    { userId: clerk, organizationId: org, role: "BOOKKEEPER" },
    { userId: accountant, organizationId: org, role: "ACCOUNTANT", approvalLimit: "500000" },
  ] });
  await importMasters("currencies", org, owner, [{ code: "USD", name: "US Dollar", rateToBase: "58" }]);
  await importMasters("accounts", org, owner, [{ code: "1027", name: "Cash in Bank - USD", type: "ASSET", ifrsGroup: "Cash and cash equivalents", isCurrent: true, parentCode: "1000", currencyCode: "USD" }]);
  await importMasters("banks", org, owner, [
    { code: "BDO-CA", name: "BDO Current", kind: "CURRENT", glAccountCode: "1020", bankName: "BDO", accountNumber: "001-234", nextCheckNo: 1001 },
    { code: "PCF", name: "Petty Cash - Admin", kind: "PETTY_CASH", glAccountCode: "1015", custodian: "Maria", fundLimit: "10000" },
    { code: "BPI-USD", name: "BPI Dollar Savings", kind: "SAVINGS", glAccountCode: "1027" },
  ]);
  bdo = await bankId("BDO-CA"); pcf = await bankId("PCF"); usd = await bankId("BPI-USD");
  await recordJournal({ organizationId: org, userId: owner, date: d("09-30"), memo: "Opening balance", source: "OPENING_BALANCE", action: "post",
    lines: [{ accountId: await acct("1020"), debit: "1000000" }, { accountId: await acct("3010"), credit: "1000000" }] });
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { organizationId: org } });
  await prisma.journalEntry.updateMany({ where: { organizationId: org }, data: { reversalOfId: null } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: org } });
  await prisma.bankStatement.deleteMany({ where: { organizationId: org } });
  await prisma.bankMatch.deleteMany({ where: { organizationId: org } });
  await prisma.cashTransaction.deleteMany({ where: { organizationId: org } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: org } });
  await prisma.account.updateMany({ where: { organizationId: org }, data: { parentId: null } });
  await prisma.taxCode.deleteMany({ where: { organizationId: org } });
  await prisma.organization.deleteMany({ where: { id: org } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, clerk, accountant] } } });
  await prisma.$disconnect();
});

describe("bank and cash accounts", () => {
  it("links each to its own GL cash account in the same currency", async () => {
    await expect(importMasters("banks", org, owner, [{ code: "DUP", name: "Dup", kind: "SAVINGS", glAccountCode: "1020" }])).rejects.toThrow(/already used by BDO-CA/);
    await expect(importMasters("banks", org, owner, [{ code: "X", name: "X", kind: "SAVINGS", glAccountCode: "1025", currencyCode: "USD" }])).rejects.toThrow(/does not match/);
    expect((await prisma.bankAccount.findUniqueOrThrow({ where: { id: usd } })).currencyCode).toBe("USD");
  });
});

describe("cash vouchers", () => {
  it("receipt with creditable withholding goes through approval and posts to the GL", async () => {
    const r = await saveCashTransaction({ organizationId: org, userId: clerk, type: "RECEIPT", bankAccountId: bdo, date: d("10-03"), payee: "XYZ Trading", partyType: "CUSTOMER", partyId: "C-0001",
      method: "CHECK", checkNo: "778899", memo: "Collection of SI 0001", reference: "OR 0001",
      withholdingTaxCodeId: (await prisma.taxCode.findFirstOrThrow({ where: { organizationId: org, code: "WC160" } })).id, withholdingAmount: "2000",
      lines: [{ accountId: await acct("1100"), amount: "112000" }], action: "submit" });
    expect(r.number).toBe(`CR-${Y}-000001`);
    expect(r.amount.toString()).toBe("110000");
    await expect(approveCash(org, clerk, r.id)).rejects.toThrow(/rights to approve/);
    await approveCash(org, accountant, r.id);
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { organizationId: org, source: "BANK", sourceId: r.id }, include: { lines: { include: { account: true } } } });
    const by = (code: string) => e.lines.find((l) => l.account.code === code)!;
    expect(by("1020").debit.toString()).toBe("110000");
    expect(by("1320").debit.toString()).toBe("2000");
    expect(by("1100").credit.toString()).toBe("112000");
    expect(by("1100").partyId).toBe("C-0001");
  });

  it("check disbursement auto-numbers the check and computes EWT; return and resubmit", async () => {
    const wc100 = (await prisma.taxCode.findFirstOrThrow({ where: { organizationId: org, code: "WC100" } })).id;
    const t = await saveCashTransaction({ organizationId: org, userId: clerk, type: "DISBURSEMENT", bankAccountId: bdo, date: d("10-05"), payee: "ABC Realty", partyType: "VENDOR", partyId: "V-1",
      method: "CHECK", memo: "October rent", withholdingTaxCodeId: wc100, lines: [{ accountId: await acct("6030"), amount: "50000" }], action: "submit" });
    expect(t.checkNo).toBe("001001");
    expect(t.withholdingAmount.toString()).toBe("2500");
    expect(t.amount.toString()).toBe("47500");
    await rejectCash(org, accountant, t.id, "Attach the lease");
    await submitCash(org, clerk, t.id);
    await approveCash(org, accountant, t.id);
    await expect(saveCashTransaction({ organizationId: org, userId: clerk, type: "DISBURSEMENT", bankAccountId: bdo, date: d("10-06"), payee: "Dup", method: "CHECK", checkNo: "1001", memo: "dup",
      lines: [{ accountId: await acct("6060"), amount: "1" }] })).rejects.toThrow(/already used/);
    // A second check that will still be outstanding at month-end.
    const c2 = await saveCashTransaction({ organizationId: org, userId: clerk, type: "DISBURSEMENT", bankAccountId: bdo, date: d("10-28"), payee: "Office Depot", method: "CHECK", memo: "Supplies",
      lines: [{ accountId: await acct("6060"), amount: "20000" }], action: "submit" });
    expect(c2.checkNo).toBe("001002");
    await approveCash(org, accountant, c2.id);
    // Users cannot reverse a cash voucher's journal directly.
    const posted = await prisma.cashTransaction.findUniqueOrThrow({ where: { id: c2.id } });
    await expect(voidOrReverse(org, owner, posted.journalEntryId!)).rejects.toThrow(/Void the cash voucher/);
  });

  it("petty cash: fund, spend within balance, replenish", async () => {
    const fund = await saveCashTransaction({ organizationId: org, userId: clerk, type: "TRANSFER", bankAccountId: bdo, toBankAccountId: pcf, date: d("10-10"), method: "BANK_TRANSFER",
      amount: "10000", memo: "Establish petty cash fund", action: "submit" });
    expect(fund.number).toBe(`FT-${Y}-000001`);
    await approveCash(org, accountant, fund.id);
    const big = await saveCashTransaction({ organizationId: org, userId: clerk, type: "DISBURSEMENT", bankAccountId: pcf, date: d("10-12"), payee: "Grab", memo: "Too much",
      lines: [{ accountId: await acct("6050"), amount: "15000" }], action: "submit" });
    await expect(approveCash(org, accountant, big.id)).rejects.toThrow(/only has 10,000.00/);
    await voidCash(org, accountant, big.id, "Wrong amount");
    const p1 = await saveCashTransaction({ organizationId: org, userId: clerk, type: "DISBURSEMENT", bankAccountId: pcf, date: d("10-12"), payee: "Grab", memo: "Client visit",
      lines: [{ accountId: await acct("6050"), amount: "1200" }], action: "submit" });
    const p2 = await saveCashTransaction({ organizationId: org, userId: clerk, type: "DISBURSEMENT", bankAccountId: pcf, date: d("10-13"), payee: "Lalamove", memo: "Delivery",
      lines: [{ accountId: await acct("6052"), amount: "300" }], action: "submit" });
    expect(p1.number).toMatch(/^PCV-/);
    await approveCash(org, accountant, p1.id); await approveCash(org, accountant, p2.id);
    expect(await bookBalance(org, await acct("1015"))).toBe(850000n);
    const rep = await replenishPettyCash({ organizationId: org, userId: clerk, fundId: pcf, fromBankAccountId: bdo, date: d("10-15"), method: "BANK_TRANSFER", action: "submit" });
    expect(rep.amount.toString()).toBe("1500");
    await expect(voidCash(org, accountant, p1.id, "x")).rejects.toThrow(/already replenished/);
    await approveCash(org, accountant, rep.id);
    expect(await bookBalance(org, await acct("1015"))).toBe(1000000n);
    expect(await unreplenished(org, pcf)).toHaveLength(0);
  });

  it("foreign-currency transfer books the realized FX difference", async () => {
    const t = await saveCashTransaction({ organizationId: org, userId: clerk, type: "TRANSFER", bankAccountId: bdo, toBankAccountId: usd, date: d("10-20"), method: "BANK_TRANSFER",
      amount: "58000", toAmount: "1000", toFxRate: "58.50", memo: "Buy USD", action: "submit" });
    await approveCash(org, accountant, t.id);
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { sourceId: t.id }, include: { lines: { include: { account: true } } } });
    expect(e.lines.find((l) => l.account.code === "1027")!.fxDebit.toString()).toBe("1000");
    expect(e.lines.find((l) => l.account.systemRole === "FX_GAIN")!.credit.toString()).toBe("500");
    expect(await bookBalance(org, await acct("1027"))).toBe(100000n);
  });

  it("a receipt at month-end that the bank has not credited yet", async () => {
    const r = await saveCashTransaction({ organizationId: org, userId: clerk, type: "RECEIPT", bankAccountId: bdo, date: d("10-31"), payee: "Walk-in", memo: "Cash sale deposited",
      lines: [{ accountId: await acct("4010"), amount: "5000" }], action: "submit" });
    await approveCash(org, accountant, r.id);
  });
});

describe("bank reconciliation", () => {
  const rows = [
    ["2026-10-04", "CHECK DEPOSIT", "DEP-1", "", "", 110000, 1110000],
    ["10/09/2026", "CHECK ENCASHMENT", "", "001001", 47500, "", 1062500],
    ["2026-10-10", "ONLINE TRANSFER", "IB-555", "", 10000, "", 1052500],
    ["2026-10-15", "ONLINE TRANSFER", "IB-556", "", 1500, "", 1051000],
    ["2026-10-20", "FX PURCHASE", "FX-1", "", 58000, "", 993000],
    ["2026-10-31", "SERVICE CHARGE", "", "", 250, "", 992750],
    ["2026-10-31", "INTEREST EARNED", "", "", "", 100, 992850],
    ["2026-10-31", "W/TAX ON INTEREST", "", "", 20, "", 992830],
  ];

  it("rejects a statement that does not add up", async () => {
    const bad = await statement([["2026-10-04", "DEPOSIT", "", "", "", 100, ""]]);
    await expect(importStatement({ organizationId: org, userId: clerk, bankAccountId: bdo, buf: bad, openingBalance: "1000000", closingBalance: "999" })).rejects.toThrow(/does not add up/);
  });

  it("uploads the statement, suggests matches, clears and reconciles to zero", async () => {
    const buf = await statement(rows);
    const up = await importStatement({ organizationId: org, userId: clerk, bankAccountId: bdo, buf, fileName: "oct.xlsx" });
    expect(up.imported).toBe(8);
    expect(up.statement.openingBalance.toString()).toBe("1000000");
    await expect(importStatement({ organizationId: org, userId: clerk, bankAccountId: bdo, buf })).rejects.toThrow(/already uploaded/);

    const wb1 = await workbench(org, bdo);
    // The opening balance never appears on a statement: clear it without one.
    const opening = wb1.bookRows.find((b) => b.source === "OPENING_BALANCE")!;
    await clearWithoutStatement(org, clerk, bdo, [opening.id], "Opening balance per September reconciliation");

    const wb = await workbench(org, bdo);
    const s = wb.suggestions;
    const chk = s.find((x) => x.reason.startsWith("Check no. 1001"))!;
    expect(chk.confidence).toBe("high");
    expect(s.length).toBe(5); // deposit, check, two transfers and the FX purchase
    await confirmMatches(org, clerk, bdo, s.map((x) => ({ bankIds: x.bankIds, bookIds: x.bookIds })), "SUGGESTED");

    const left = await workbench(org, bdo);
    expect(left.bankRows).toHaveLength(3);
    const items = await Promise.all(left.bankRows.map(async (b) => ({ bankLineId: b.id, accountId: (await suggestedAccountId(org, b.suggestion))! })));
    expect(items.every((i) => i.accountId)).toBe(true);
    await postAdjustments(org, accountant, bdo, items);

    const r = await reconciliation(org, up.statement.id);
    expect(r.perBank).toBe(99283000n);
    expect(r.totals.oc).toBe(2000000n);   // check 001002 outstanding
    expect(r.totals.dit).toBe(500000n);   // 10-31 receipt in transit
    expect(r.difference).toBe(0n);
    expect(r.outstandingChecks[0].checkNo).toBe("001002");

    await finalizeStatement(org, accountant, up.statement.id);
    const m = (await workbench(org, bdo)).recent.find((x) => x.method === "SUGGESTED")!;
    await expect(unmatch(org, clerk, m.id)).rejects.toThrow(/finalized/);
    const rent = await prisma.cashTransaction.findFirstOrThrow({ where: { organizationId: org, checkNo: "001001" } });
    await expect(voidCash(org, accountant, rent.id, "x", d("11-02"))).rejects.toThrow(/already cleared/);
    const c2 = await prisma.cashTransaction.findFirstOrThrow({ where: { organizationId: org, checkNo: "001002" } });
    await expect(voidCash(org, accountant, c2.id, "Lost check")).rejects.toThrow(/finalized/);
    await voidCash(org, accountant, c2.id, "Lost check", d("11-05"));
    // The finalized October reconciliation is unchanged; the check stays outstanding as of Oct 31.
    const again = await reconciliation(org, up.statement.id);
    expect(again.totals.oc).toBe(2000000n);
    expect(again.difference).toBe(0n);
    expect((await workbench(org, bdo)).bookRows.find((b) => b.amount === -2000000n)).toBeUndefined();

    await reopenStatement(org, owner, up.statement.id);
    const adj = (await workbench(org, bdo)).recent.find((x) => x.method === "ADJUSTMENT")!;
    await unmatch(org, accountant, adj.id); // reverses the adjustment entry too
    expect((await workbench(org, bdo)).bankRows).toHaveLength(1);
  });
});
