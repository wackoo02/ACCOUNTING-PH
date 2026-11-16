// Runs against the real database in DATABASE_URL. Each run uses fresh companies.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import {
  LedgerError, accountByRole, closeFiscalYear, postJournal, recordIntercompany, recordJournal, rejectJournal, reopenFiscalYear,
  revalueForeignCurrency, runAutoReversals, setPeriodStatus, setupIntercompany, submitForApproval, updateDraft, voidOrReverse,
} from "@/lib/ledger/service";
import { accountLedger, balanceSheet, budgetVsActual, cashFlow, consolidatedTrialBalance, incomeStatement, trialBalance } from "@/lib/ledger/reports";
import { buildWorkbook, parseUpload } from "@/lib/masters/excel";
import { importMasters } from "@/lib/masters/store";
import { budgetWorkbook, importBudget } from "@/lib/budgets";
import { createAllocationRule, createRecurringFromEntry, runAllocation, runRecurring } from "@/lib/ledger/automation";

let orgId = "", subId = "", owner = "", clerk = "", accountant = "";
const Y = 2026;
const acct = async (code: string, org = orgId) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
const d = (s: string) => new Date(`${Y}-${s}`);

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; clerk = (await mk("clerk")).id; accountant = (await mk("accountant")).id;
  orgId = (await provisionOrganization({ name: "Parent Co", ownerUserId: owner })).id;
  subId = (await provisionOrganization({ name: "Sub Co", ownerUserId: owner })).id;
  await prisma.organization.update({ where: { id: subId }, data: { parentId: orgId, entityType: "SUBSIDIARY" } });
  await prisma.membership.createMany({ data: [
    { userId: clerk, organizationId: orgId, role: "BOOKKEEPER" },
    { userId: accountant, organizationId: orgId, role: "ACCOUNTANT", approvalLimit: "100000" },
  ] });
});
afterAll(async () => {
  const ids = { in: [orgId, subId] };
  await prisma.journalLine.deleteMany({ where: { organizationId: ids } });
  await prisma.journalEntry.updateMany({ where: { organizationId: ids }, data: { reversalOfId: null } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ids } });
  await prisma.intercompanyLink.deleteMany({ where: { organizationId: ids } });
  await prisma.account.updateMany({ where: { organizationId: ids }, data: { parentId: null } });
  await prisma.dimensionValue.updateMany({ where: { organizationId: ids }, data: { parentId: null } });
  await prisma.budget.deleteMany({ where: { organizationId: ids } });
  await prisma.recurringJournal.deleteMany({ where: { organizationId: ids } });
  await prisma.allocationRule.deleteMany({ where: { organizationId: ids } });
  await prisma.taxCode.deleteMany({ where: { organizationId: ids } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ids } });
  await prisma.organization.updateMany({ where: { id: subId }, data: { parentId: null } });
  await prisma.organization.deleteMany({ where: { id: ids } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, clerk, accountant] } } });
  await prisma.$disconnect();
});

const capital = async () => recordJournal({ organizationId: orgId, userId: owner, date: d("01-02"), memo: "Initial capital", source: "OPENING_BALANCE", action: "post",
  lines: [{ accountId: await acct("1020"), debit: "1000000" }, { accountId: await acct("3010"), credit: "1000000" }] });

describe("chart of accounts", () => {
  it("seeds the PH chart with system roles", async () => {
    expect(await prisma.account.count({ where: { organizationId: orgId } })).toBeGreaterThan(100);
    expect(await prisma.taxCode.count({ where: { organizationId: orgId, taxType: "EWT" } })).toBeGreaterThan(5);
    expect((await accountByRole(orgId, "AR_CONTROL")).code).toBe("1100");
    expect((await accountByRole(orgId, "UNREALIZED_FX_GAIN")).code).toBe("7025");
  });
});

