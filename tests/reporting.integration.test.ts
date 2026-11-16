// Custom report builder: engine results agree with the standard reports, and sharing respects
// roles and company boundaries. Runs against the database in DATABASE_URL with fresh companies.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { recordJournal } from "@/lib/ledger/service";
import { balanceSheet, incomeStatement, trialBalance } from "@/lib/ledger/reports";
import { importMasters } from "@/lib/masters/store";
import { runReport } from "@/lib/reporting/run";
import { resolvePeriod } from "@/lib/reporting/periods";
import { openItems } from "@/lib/reporting/sources/aging";
import { deleteReport, getReport, listReports, saveReport } from "@/lib/reporting/saved";
import { TEMPLATES } from "@/lib/reporting/templates";
import type { ReportDefinitionInput } from "@/lib/reporting/definition";
import type { ReportResult } from "@/lib/reporting/result";

let orgId = "", subId = "", otherId = "", owner = "", viewer = "", clerk = "", outsider = "";
const Y = 2026;
const acct = async (code: string, org = orgId) => (await prisma.account.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org, code } } })).id;
const d = (s: string) => new Date(`${Y}-${s}T00:00:00Z`);
const NOW = new Date(`${Y}-03-31T08:00:00Z`);
const full = { id: "p1", kind: "custom" as const, from: `${Y}-01-01`, to: `${Y}-03-31` };

const run = async (def: ReportDefinitionInput, user = owner, org = orgId) => {
  const r = await runReport({ userId: user, currentOrgId: org }, def, NOW);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.result;
};
const rowByLabel = (r: ReportResult, label: string) => r.rows.find((x) => x.label === label);
const col = (r: ReportResult, ...head: string[]) => r.columns.findIndex((c) => head.every((h, i) => c.head[i] === h));

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; viewer = (await mk("viewer")).id; clerk = (await mk("clerk")).id; outsider = (await mk("outsider")).id;
  orgId = (await provisionOrganization({ name: "Report Parent", ownerUserId: owner })).id;
  subId = (await provisionOrganization({ name: "Report Sub", ownerUserId: owner })).id;
  otherId = (await provisionOrganization({ name: "Someone Else", ownerUserId: outsider })).id;
  await prisma.membership.createMany({ data: [{ userId: viewer, organizationId: orgId, role: "VIEWER" }, { userId: clerk, organizationId: orgId, role: "BOOKKEEPER" }] });
  for (const o of [orgId, subId]) {
    await importMasters("dimensions", o, owner, [{ type: "DEPARTMENT", code: "SALES", name: "Sales" }, { type: "DEPARTMENT", code: "ADMIN", name: "Admin" }]);
  }
  await importMasters("customers", orgId, owner, [{ code: "C001", name: "Acme Trading", paymentTermsDays: 30 }]);
  const dept = async (code: string, o = orgId) => (await prisma.dimensionValue.findFirstOrThrow({ where: { organizationId: o, code } })).id;
  const post = (o: string, date: string, memo: string, lines: Parameters<typeof recordJournal>[0]["lines"]) =>
    recordJournal({ organizationId: o, userId: owner, date: d(date), memo, source: "OPENING_BALANCE", action: "post", lines });
  await post(orgId, "01-02", "Capital", [{ accountId: await acct("1020"), debit: "100000" }, { accountId: await acct("3010"), credit: "100000" }]);
  await post(orgId, "01-15", "Sale Jan", [{ accountId: await acct("1100"), debit: "30000", partyType: "CUSTOMER", partyId: "C001" }, { accountId: await acct("4020"), credit: "30000", dims: { departmentId: await dept("SALES") } }]);
  await post(orgId, "02-20", "Sale Feb", [{ accountId: await acct("1100"), debit: "20000", partyType: "CUSTOMER", partyId: "C001" }, { accountId: await acct("4020"), credit: "20000", dims: { departmentId: await dept("SALES") } }]);
  await post(orgId, "03-10", "Collection", [{ accountId: await acct("1020"), debit: "25000" }, { accountId: await acct("1100"), credit: "25000", partyType: "CUSTOMER", partyId: "C001" }]);
  await post(orgId, "02-05", "Rent", [{ accountId: await acct("6030"), debit: "8000", dims: { departmentId: await dept("ADMIN") } }, { accountId: await acct("1020"), credit: "8000" }]);
  await post(orgId, "03-05", "Travel", [{ accountId: await acct("6050"), debit: "2000", dims: { departmentId: await dept("SALES") } }, { accountId: await acct("1020"), credit: "2000" }]);
  await post(subId, "02-01", "Sub capital", [{ accountId: await acct("1020", subId), debit: "5000" }, { accountId: await acct("3010", subId), credit: "5000" }]);
  await post(subId, "03-01", "Sub rent", [{ accountId: await acct("6030", subId), debit: "1000", dims: { departmentId: await dept("ADMIN", subId) } }, { accountId: await acct("1020", subId), credit: "1000" }]);
  await post(otherId, "02-01", "Other co", [{ accountId: await acct("1020", otherId), debit: "999" }, { accountId: await acct("3010", otherId), credit: "999" }]);
  // Rent budget: 3,000 a month company-wide.
  await prisma.budget.create({ data: { organizationId: orgId, fiscalYear: Y, accountId: await acct("6030"), m1: 3000, m2: 3000, m3: 3000 } });
});

