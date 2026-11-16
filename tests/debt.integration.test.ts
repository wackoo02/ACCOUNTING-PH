// Debt module against the real database in DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { recordJournal, voidOrReverse } from "@/lib/ledger/service";
import { importMasters } from "@/lib/masters/store";
import { approveCash, voidCash } from "@/lib/bank/cash";
import { toCentavos } from "@/lib/money";
import {
  accrueInterest, amortizationTable, loanBalances, createLoanPayment, debtAging, debtSchedule, evaluateCovenants, modifyLoan, paymentDue, previewModification,
  reclassify, recordDrawdown, reverseLoanTransaction, runPeriodEnd, saveCovenant, saveLoan, syncLoanPayments,
} from "@/lib/debt/service";

let org = "", owner = "", clerk = "", accountant = "", bdo = "", loanId = "";
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const acct = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
const glBal = async (code: string) => {
  const a = await prisma.journalLine.aggregate({ where: { organizationId: org, accountId: await acct(code), journalEntry: { status: "POSTED" } }, _sum: { debit: true, credit: true } });
  return toCentavos(a._sum.credit?.toString() ?? "0") - toCentavos(a._sum.debit?.toString() ?? "0"); // credit positive
};
const bal = async () => {
  const { balances } = await loanBalances(org);
  return balances.get(loanId)!;
};
const tiedOut = async (asOf = "2099-12-31") => (await debtSchedule(org, day(asOf))).tieOut.every((t) => t.difference === 0n);

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; clerk = (await mk("clerk")).id; accountant = (await mk("accountant")).id;
  org = (await provisionOrganization({ name: "Debt Test Co", ownerUserId: owner })).id;
  await prisma.membership.createMany({ data: [
    { userId: clerk, organizationId: org, role: "BOOKKEEPER" },
    { userId: accountant, organizationId: org, role: "ACCOUNTANT" },
  ] });
  await importMasters("vendors", org, owner, [{ code: "V-BDO", name: "BDO Unibank" }]);
  await importMasters("banks", org, owner, [{ code: "BDO-CA", name: "BDO Current", kind: "CURRENT", glAccountCode: "1020", nextCheckNo: 5001 }]);
  bdo = (await prisma.bankAccount.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code: "BDO-CA" } } })).id;
  await recordJournal({ organizationId: org, userId: owner, date: day("2025-12-31"), memo: "Opening balance", source: "OPENING_BALANCE", action: "post",
    lines: [{ accountId: await acct("1020"), debit: "3000000" }, { accountId: await acct("3010"), credit: "3000000" }] });
});

afterAll(async () => {
  await prisma.loan.deleteMany({ where: { organizationId: org } });
  await prisma.journalLine.deleteMany({ where: { organizationId: org } });
  await prisma.journalEntry.updateMany({ where: { organizationId: org }, data: { reversalOfId: null } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: org } });
  await prisma.cashTransaction.deleteMany({ where: { organizationId: org } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: org } });
  await prisma.account.updateMany({ where: { organizationId: org }, data: { parentId: null } });
  await prisma.taxCode.deleteMany({ where: { organizationId: org } });
  await prisma.organization.deleteMany({ where: { id: org } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, clerk, accountant] } } });
  await prisma.$disconnect();
});