describe("controls and approval workflow", () => {
  it("bookkeeper prepares, preparer cannot approve, accountant approves within limit", async () => {
    await capital();
    const e = await recordJournal({ organizationId: orgId, userId: clerk, date: d("01-15"), transactionDate: d("01-14"), memo: "Office rent", reference: "OR-123", action: "submit",
      attachments: [{ name: "Lease", url: "https://example.com/lease.pdf" }],
      lines: [{ accountId: await acct("6030"), debit: "50000" }, { accountId: await acct("1020"), credit: "50000" }] });
    expect(e.status).toBe("PENDING_APPROVAL");
    expect(e.number).toBe(`JV-${Y}-000001`);
    await expect(postJournal(orgId, clerk, e.id)).rejects.toThrow(/rights to approve/);
    await postJournal(orgId, accountant, e.id);
    const posted = await prisma.journalEntry.findUniqueOrThrow({ where: { id: e.id }, include: { attachments: true } });
    expect(posted.status).toBe("POSTED");
    expect(posted.postedById).toBe(accountant);
    expect(posted.transactionDate.toISOString().slice(0, 10)).toBe(`${Y}-01-14`);
    expect(posted.attachments).toHaveLength(1);
  });

  it("enforces segregation of duties and approval limits", async () => {
    const own = await recordJournal({ organizationId: orgId, userId: accountant, date: d("01-16"), memo: "Supplies", action: "submit",
      lines: [{ accountId: await acct("6060"), debit: "1000" }, { accountId: await acct("1010"), credit: "1000" }] });
    await expect(postJournal(orgId, accountant, own.id)).rejects.toThrow(/Segregation of duties/);
    const big = await recordJournal({ organizationId: orgId, userId: clerk, date: d("01-16"), memo: "Big purchase", action: "submit",
      lines: [{ accountId: await acct("1530"), debit: "250000" }, { accountId: await acct("1020"), credit: "250000" }] });
    await expect(postJournal(orgId, accountant, big.id)).rejects.toThrow(/approval limit/);
    await postJournal(orgId, owner, big.id);
    await postJournal(orgId, owner, own.id);
  });

  it("rejects back to draft with a reason, then edit is audited with before/after", async () => {
    const e = await recordJournal({ organizationId: orgId, userId: clerk, date: d("01-20"), memo: "Meals", action: "submit",
      lines: [{ accountId: await acct("6120"), debit: "800" }, { accountId: await acct("1010"), credit: "800" }] });
    await rejectJournal(orgId, accountant, e.id, "Attach the receipt");
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: e.id } })).status).toBe("DRAFT");
    await updateDraft(e.id, { organizationId: orgId, userId: clerk, date: d("01-20"), memo: "Team meals", lines: [{ accountId: await acct("6120"), debit: "900" }, { accountId: await acct("1010"), credit: "900" }] });
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: e.id, action: "journal.update" } });
    expect((log.before as { memo: string }).memo).toBe("Meals");
    expect((log.after as { memo: string }).memo).toBe("Team meals");
    expect(await prisma.auditLog.count({ where: { entityId: e.id, action: "journal.reject" } })).toBe(1);
    await submitForApproval(orgId, clerk, e.id);
    await postJournal(orgId, accountant, e.id);
  });

  it("blocks direct posting when approval is required, and restricted accounts", async () => {
    await expect(recordJournal({ organizationId: orgId, userId: owner, date: d("01-21"), memo: "x", action: "post",
      lines: [{ accountId: await acct("6060"), debit: "1" }, { accountId: await acct("1010"), credit: "1" }] })).rejects.toThrow(/requires approval/);
    await prisma.account.update({ where: { id: await acct("1100") }, data: { allowManualPosting: false } });
    await expect(recordJournal({ organizationId: orgId, userId: clerk, date: d("01-21"), memo: "x",
      lines: [{ accountId: await acct("1100"), debit: "1" }, { accountId: await acct("4020"), credit: "1" }] })).rejects.toThrow(/sub-ledger/);
    // Sub-ledger modules can still post there.
    await recordJournal({ organizationId: orgId, userId: owner, date: d("01-22"), memo: "Billing SI-1", source: "SALES", action: "post",
      lines: [{ accountId: await acct("1100"), debit: "112000" }, { accountId: await acct("4020"), credit: "100000" }, { accountId: await acct("2030"), credit: "12000" }] });
  });

  it("rejects unbalanced, header and cross-company lines", async () => {
    await expect(recordJournal({ organizationId: orgId, userId: clerk, date: d("01-06"), memo: "bad",
      lines: [{ accountId: await acct("1020"), debit: "100" }, { accountId: await acct("3010"), credit: "90" }] })).rejects.toBeInstanceOf(LedgerError);
    await expect(recordJournal({ organizationId: orgId, userId: clerk, date: d("01-06"), memo: "header",
      lines: [{ accountId: await acct("1000"), debit: "100" }, { accountId: await acct("3010"), credit: "100" }] })).rejects.toThrow(/header account/);
    await expect(recordJournal({ organizationId: orgId, userId: clerk, date: d("01-06"), memo: "cross",
      lines: [{ accountId: await acct("1020", subId), debit: "100" }, { accountId: await acct("3010"), credit: "100" }] })).rejects.toThrow(/do not belong/);
  });
});