afterAll(async () => {
  const ids = { in: [orgId, subId, otherId] };
  await prisma.savedReport.deleteMany({ where: { organizationId: ids } });
  await prisma.journalLine.deleteMany({ where: { organizationId: ids } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ids } });
  await prisma.account.updateMany({ where: { organizationId: ids }, data: { parentId: null } });
  await prisma.budget.deleteMany({ where: { organizationId: ids } });
  await prisma.taxCode.deleteMany({ where: { organizationId: ids } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ids } });
  await prisma.organization.deleteMany({ where: { id: ids } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, viewer, clerk, outsider] } } });
  await prisma.$disconnect();
});

describe("periods", () => {
  it("resolves relative periods against the report date and fiscal year", () => {
    const asOf = new Date("2026-05-15T00:00:00Z");
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    const m = resolvePeriod({ id: "a", kind: "month", offset: -1 }, asOf, 1);
    expect([iso(m.from), iso(m.to), m.label]).toEqual(["2026-04-01", "2026-04-30", "Apr 2026"]);
    const q = resolvePeriod({ id: "a", kind: "quarter", offset: 0 }, asOf, 7); // FY starts July: May is Q4 FY2026
    expect([iso(q.from), iso(q.to), q.label]).toEqual(["2026-04-01", "2026-06-30", "Q4 FY2026"]);
    const fy = resolvePeriod({ id: "a", kind: "fy", offset: -1 }, asOf, 7);
    expect([iso(fy.from), iso(fy.to)]).toEqual(["2024-07-01", "2025-06-30"]);
    const ytd = resolvePeriod({ id: "a", kind: "ytd", offset: -1 }, asOf, 1);
    expect([iso(ytd.from), iso(ytd.to)]).toEqual(["2025-01-01", "2025-05-15"]);
  });
});

