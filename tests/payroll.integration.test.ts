// Payroll and HR end to end against the real database: time logs and requests -> payroll -> GL -> payslips / 2316.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { provisionOrganization } from "@/lib/org";
import { clockPair, createRequest, decideRequest, ensureHrSetup, grantLeaveCredits, leaveBalances, saveEmployeeHr, canDecide, clock } from "@/lib/hr/service";
import { addRunAdjustment, computeRun, createRun, finalizeRun, recordPayment, releasePayslips, setReviewed, submitRun, voidRun, savePayItem } from "@/lib/payroll/service";
import { compute2316, generate2316, set2316Status } from "@/lib/payroll/bir2316";
import { attendancePdf, form2316Pdf, laborCostPdf, leavePdf, payslipsPdf, registerPdf, taxReportPdf, earningsSummaryPdf } from "@/lib/payroll/documents";
import { manilaInstant } from "@/lib/payroll/attendance";
import { computeReturn } from "@/lib/tax/returns";
import { alphalistEmployees } from "@/lib/tax/lists";
import { alphalist1604CDat } from "@/lib/tax/dat";

let orgId = "", owner = "", accountant = "", mgrUser = "", staffUser = "";
let mgr = "", staff = "", daily = "";

beforeAll(async () => {
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}${Date.now()}${Math.random()}@test.local`, name: n, passwordHash: "x" } });
  owner = (await mk("owner")).id; accountant = (await mk("acct")).id; mgrUser = (await mk("mgr")).id; staffUser = (await mk("staff")).id;
  orgId = (await provisionOrganization({ name: "Payroll Co", ownerUserId: owner })).id;
  await prisma.membership.createMany({ data: [
    { userId: accountant, organizationId: orgId, role: "ACCOUNTANT" },
    { userId: mgrUser, organizationId: orgId, role: "EMPLOYEE" },
    { userId: staffUser, organizationId: orgId, role: "EMPLOYEE" },
  ] });
  await prisma.dimensionValue.create({ data: { organizationId: orgId, type: "DEPARTMENT", code: "OPS", name: "Operations" } });
  await ensureHrSetup(orgId, 2026);
  const day = await prisma.shift.findFirstOrThrow({ where: { organizationId: orgId, code: "DAY" } });
  const base = { organizationId: orgId, department: "OPS", dateHired: new Date("2024-01-01"), shiftId: day.id, tin: "123-456-789-000" };
  mgr = (await prisma.employee.create({ data: { ...base, code: "E-001", firstName: "Maria", lastName: "Santos", payBasis: "MONTHLY", basicRate: 60000, userId: mgrUser } })).id;
  staff = (await prisma.employee.create({ data: { ...base, code: "E-002", firstName: "Juan", lastName: "Dela Cruz", payBasis: "MONTHLY", basicRate: 30000, userId: staffUser, managerId: mgr } })).id;
  daily = (await prisma.employee.create({ data: { ...base, code: "E-003", firstName: "Ana", lastName: "Reyes", payBasis: "DAILY", basicRate: 695, workDaysPerYear: 313, minimumWageEarner: true, managerId: mgr } })).id;
  await saveEmployeeHr(orgId, owner, daily, { shiftId: day.id, managerId: mgr, workDaysPerYear: 313, minimumWageEarner: true });
  await grantLeaveCredits(orgId, owner, 2026);
  // June 1-15, 2026: Mon-Fri 8-5 for everyone (June 12 = Independence Day, regular holiday).
  for (const id of [mgr, staff, daily]) for (let d = 1; d <= 15; d++) {
    const date = `2026-06-${String(d).padStart(2, "0")}`;
    const wd = new Date(date).getUTCDay();
    if (wd === 0 || wd === 6 || date === "2026-06-12") continue;
    if (id === staff && date === "2026-06-03") continue; // absent
    if (id === staff && date === "2026-06-05") continue; // on leave
    const { tin, tout } = clockPair(date, id === staff && date === "2026-06-02" ? "08:30" : "08:00", "17:00");
    await prisma.timeLog.create({ data: { organizationId: orgId, employeeId: id, date: new Date(date), timeIn: tin, timeOut: tout } });
  }
});

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { organizationId: orgId } });
  await prisma.journalEntry.updateMany({ where: { organizationId: orgId }, data: { reversalOfId: null } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: orgId } });
  await prisma.payrollRun.deleteMany({ where: { organizationId: orgId } });
  await prisma.form2316.deleteMany({ where: { organizationId: orgId } });
  await prisma.employee.updateMany({ where: { organizationId: orgId }, data: { managerId: null } });
  await prisma.employee.deleteMany({ where: { organizationId: orgId } });
  await prisma.shift.deleteMany({ where: { organizationId: orgId } });
  await prisma.leaveType.deleteMany({ where: { organizationId: orgId } });
  await prisma.holiday.deleteMany({ where: { organizationId: orgId } });
  await prisma.hrRequest.deleteMany({ where: { organizationId: orgId } });
  await prisma.bankAccount.deleteMany({ where: { organizationId: orgId } });
  await prisma.account.updateMany({ where: { organizationId: orgId }, data: { parentId: null } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, accountant, mgrUser, staffUser] } } });
});

describe("HR requests", () => {
  it("routes requests to the reporting manager, who approves; balances update", async () => {
    const vl = await prisma.leaveType.findFirstOrThrow({ where: { organizationId: orgId, code: "VL" } });
    const leave = await createRequest(orgId, staffUser, { type: "LEAVE", dateFrom: "2026-06-05", leaveTypeId: vl.id, reason: "Family matter" });
    expect(leave.approverId).toBe(mgr);
    expect(Number(leave.days)).toBe(1);
    const ot = await createRequest(orgId, staffUser, { type: "OVERTIME", dateFrom: "2026-06-04", hours: 2, reason: "Month-end close" });
    const amend = await createRequest(orgId, staffUser, { type: "TIME_AMENDMENT", dateFrom: "2026-06-04", timeIn: "08:00", timeOut: "19:00", reason: "Forgot to clock out after OT" });
    expect(await canDecide(orgId, staffUser, false, leave)).toBe(false); // not own request
    await expect(decideRequest(orgId, staffUser, false, leave.id, true)).rejects.toThrow();
    for (const r of [leave, ot, amend]) await decideRequest(orgId, mgrUser, false, r.id, true);
    const bal = (await leaveBalances(orgId, staff, 2026)).find((b) => b.code === "VL")!;
    expect(bal.used).toBe(1);
    expect(bal.available).toBe(14);
    const log = await prisma.timeLog.findUniqueOrThrow({ where: { employeeId_date: { employeeId: staff, date: new Date("2026-06-04") } } });
    expect(log.source).toBe("AMENDED");
  });
  it("blocks leave beyond the balance", async () => {
    const el = await prisma.leaveType.findFirstOrThrow({ where: { organizationId: orgId, code: "EL" } });
    await expect(createRequest(orgId, staffUser, { type: "LEAVE", dateFrom: "2026-07-01", dateTo: "2026-07-10", leaveTypeId: el.id, reason: "x" })).rejects.toThrow(/Not enough/);
  });
  it("clock in and out from the portal", async () => {
    const now = manilaInstant("2026-06-20", 8 * 60);
    await clock(orgId, mgrUser, "in", now);
    await expect(clock(orgId, mgrUser, "in", now)).rejects.toThrow(/already/);
    const out = await clock(orgId, mgrUser, "out", new Date(now.getTime() + 9 * 3600e3));
    expect(out.timeOut).not.toBeNull();
  });
});

describe("payroll run", () => {
  let runId = "";
  it("computes from approved attendance", async () => {
    await savePayItem(orgId, owner, { employeeId: staff, kind: "EARNING", category: "DE_MINIMIS", name: "Rice subsidy", amount: "1250", deMinimisCode: "RICE" });
    await savePayItem(orgId, owner, { employeeId: staff, kind: "DEDUCTION", category: "SSS_LOAN", name: "SSS salary loan", amount: "1000", balance: "1500" });
    const run = await createRun(orgId, accountant, { kind: "REGULAR", frequency: "SEMI_MONTHLY", periodStart: "2026-06-01", periodEnd: "2026-06-15", payDate: "2026-06-15", deductContributions: true });
    runId = run.id;
    await addRunAdjustment(orgId, accountant, runId, { employeeId: mgr, kind: "EARNING", category: "COMMISSION", name: "Q2 commission", amount: "5000" });
    expect(await computeRun(orgId, accountant, runId)).toBe(3);
    const s = await prisma.payslip.findFirstOrThrow({ where: { runId, employeeId: staff } });
    const earn = s.earnings as { code: string; amount: number }[];
    expect(earn.find((l) => l.code === "BASIC")!.amount).toBe(15000);
    expect(earn.find((l) => l.code === "ABSENT")!.amount).toBeCloseTo(-30000 * 12 / 261, 2); // June 3 only; June 5 is approved VL
    expect(earn.find((l) => l.code === "LATE")!.amount).toBeCloseTo(-30 * (30000 * 12 / 261 / 8 / 60), 2);
    expect(earn.find((l) => l.code === "OT_ORDINARY")!.amount).toBeCloseTo(2 * 30000 * 12 / 261 / 8 * 1.25, 2);
    const d = await prisma.payslip.findFirstOrThrow({ where: { runId, employeeId: daily } });
    const dEarn = d.earnings as { code: string; amount: number }[];
    expect(dEarn.find((l) => l.code === "HOLIDAY_UNWORKED")!.amount).toBe(695);
    expect(Number(d.withholdingTax)).toBe(0);
  });
  it("needs review by someone other than the preparer, then posts a balanced GL entry", async () => {
    await submitRun(orgId, accountant, runId);
    await expect(finalizeRun(orgId, owner, runId)).rejects.toThrow(/not yet marked reviewed/);
    await setReviewed(orgId, owner, runId, "all", true);
    await expect(finalizeRun(orgId, accountant, runId)).rejects.toThrow(/Segregation/);
    const { journal } = await finalizeRun(orgId, owner, runId);
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: journal.id }, include: { lines: { include: { account: true } } } });
    expect(je.status).toBe("POSTED");
    expect(je.source).toBe("PAYROLL");
    expect(Number(je.totalDebit)).toBe(Number(je.totalCredit));
    const slips = await prisma.payslip.findMany({ where: { runId } });
    const net = slips.reduce((n, s) => n + Number(s.netPay), 0);
    const payable = je.lines.filter((l) => l.account.systemRole === "SALARIES_PAYABLE").reduce((n, l) => n + Number(l.credit), 0);
    expect(payable).toBeCloseTo(net, 2);
    expect(je.lines.some((l) => l.account.systemRole === "OVERTIME_EXPENSE")).toBe(true);
    expect(je.lines.filter((l) => l.departmentId).length).toBeGreaterThan(0);
    const loan = await prisma.employeePayItem.findFirstOrThrow({ where: { employeeId: staff, category: "SSS_LOAN" } });
    expect(Number(loan.balance)).toBe(500);
  });
  it("releases payslips, records payment, builds PDFs and 2316", async () => {
    await releasePayslips(orgId, owner, runId);
    const bankAcct = await prisma.account.findFirstOrThrow({ where: { organizationId: orgId, code: "1020" } });
    const bank = await prisma.bankAccount.create({ data: { organizationId: orgId, code: "BDO-1", name: "BDO payroll", glAccountId: bankAcct.id } });
    const pay = await recordPayment(orgId, owner, runId, bank.id, "2026-06-15");
    expect(Number(pay.totalDebit)).toBe(Number(pay.totalCredit));
    await expect(voidRun(orgId, owner, runId, "test")).rejects.toThrow(/released/);
    for (const b of [await payslipsPdf(orgId, runId), await registerPdf(orgId, runId), await laborCostPdf(orgId, "2026-01-01", "2026-12-31"),
      await taxReportPdf(orgId, "2026-06-01", "2026-06-30"), await earningsSummaryPdf(orgId, 2026), await attendancePdf(orgId, [staff], "2026-06-01", "2026-06-15"),
      await leavePdf(orgId, [staff, daily], 2026), await form2316Pdf(orgId, staff, 2026)]) {
      expect(Buffer.from(b).subarray(0, 4).toString()).toBe("%PDF");
    }
    const f = await compute2316(orgId, staff, 2026);
    expect(f.i19_gross).toBeCloseTo(f.i36_totalNonTax + f.i50_totalTaxable, 2);
    const slip = await prisma.payslip.findFirstOrThrow({ where: { runId, employeeId: staff } });
    expect(f.i50_totalTaxable).toBeCloseTo(Number(slip.taxableIncome), 2);
    expect(await generate2316(orgId, owner, 2026)).toBe(3);
    const form = await prisma.form2316.findFirstOrThrow({ where: { employeeId: staff, year: 2026 } });
    await expect(set2316Status(orgId, owner, form.id, "release")).rejects.toThrow(/finalize/);
    await set2316Status(orgId, owner, form.id, "finalize");
    await set2316Status(orgId, owner, form.id, "release");
  });
  it("voids an unreleased finalized run and reverses the GL", async () => {
    const run = await createRun(orgId, accountant, { kind: "THIRTEENTH_MONTH", frequency: "MONTHLY", periodStart: "2026-12-01", periodEnd: "2026-12-15", payDate: "2026-12-15" });
    await computeRun(orgId, accountant, run.id);
    const t = await prisma.payslip.findFirstOrThrow({ where: { runId: run.id, employeeId: staff } });
    expect(Number(t.thirteenthPay)).toBeGreaterThan(0);
    await submitRun(orgId, accountant, run.id);
    await setReviewed(orgId, owner, run.id, "all", true);
    const { journal } = await finalizeRun(orgId, owner, run.id);
    await voidRun(orgId, owner, run.id, "duplicate");
    const rev = await prisma.journalEntry.findFirst({ where: { reversalOfId: journal.id } });
    expect(rev).not.toBeNull();
  });
});

describe("payroll feeds the BIR tax engine", () => {
  it("fills 1601-C for the month from finalized runs and ties to the GL", async () => {
    const slips = await prisma.payslip.findMany({ where: { organizationId: orgId, run: { status: "FINALIZED", payDate: { gte: new Date("2026-06-01"), lte: new Date("2026-06-30") } } } });
    const withheld = slips.reduce((n, s) => n + Number(s.withholdingTax), 0);
    const gross = slips.reduce((n, s) => n + Number(s.gross), 0);
    const r = await computeReturn(orgId, "1601C", 2026, 6);
    const row = (k: string) => r.sections.flatMap((x) => x.rows).find((x) => x.key === k)!;
    expect(Number(row("withheld").tax) / 100).toBeCloseTo(withheld, 2);
    expect(Number(row("comp.total").base) / 100).toBeCloseTo(gross, 2);
    expect(Number(row("comp.nonTaxable").base! + row("comp.taxable").base!) / 100).toBeCloseTo(gross, 2);
    expect(Number(row("comp.smw").base)).toBeGreaterThan(0); // Ana is a minimum wage earner
    expect(Number(r.taxDue) / 100).toBeCloseTo(withheld, 2);
    expect(r.payrollRuns).toHaveLength(1);
    expect(r.warnings).toEqual([]);
  });
  it("leaves voided runs out of 1601-C", async () => {
    const r = await computeReturn(orgId, "1601C", 2026, 12);
    expect(r.payrollRuns).toHaveLength(0);
    expect(r.taxDue).toBe(0n);
  });
  it("lists every paid employee in the 1604-C alphalist with their 2316 figures", async () => {
    const rows = (await alphalistEmployees(orgId, 2026))!;
    expect(rows).toHaveLength(3);
    const ana = rows.find((r) => r.lastName === "Reyes")!;
    expect(ana.schedule).toBe("7.5");
    expect(ana.formStatus).toBe("DRAFT");
    const juan = rows.find((r) => r.lastName === "Dela Cruz")!;
    expect(juan.schedule).toBe("7.3");
    expect(juan.formStatus).toBe("RELEASED");
    const f = await compute2316(orgId, staff, 2026);
    expect(Number(juan.grossCompensation)).toBeCloseTo(f.i19_gross, 2);
    expect(Number(juan.taxWithheldPresent)).toBeCloseTo(f.i25a_withheldPresent, 2);
    expect(juan.tin9).toBe("123456789");
    await prisma.organization.update({ where: { id: orgId }, data: { tin: "987-654-321-000", rdoCode: "39" } });
    const dat = alphalist1604CDat({ tin: "987-654-321-000", rdoCode: "39", name: "Payroll Co" }, 2026, rows).split("\r\n").filter(Boolean);
    expect(dat[0]).toBe("H1604C,987654321,0000,12/31/2026,039");
    expect(dat.filter((l) => l.startsWith("D7.3,"))).toHaveLength(2);
    expect(dat.filter((l) => l.startsWith("D7.5,"))).toHaveLength(1);
    expect(dat.some((l) => l.startsWith("C7.3,1604C,987654321"))).toBe(true);
  });
});