describe("dimensions, forex, reversal", () => {
  it("tags lines with dimensions and filters reports by them", async () => {
    await importMasters("dimensions", orgId, owner, [
      { type: "DEPARTMENT", code: "SALES", name: "Sales" },
      { type: "DEPARTMENT", code: "FIN", name: "Finance" },
      { type: "PROJECT", code: "P1", name: "Project One" },
    ]);
    const sales = await prisma.dimensionValue.findFirstOrThrow({ where: { organizationId: orgId, code: "SALES" } });
    const p1 = await prisma.dimensionValue.findFirstOrThrow({ where: { organizationId: orgId, code: "P1" } });
    const e = await recordJournal({ organizationId: orgId, userId: clerk, date: d("02-03"), memo: "Client visit Grab", action: "submit",
      lines: [{ accountId: await acct("6050"), debit: "500", dims: { departmentId: sales.id, projectId: p1.id } }, { accountId: await acct("1030"), credit: "500" }] });
    await postJournal(orgId, accountant, e.id);
    const is = await incomeStatement(orgId, d("01-01"), d("12-31"), { dims: { departmentId: sales.id } });
    expect(is.opex.total).toBe(50000n);
    await expect(recordJournal({ organizationId: orgId, userId: clerk, date: d("02-03"), memo: "wrong dim type",
      lines: [{ accountId: await acct("6050"), debit: "1", dims: { projectId: sales.id } }, { accountId: await acct("1010"), credit: "1" }] })).rejects.toThrow(/project/);
  });

  it("stores forex and base amounts, requires FX line on mixed currencies, revalues", async () => {
    await importMasters("currencies", orgId, owner, [{ code: "USD", name: "US Dollar", rateToBase: "58" }]);
    await importMasters("accounts", orgId, owner, [{ code: "1027", name: "Cash in Bank - USD", type: "ASSET", ifrsGroup: "Cash and cash equivalents", isCurrent: true, parentCode: "1000", currencyCode: "USD" }]);
    // USD sale received in USD bank: 1,000 USD @ 58 = 58,000 PHP
    const e = await recordJournal({ organizationId: orgId, userId: owner, date: d("02-10"), memo: "Export sale", source: "SALES", action: "post",
      lines: [{ accountId: await acct("1027"), debit: "1000", currencyCode: "USD", fxRate: "58" }, { accountId: await acct("4010"), credit: "1000", currencyCode: "USD", fxRate: "58" }] });
    const l = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: e.id, lineNo: 1 } });
    expect(l.fxDebit.toString()).toBe("1000");
    expect(l.debit.toString()).toBe("58000");
    // Mixed currencies that don't balance in PHP -> must add realized FX line
    await expect(recordJournal({ organizationId: orgId, userId: owner, date: d("02-11"), memo: "mixed", source: "SALES", action: "post",
      lines: [{ accountId: await acct("1027"), debit: "100", currencyCode: "USD", fxRate: "57" }, { accountId: await acct("1100"), credit: "5800" }] })).rejects.toThrow(/foreign exchange gain or loss/);
    // Wrong currency on a USD account
    await expect(recordJournal({ organizationId: orgId, userId: clerk, date: d("02-11"), memo: "x",
      lines: [{ accountId: await acct("1027"), debit: "1" }, { accountId: await acct("4010"), credit: "1" }] })).rejects.toThrow(/USD account/);
    // Revalue at 59 -> unrealized gain 1,000 PHP, auto-reverses on Mar 1
    const rv = await revalueForeignCurrency(orgId, owner, d("02-28"), { USD: "59" });
    expect(rv!.totalDebit.toString()).toBe("1000");
    const led = await accountLedger(orgId, await acct("1027"), d("01-01"), d("02-28"));
    expect(led!.closing).toBe(5900000n);
    const revs = await runAutoReversals(orgId, owner, d("03-01"));
    expect(revs).toHaveLength(1);
    expect((await accountLedger(orgId, await acct("1027"), d("01-01"), d("03-31")))!.closing).toBe(5800000n);
  });

  it("reverses posted entries and blocks closed periods", async () => {
    const e = await recordJournal({ organizationId: orgId, userId: owner, date: d("02-01"), memo: "Supplies", source: "PURCHASES", action: "post",
      lines: [{ accountId: await acct("6060"), debit: "1500" }, { accountId: await acct("1010"), credit: "1500" }] });
    const rev = await voidOrReverse(orgId, owner, e.id);
    expect(rev!.number).toMatch(new RegExp(`^RV-${Y}-`));
    await expect(voidOrReverse(orgId, owner, e.id)).rejects.toThrow(/Already reversed/);
    await setPeriodStatus(orgId, owner, Y, 4, "CLOSED");
    await expect(recordJournal({ organizationId: orgId, userId: owner, date: d("04-15"), memo: "late", source: "PURCHASES", action: "post",
      lines: [{ accountId: await acct("6060"), debit: "1" }, { accountId: await acct("1010"), credit: "1" }] })).rejects.toThrow(/closed/);
    await setPeriodStatus(orgId, owner, Y, 4, "OPEN");
  });
});