describe("debt", () => {
  it("validates and saves the loan master", async () => {
    const base = {
      organizationId: org, userId: owner, number: "LN-001", lender: "BDO Unibank", lenderVendorCode: "V-BDO", loanType: "TERM_LOAN",
      originalPrincipal: "1200000", interestRate: "8", dayCount: "30_360", startDate: day("2026-01-01"), maturityDate: day("2028-01-01"),
      paymentFrequency: "MONTHLY", repaymentType: "ANNUITY", stAccountId: await acct("2095"), ltAccountId: await acct("2510"),
      interestExpenseAccountId: await acct("7510"), interestPayableAccountId: await acct("2020"), bankAccountId: bdo,
    };
    await expect(saveLoan({ ...base, stAccountId: await acct("2510") })).rejects.toThrow(/non-current account/);
    await expect(saveLoan({ ...base, maturityDate: day("2025-01-01") })).rejects.toThrow(/maturity date must be after/);
    loanId = (await saveLoan(base)).id;
    await expect(saveLoan(base)).rejects.toThrow(/already exists/);
  });

  it("posts a drawdown net of transaction costs and splits current / non-current", async () => {
    await recordDrawdown({ organizationId: org, userId: owner, loanId, date: day("2026-01-01"), amount: "1200000", fees: "24000" });
    const b = await bal();
    expect(b.principal).toBe(120000000n);
    expect(b.unamortized).toBe(2400000n);
    const sched = await prisma.loanScheduleLine.findMany({ where: { loanId }, orderBy: { dueDate: "asc" } });
    expect(sched).toHaveLength(24);
    const dueIn12 = sched.filter((r) => r.dueDate <= day("2027-01-01")).reduce((s, r) => s + toCentavos(r.principal.toString()), 0n);
    expect(b.current).toBe(dueIn12);
    expect(await glBal("2095")).toBe(dueIn12);
    expect(await glBal("2510")).toBe(120000000n - dueIn12 - 2400000n); // costs sit in the non-current account (net presentation)
    expect(-(await glBal("1020"))).toBe(300000000n + 117600000n);
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(Number(loan.effectiveRate)).toBeGreaterThan(8);
    expect(await tiedOut()).toBe(true);
    await expect(saveLoan({
      organizationId: org, userId: owner, number: "LN-001", lender: "BDO", loanType: "TERM_LOAN", originalPrincipal: "1500000", interestRate: "8", dayCount: "30_360",
      startDate: day("2026-01-01"), maturityDate: day("2028-01-01"), paymentFrequency: "MONTHLY", repaymentType: "ANNUITY", stAccountId: await acct("2095"),
      ltAccountId: await acct("2510"), interestExpenseAccountId: await acct("7510"), interestPayableAccountId: await acct("2020"),
    }, loanId)).rejects.toThrow(/Modify terms/);
    await expect(recordDrawdown({ organizationId: org, userId: owner, loanId, date: day("2026-01-02"), amount: "1" })).rejects.toThrow(/exceed the loan amount/);
  });

  it("accrues interest at the effective rate and amortizes the costs", async () => {
    await accrueInterest(org, owner, loanId, day("2026-01-31"));
    const t = await prisma.loanTransaction.findFirstOrThrow({ where: { loanId, type: "ACCRUAL" } });
    const nominal = toCentavos(t.accruedChange.toString()), expense = toCentavos(t.interestExpense.toString());
    expect(nominal).toBeGreaterThan(0n);
    expect(expense).toBeGreaterThan(nominal);
    expect(toCentavos(t.costChange.toString())).toBe(nominal - expense);
    expect(-(await glBal("7510"))).toBe(expense);
    await expect(accrueInterest(org, owner, loanId, day("2026-01-15"))).rejects.toThrow(/already accrued/);
    expect(await tiedOut()).toBe(true);
  });

  it("pays an installment through a cash disbursement voucher that needs approval", async () => {
    const due = await paymentDue(org, loanId, day("2026-02-01"));
    const row1 = await prisma.loanScheduleLine.findFirstOrThrow({ where: { loanId }, orderBy: { dueDate: "asc" } });
    expect(due.principal).toBe(toCentavos(row1.principal.toString()));
    expect(due.interest).toBe(toCentavos(row1.interest.toString())); // 30/360: one month = 8,000.00
    expect(due.interest).toBe(800000n);
    const v = await createLoanPayment({ organizationId: org, userId: clerk, loanId, date: day("2026-02-01"), principal: "96386.11", interest: "8000", action: "submit" });
    expect(v.status).toBe("PENDING_APPROVAL");
    expect((await bal()).principal).toBe(120000000n); // not yet posted
    await approveCash(org, accountant, v.id);
    await syncLoanPayments(org);
    const b = await bal();
    expect(b.principal).toBe(120000000n - 9638611n);
    expect(b.accrued).toBe(0n);
    expect(await tiedOut()).toBe(true);
    const tbl = await amortizationTable(org, loanId, day("2026-02-01"));
    expect(tbl.rows[0].status).toBe("PAID");
    expect(tbl.rows[1].status).toBe("UPCOMING");
  });

  it("voiding the voucher voids the loan payment", async () => {
    const v = await createLoanPayment({ organizationId: org, userId: clerk, loanId, date: day("2026-03-01"), principal: "97028.68", interest: "7357.43", action: "submit" });
    await approveCash(org, accountant, v.id);
    await syncLoanPayments(org);
    expect((await bal()).principal).toBe(120000000n - 9638611n - 9702868n);
    await voidCash(org, accountant, v.id, "Wrong date");
    await syncLoanPayments(org);
    expect((await bal()).principal).toBe(120000000n - 9638611n);
    expect(await tiedOut()).toBe(true);
    const aging = await debtAging(org, day("2026-04-15"));
    const row = aging.find((a) => a.loan.id === loanId)!;
    expect(row.overdue[1]).toBeGreaterThan(0n); // March installment 45 days past due
    expect(row.overdue[0]).toBeGreaterThan(0n); // April installment 14 days past due
  });

  it("does not let journal screens reverse debt entries", async () => {
    const t = await prisma.loanTransaction.findFirstOrThrow({ where: { loanId, type: "ACCRUAL" } });
    await expect(voidOrReverse(org, owner, t.journalEntryId!)).rejects.toThrow(/Debt module/);
  });

  it("period-end accrues interest and reclassifies; a covenant breach makes the loan current", async () => {
    const r = await runPeriodEnd(org, accountant, day("2026-06-30"));
    expect(r.accrued).toBe(1);
    const b = await bal();
    const sched = await prisma.loanScheduleLine.findMany({ where: { loanId, dueDate: { gt: day("2027-06-30") } } });
    expect(b.nonCurrent).toBe(sched.reduce((s, x) => s + toCentavos(x.principal.toString()), 0n));
    expect(await tiedOut("2026-06-30")).toBe(true);

    await saveCovenant({ organizationId: org, userId: owner, loanId, name: "Current ratio at least 50x", metric: "CURRENT_RATIO", operator: "MIN", threshold: "50" });
    const ev = await evaluateCovenants(org, day("2026-06-30"));
    expect(ev[0].status).toBe("BREACH");
    expect(ev[0].classifyCurrent).toBe(true);
    const preview = await reclassify(org, owner, day("2026-06-30"), false);
    expect(preview[0].target).toBe(b.principal);
    await reclassify(org, owner, day("2026-06-30"), true);
    expect((await bal()).nonCurrent).toBe(0n);

    const cv = await prisma.loanCovenant.findFirstOrThrow({ where: { loanId } });
    await saveCovenant({ organizationId: org, userId: owner, loanId, name: cv.name, metric: "CURRENT_RATIO", operator: "MIN", threshold: "50", waiverUntil: day("2027-12-31") }, cv.id);
    const ev2 = await evaluateCovenants(org, day("2026-06-30"));
    expect(ev2[0].status).toBe("WAIVED");
    expect(ev2[0].classifyCurrent).toBe(false);
    // undo the breach reclassification (latest transaction)
    const last = await prisma.loanTransaction.findFirstOrThrow({ where: { loanId, type: "RECLASS", status: "POSTED" }, orderBy: { createdAt: "desc" } });
    await reverseLoanTransaction(org, owner, loanId, last.id);
    expect((await bal()).nonCurrent).toBe(b.nonCurrent);
    expect(await tiedOut()).toBe(true);
  });

  it("non-substantial modification: rate cut adjusts carrying amount with a gain (PFRS 9 5.4.3)", async () => {
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    const input = {
      organizationId: org, userId: owner, loanId, date: day("2026-07-01"), kind: "TERMS" as const, interestRate: "7.5", maturityDate: loan.maturityDate,
      paymentFrequency: "MONTHLY", repaymentType: "ANNUITY", reason: "Rate reduction letter",
    };
    const p = await previewModification(input);
    expect(p.substantial).toBe(false);
    expect(p.gainLossAmt).toBeLessThan(0n); // lower rate -> lower PV -> gain
    await modifyLoan(input);
    const t = await prisma.loanTransaction.findFirstOrThrow({ where: { loanId, type: "MODIFICATION" } });
    expect(toCentavos(t.interestExpense.toString())).toBeLessThan(0n);
    expect(Number((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).interestRate)).toBe(7.5);
    expect(await tiedOut()).toBe(true);
  });

  it("substantial modification derecognizes the old loan: unamortized costs go to profit or loss", async () => {
    const before = await bal();
    expect(before.unamortized).not.toBe(0n);
    await modifyLoan({
      organizationId: org, userId: owner, loanId, date: day("2026-08-01"), kind: "TERMS", interestRate: "2", maturityDate: day("2031-08-01"),
      paymentFrequency: "QUARTERLY", repaymentType: "EQUAL_PRINCIPAL", fees: "5000", bankAccountId: bdo, reason: "Restructuring",
    });
    const t = await prisma.loanTransaction.findFirstOrThrow({ where: { loanId, type: "MODIFICATION" }, orderBy: { createdAt: "desc" } });
    expect((t.details as { substantial: boolean }).substantial).toBe(true);
    const after = await bal();
    expect(after.unamortized).toBe(0n);
    expect(toCentavos(t.interestExpense.toString())).toBe(-toCentavos(t.costChange.toString()) + 500000n); // unamortized costs written off + fees expensed
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(Number(loan.effectiveRate)).toBeCloseTo(2, 6);
    expect(await tiedOut()).toBe(true);
  });

  it("settles the loan when fully repaid", async () => {
    const due = await paymentDue(org, loanId, day("2026-09-15"));
    const v = await createLoanPayment({
      organizationId: org, userId: clerk, loanId, date: day("2026-09-15"), principal: (Number(due.outstanding) / 100).toFixed(2), interest: (Number(due.interest) / 100).toFixed(2),
      method: "CHECK", action: "submit",
    });
    expect(v.checkNo).toBe("005001");
    await approveCash(org, accountant, v.id);
    await syncLoanPayments(org);
    const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
    expect(loan.status).toBe("SETTLED");
    const b = await bal();
    expect(b.principal).toBe(0n);
    expect(b.current).toBe(0n);
    expect(await glBal("2095")).toBe(0n);
    expect(await glBal("2510")).toBe(0n);
    expect(await tiedOut()).toBe(true);
  });
});