describe("report engine", () => {
  it("trial balance template matches the standard trial balance", async () => {
    const r = await run({ ...TEMPLATES.find((t) => t.id === "trial_balance")!.def, periods: [{ ...full, from: "1900-01-01" }] });
    const tb = await trialBalance(orgId, d("03-31"));
    const cash = r.rows.find((x) => x.label.startsWith("1020 "))!;
    const std = tb.rows.find((x) => x.account.code === "1020")!;
    expect(cash.cells[col(r, r.columns[0].head[0], "Closing balance")]).toBe(std.closing.toString());
    expect(rowByLabel(r, "Total")!.cells[col(r, r.columns[0].head[0], "Closing balance")]).toBe("0"); // debits = credits
    expect(r.rows.some((x) => x.label.includes("Someone Else"))).toBe(false);
  });

  it("income statement with comparison and department columns", async () => {
    const r = await run({ source: "income_statement", periods: [{ id: "q", kind: "month", offset: 0 }, { id: "f", kind: "month", offset: -1 }], comparisons: [{ id: "c", base: "q", against: "f", show: "both" }] });
    const np = rowByLabel(r, "Net profit (loss) for the period")!;
    expect(np.cells.slice(0, 2)).toEqual(["-200000", "1200000"]); // Mar: -2,000 travel; Feb: 20,000 - 8,000
    expect(np.cells[2]).toBe("-1400000");
    expect(np.cells[3]).toBeCloseTo(-116.667, 2);
    const byDept = await run({ source: "income_statement", periods: [full], split: { by: "departmentId", total: true, untagged: true } });
    const npd = rowByLabel(byDept, "Net profit (loss) for the period")!;
    const heads = byDept.columns.map((c) => c.head.join(" / "));
    const std = await incomeStatement(orgId, d("01-01"), d("03-31"));
    expect(npd.cells[heads.findIndex((h) => h.includes("SALES"))]).toBe("4800000");
    expect(npd.cells[heads.findIndex((h) => h.includes("ADMIN"))]).toBe("-800000");
    expect(npd.cells[heads.findIndex((h) => h.endsWith("Total"))]).toBe(std.netProfit.toString());
  });

  it("balance sheet by entity, and entities the user cannot access are dropped", async () => {
    const r = await run({ source: "balance_sheet", periods: [full], split: { by: "entity", total: true }, filters: { entityIds: [orgId, subId, otherId] } });
    const ta = rowByLabel(r, "Total assets")!;
    const bsP = await balanceSheet(orgId, d("03-31")), bsS = await balanceSheet(subId, d("03-31"));
    expect(ta.cells).toEqual([bsP.totalAssets.toString(), bsS.totalAssets.toString(), (bsP.totalAssets + bsS.totalAssets).toString()]);
    expect(r.notes.join(" ")).toMatch(/left out/);
    expect(r.columns.some((c) => c.head.join().includes("Someone Else"))).toBe(false);
  });

  it("custom rows with formulas match the income statement", async () => {
    const r = await run({ ...TEMPLATES.find((t) => t.id === "management_pl")!.def, periods: [full], comparisons: [] });
    expect(r.rows.find((x) => x.key === "REV")!.cells).toEqual(["5000000"]);
    expect(rowByLabel(r, "Net profit")!.cells).toEqual([(await incomeStatement(orgId, d("01-01"), d("03-31"))).netProfit.toString()]);
    expect(r.rows.some((x) => x.kind === "detail" && x.label.startsWith("4020"))).toBe(true);
  });

  it("budget vs actual with favourable/unfavourable variance", async () => {
    const r = await run({ ...TEMPLATES.find((t) => t.id === "budget_vs_actual")!.def, periods: [full] });
    const rent = r.rows.find((x) => x.label.startsWith("6030"))!;
    expect(rent.cells).toEqual(["900000", "800000", "100000", expect.closeTo(11.111, 2)]); // under budget = favourable
    const rev = r.rows.find((x) => x.label.startsWith("4020"))!;
    expect(rev.cells.slice(0, 3)).toEqual(["0", "5000000", "5000000"]);
  });

  it("filters by dimension code and account range; groups by department", async () => {
    const r = await run({ source: "balances", periods: [full], measures: ["net"], rows: { groupBy: ["departmentId"], sign: "natural" }, filters: { accountTypes: ["EXPENSE"], dims: { departmentId: ["SALES", "ADMIN"] } } });
    expect(r.rows.map((x) => [x.label, x.cells[0]])).toEqual([["ADMIN · Admin", "800000"], ["SALES · Sales", "200000"], ["Total", "1000000"]]);
    const r2 = await run({ source: "balances", periods: [full], measures: ["net"], filters: { accountCodeFrom: "6000", accountCodeTo: "6039" } });
    expect(r2.rows.map((x) => x.label)).toEqual(["6030 · Rent Expense", "Total"]);
  });

  it("GL lines with running balance per account, and the JE register", async () => {
    const r = await run({ source: "gl_detail", periods: [{ id: "p", kind: "custom", from: `${Y}-02-01`, to: `${Y}-03-31` }], columns: ["date", "number", "debit", "credit", "balance"], groupDetailBy: "account", filters: { accountCodes: ["1020"] } });
    const opening = r.rows.find((x) => x.label === "Opening balance")!;
    expect(opening.cells[4]).toBe("10000000");
    expect(rowByLabel(r, "Total 1020 · Cash in Bank - Current Account")?.cells[4] ?? r.rows.find((x) => x.kind === "subtotal")!.cells[4]).toBe("11500000");
    const je = await run({ source: "journal_entries", periods: [full] });
    expect(je.rows.filter((x) => x.kind === "line")).toHaveLength(6);
  });

  it("ages customer balances first-in first-out", async () => {
    const r = await run({ ...TEMPLATES.find((t) => t.id === "ar_aging")!.def, periods: [{ id: "p", kind: "custom", from: `${Y}-03-31`, to: `${Y}-03-31` }] });
    const acme = r.rows.find((x) => x.cells[0] === "C001")!;
    // 30,000 (Jan 15, 75 days) less 25,000 collected = 5,000 in 61-90; 20,000 (Feb 20, 39 days) in 31-60.
    expect(acme.cells.slice(3)).toEqual(["0", "2000000", "500000", "0", "0", "2500000"]);
    expect(openItems([{ amount: -500n, date: d("01-01"), due: d("01-01"), number: "a", entryId: "a", orgId }, { amount: 200n, date: d("02-01"), due: d("02-01"), number: "b", entryId: "b", orgId }]).map((x) => x.amount)).toEqual([-300n]);
  });
});