describe("recurring entries and allocations", () => {
  it("generates recurring entries for each due period", async () => {
    const e = await recordJournal({ organizationId: orgId, userId: clerk, date: d("05-31"), memo: "Monthly insurance amortization",
      lines: [{ accountId: await acct("6080"), debit: "5000" }, { accountId: await acct("1300"), credit: "5000" }] });
    await createRecurringFromEntry(orgId, clerk, e.id, { name: "Insurance", frequency: "MONTHLY", nextRunDate: d("06-30"), endDate: d("08-31"), autoSubmit: true });
    const made = await runRecurring(orgId, clerk, d("09-15"));
    expect(made.map((m) => m.date.toISOString().slice(0, 10))).toEqual([`${Y}-06-30`, `${Y}-07-31`, `${Y}-08-31`]);
    expect(made.every((m) => m.status === "PENDING_APPROVAL")).toBe(true);
    expect(await runRecurring(orgId, clerk, d("12-31"))).toHaveLength(0);
    for (const m of made) await voidOrReverse(orgId, owner, m.id);
    await voidOrReverse(orgId, owner, e.id);
  });

  it("allocates an untagged balance across departments by percentage", async () => {
    const [sales, fin] = await Promise.all(["SALES", "FIN"].map((c) => prisma.dimensionValue.findFirstOrThrow({ where: { organizationId: orgId, code: c } })));
    const rule = await createAllocationRule(orgId, owner, { name: "Rent", sourceAccountId: await acct("6030"), dimensionType: "DEPARTMENT",
      splits: [{ dimensionValueId: sales.id, pct: "60" }, { dimensionValueId: fin.id, pct: "40" }] });
    await expect(createAllocationRule(orgId, owner, { name: "Bad", sourceAccountId: await acct("6030"), dimensionType: "DEPARTMENT",
      splits: [{ dimensionValueId: sales.id, pct: "60" }, { dimensionValueId: fin.id, pct: "30" }] })).rejects.toThrow(/add up to 100/);
    const e = await runAllocation(orgId, clerk, rule.id, d("01-01"), d("01-31"), d("01-31"));
    await postJournal(orgId, accountant, e.id);
    const isSales = await incomeStatement(orgId, d("01-01"), d("01-31"), { dims: { departmentId: sales.id } });
    expect(isSales.opex.total).toBe(3000000n); // 60% of 50,000 rent
  });
});

describe("financial statements", () => {
  it("trial balance balances, balance sheet balances, cash flow reconciles", async () => {
    const tb = await trialBalance(orgId, d("12-31"));
    expect(tb.balanced).toBe(true);
    const bs = await balanceSheet(orgId, d("12-31"));
    expect(bs.balanced).toBe(true);
    const cf = await cashFlow(orgId, d("01-01"), d("12-31"));
    expect(cf.reconciles).toBe(true);
    const is = await incomeStatement(orgId, d("01-01"), d("12-31"));
    expect(is.revenue.total).toBe(10000000n + 5800000n);
  });
});

describe("budgets", () => {
  it("downloads a template, uploads it, and compares to actual", async () => {
    const buf = await budgetWorkbook(orgId, Y);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Data")!;
    ws.eachRow((row, n) => {
      if (n > 1 && row.getCell(1).value === "6030") for (let i = 5; i <= 16; i++) row.getCell(i).value = 40000;
    });
    const r = await importBudget(orgId, owner, Y, (await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(r.errors).toEqual([]);
    const bva = await budgetVsActual(orgId, Y, d("01-01"), 1, 1);
    const rent = bva.rows.find((x) => x.account.code === "6030")!;
    expect(rent.budget).toBe(4000000n);
    expect(rent.actual).toBe(5000000n);
    expect(rent.variance).toBe(-1000000n); // over budget
    expect(rent.pct).toBe(-25);
  });
});

describe("intercompany and consolidation", () => {
  it("posts both sides, matches, and eliminates on consolidation", async () => {
    await setupIntercompany(owner, orgId, subId);
    const r = await recordIntercompany({ userId: owner, date: d("03-05"), memo: "Management fee",
      from: { organizationId: orgId, lines: [{ accountId: await acct("7040"), credit: "20000" }] },
      to: { organizationId: subId, lines: [{ accountId: await acct("6070", subId), debit: "20000" }] } });
    expect(r.entries.map((e) => e.number)).toEqual([`IC-${Y}-000001`, `IC-${Y}-000001`]);
    await expect(recordIntercompany({ userId: owner, date: d("03-05"), memo: "mismatch",
      from: { organizationId: orgId, lines: [{ accountId: await acct("7040"), credit: "100" }] },
      to: { organizationId: subId, lines: [{ accountId: await acct("6070", subId), debit: "90" }] } })).rejects.toThrow(/don't agree/);
    const cons = await consolidatedTrialBalance([orgId, subId], d("12-31"));
    expect(cons.total).toBe(0n);
    const due = cons.rows.filter((x) => x.name.startsWith("Due "));
    expect(due.every((x) => x.consolidated === 0n)).toBe(true);
  });
});

describe("year-end closing", () => {
  it("closes income and expenses to retained earnings, locks periods, owner can reopen", async () => {
    const before = await incomeStatement(orgId, d("01-01"), d("12-31"));
    const res = await closeFiscalYear(orgId, owner, Y);
    expect(res.netProfit).toBe(before.netProfit);
    const tb = await trialBalance(orgId, d("12-31"));
    expect(tb.rows.filter((r) => ["INCOME", "EXPENSE"].includes(r.account.type) && r.closing !== 0n)).toHaveLength(0);
    expect((await balanceSheet(orgId, d("12-31"))).balanced).toBe(true);
    await expect(recordJournal({ organizationId: orgId, userId: owner, date: d("06-15"), memo: "late", source: "PURCHASES", action: "post",
      lines: [{ accountId: await acct("6060"), debit: "1" }, { accountId: await acct("1010"), credit: "1" }] })).rejects.toThrow(/locked/);
    await expect(reopenFiscalYear(orgId, accountant, Y)).rejects.toThrow(/Only the owner/);
    await reopenFiscalYear(orgId, owner, Y);
    expect((await incomeStatement(orgId, d("01-01"), d("12-31"))).netProfit).toBe(before.netProfit);
  });
});

describe("master lists via Excel", () => {
  it("round-trips the template and validates all rows", async () => {
    const tpl = await buildWorkbook("vendors");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Data")!;
    ws.getRow(2).values = ["v-001", "ABC Supplies Inc.", "000-123-456-00000", "Makati", "", "", "", 30, "TRUE", 1, "WI158", "PHP", "TRUE"];
    ws.getRow(3).values = ["V-002", "", "", "", "", "", "", "abc", "maybe"];
    const bad = await parseUpload("vendors", (await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(bad.errors.join("\n")).toMatch(/Row 3: Registered Name is required/);
    ws.getRow(3).values = ["V-002", "Juan's Repair", "", "", "", "", "", 15, "no", 2, "", "PHP", ""];
    const ok = await parseUpload("vendors", (await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(ok.errors).toEqual([]);
    expect(await importMasters("vendors", orgId, owner, ok.rows)).toEqual({ created: 2, updated: 0 });
    expect(await importMasters("vendors", orgId, owner, ok.rows)).toEqual({ created: 0, updated: 2 });
  });
});