describe("saved and shared reports", () => {
  const def = { source: "balances", periods: [{ id: "p1", kind: "ytd", offset: 0 }] };
  const me = () => ({ userId: owner, organizationId: orgId, role: "OWNER" as const });
  const v = () => ({ userId: viewer, organizationId: orgId, role: "VIEWER" as const });
  const k = () => ({ userId: clerk, organizationId: orgId, role: "BOOKKEEPER" as const });

  it("keeps private reports private and shares by company, role or person", async () => {
    const priv = await saveReport(k(), { name: "Clerk private", definition: def, visibility: "PRIVATE" });
    expect(priv.ok).toBe(true);
    const id = (priv as { id: string }).id;
    expect(await getReport(id, v())).toBeNull();
    expect(await getReport(id, me())).not.toBeNull(); // owner/admin can see everything in their company
    const byRole = await saveReport(k(), { id, name: "Clerk shared", definition: def, visibility: "ROLES", sharedRoles: ["VIEWER"] });
    expect(byRole.ok).toBe(true);
    expect(await getReport(id, v())).not.toBeNull();
    // The viewer can open but not change it.
    const edit = await saveReport(v(), { id, name: "Hijack", definition: def, visibility: "COMPANY" });
    expect(edit.ok).toBe(false);
    expect((await deleteReport(v(), id)).ok).toBe(false);
    // Shared with a person outside the company: silently not shared.
    const users = await saveReport(k(), { name: "To outsider", definition: def, visibility: "USERS", sharedUserIds: [outsider] });
    expect(users.ok).toBe(false);
    // Another company never sees it, even by id.
    expect(await getReport(id, { userId: outsider, organizationId: otherId, role: "OWNER" })).toBeNull();
    expect((await listReports({ userId: outsider, organizationId: otherId, role: "OWNER" })).length).toBe(0);
    expect((await listReports(v())).map((r) => r.name)).toContain("Clerk shared");
  });

  it("lets people it is shared with edit when allowed, but only the owner changes sharing", async () => {
    const r = await saveReport(k(), { name: "Team pack", definition: def, visibility: "COMPANY", allowEdit: true });
    const id = (r as { id: string }).id;
    const ed = await saveReport(v(), { id, name: "Team pack v2", definition: def, visibility: "PRIVATE" });
    expect(ed.ok).toBe(true);
    const after = await prisma.savedReport.findUniqueOrThrow({ where: { id } });
    expect([after.name, after.visibility, after.ownerId]).toEqual(["Team pack v2", "COMPANY", clerk]);
  });

  it("rejects invalid definitions", async () => {
    const r = await saveReport(me(), { name: "Bad", definition: { source: "balances", periods: [{ id: "a", kind: "custom" }] }, visibility: "PRIVATE" });
    expect(r.ok).toBe(false);
  });
});
