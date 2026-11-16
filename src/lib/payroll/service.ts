// Payroll runs: compute -> review -> finalize (posts the payroll accrual to the GL) -> release payslips -> pay.
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { LedgerError, audit, nextNumber, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import type { LineInput } from "../ledger/validate";
import { attendanceFor, employeeName, ymd } from "../hr/service";
import { summarize } from "./attendance";
import { EARNING_ROLE, EMPTY_YTD, computePayslip, type Line, type PayItem, type PayslipResult, type YearToDate } from "./compute";
import { round2 } from "./rates";

type Tx = Prisma.TransactionClient;
const fail = (msg: string): never => { throw new LedgerError([msg]); };
const num = (d: Prisma.Decimal | null | undefined) => (d ? Number(d) : 0);
const dec = (n: number) => new Prisma.Decimal(round2(n).toFixed(2));

// ---------- GL accounts used by payroll (created on first use if the chart doesn't have them) ----------

const PAYROLL_ACCOUNTS: { role: string; code: string; name: string; type: "ASSET" | "LIABILITY" | "EXPENSE"; ifrsGroup: string; isCurrent?: boolean; parent: string }[] = [
  { role: "SALARIES_EXPENSE", code: "6010", name: "Salaries and Wages", type: "EXPENSE", ifrsGroup: "Employee benefits expense", parent: "6000" },
  { role: "OVERTIME_EXPENSE", code: "6011", name: "Overtime Pay", type: "EXPENSE", ifrsGroup: "Employee benefits expense", parent: "6000" },
  { role: "COMMISSION_EXPENSE", code: "6012", name: "Sales Commissions", type: "EXPENSE", ifrsGroup: "Employee benefits expense", parent: "6000" },
  { role: "ALLOWANCE_EXPENSE", code: "6013", name: "Allowances and De Minimis Benefits", type: "EXPENSE", ifrsGroup: "Employee benefits expense", parent: "6000" },
  { role: "BONUS_EXPENSE", code: "6015", name: "13th Month Pay and Other Benefits", type: "EXPENSE", ifrsGroup: "Employee benefits expense", parent: "6000" },
  { role: "BENEFITS_EXPENSE", code: "6016", name: "HMO and Employee Insurance", type: "EXPENSE", ifrsGroup: "Employee benefits expense", parent: "6000" },
  { role: "GOVT_CONTRIB_EXPENSE", code: "6020", name: "SSS, PhilHealth and Pag-IBIG Contributions (Employer)", type: "EXPENSE", ifrsGroup: "Employee benefits expense", parent: "6000" },
  { role: "RETIREMENT_EXPENSE", code: "6025", name: "Retirement Benefit Expense", type: "EXPENSE", ifrsGroup: "Employee benefits expense", parent: "6000" },
  { role: "EMPLOYEE_ADVANCES", code: "1110", name: "Advances to Employees", type: "ASSET", ifrsGroup: "Trade and other receivables", isCurrent: true, parent: "1000" },
  { role: "WTC_PAYABLE", code: "2040", name: "Withholding Tax Payable - Compensation (1601-C)", type: "LIABILITY", ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { role: "SSS_PAYABLE", code: "2050", name: "SSS Contributions Payable", type: "LIABILITY", ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { role: "PHIC_PAYABLE", code: "2055", name: "PhilHealth Contributions Payable", type: "LIABILITY", ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { role: "HDMF_PAYABLE", code: "2060", name: "Pag-IBIG (HDMF) Contributions Payable", type: "LIABILITY", ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { role: "GOVT_LOANS_PAYABLE", code: "2065", name: "SSS / Pag-IBIG Loans Payable", type: "LIABILITY", ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { role: "OTHER_PAYROLL_DEDUCTIONS", code: "2068", name: "Other Payroll Deductions Payable", type: "LIABILITY", ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { role: "SALARIES_PAYABLE", code: "2070", name: "Salaries and Wages Payable", type: "LIABILITY", ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
  { role: "ACCRUED_BENEFITS", code: "2072", name: "Accrued Employee Benefits (HMO, Retirement)", type: "LIABILITY", ifrsGroup: "Trade and other payables", isCurrent: true, parent: "2000" },
];

/** Role -> account id for every payroll account, creating or tagging accounts as needed. */
export async function ensurePayrollAccounts(tx: Tx, organizationId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const a of PAYROLL_ACCOUNTS) {
    let acct = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: a.role } } });
    if (!acct) {
      const byCode = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: a.code } } });
      if (byCode && !byCode.systemRole && byCode.isPostable && byCode.type === a.type) {
        acct = await tx.account.update({ where: { id: byCode.id }, data: { systemRole: a.role } });
      } else {
        let code = Number(a.code);
        while (await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: String(code) } } })) code++;
        const parent = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: a.parent } } });
        acct = await tx.account.create({
          data: {
            organizationId, code: String(code), name: a.name, type: a.type, ifrsGroup: a.ifrsGroup, isCurrent: a.isCurrent ?? null,
            normalBalance: a.type === "LIABILITY" ? "CREDIT" : "DEBIT", systemRole: a.role, parentId: parent?.id ?? null,
          },
        });
      }
    }
    out.set(a.role, acct.id);
  }
  return out;
}

// ---------- Runs ----------

export type RunInput = {
  kind: "REGULAR" | "THIRTEENTH_MONTH" | "SPECIAL";
  frequency: "SEMI_MONTHLY" | "MONTHLY";
  periodStart: string; periodEnd: string; payDate: string;
  deductContributions?: boolean; yearEndAdjustment?: boolean; memo?: string;
};

/** Contributions are normally deducted in the run that ends the month (2nd cutoff) or in a monthly run. */
export function defaultDeductContributions(frequency: string, periodEnd: string) {
  if (frequency === "MONTHLY") return true;
  const d = new Date(`${periodEnd}T00:00:00Z`);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return d.getUTCDate() >= Math.min(last, 28) || d.getUTCDate() > 15;
}

export async function createRun(organizationId: string, userId: string, input: RunInput) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (![input.periodStart, input.periodEnd, input.payDate].every((d) => re.test(d))) fail("Enter the period and pay date");
  if (input.periodEnd < input.periodStart) fail("The period ends before it starts");
  const days = (Date.parse(input.periodEnd) - Date.parse(input.periodStart)) / 864e5 + 1;
  if (days > 31) fail("A payroll period can be at most one month");
  if (input.kind === "REGULAR") {
    const overlap = await prisma.payrollRun.findFirst({
      where: { organizationId, kind: "REGULAR", status: { not: "VOID" }, periodStart: { lte: new Date(input.periodEnd) }, periodEnd: { gte: new Date(input.periodStart) } },
    });
    if (overlap) fail(`Payroll ${overlap.number} already covers part of this period`);
  }
  return prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, organizationId, "PR", Number(input.payDate.slice(0, 4)));
    const run = await tx.payrollRun.create({
      data: {
        organizationId, number, kind: input.kind, frequency: input.frequency,
        periodStart: new Date(input.periodStart), periodEnd: new Date(input.periodEnd), payDate: new Date(input.payDate),
        deductContributions: input.kind === "REGULAR" ? (input.deductContributions ?? defaultDeductContributions(input.frequency, input.periodEnd)) : false,
        yearEndAdjustment: !!input.yearEndAdjustment, memo: input.memo?.trim() || null, preparedById: userId,
      },
    });
    await audit(tx, organizationId, userId, "payroll.create", run.id, { number }, null, run, "payroll");
    return run;
  });
}

async function draftRun(organizationId: string, runId: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) fail("Payroll run not found");
  if (run!.status !== "DRAFT") fail("This payroll is no longer a draft. Return it to draft first.");
  return run!;
}

/** Year-to-date and month-to-date figures from finalized payslips, excluding this run. */
async function ytdFor(organizationId: string, employeeId: string, run: { id: string; payDate: Date; periodEnd: Date }): Promise<YearToDate> {
  const y = run.payDate.getUTCFullYear();
  const slips = await prisma.payslip.findMany({
    where: { organizationId, employeeId, runId: { not: run.id }, run: { status: "FINALIZED", payDate: { gte: new Date(`${y}-01-01`), lte: new Date(`${y}-12-31`) } } },
    include: { run: true },
  });
  const ytd: YearToDate = { ...EMPTY_YTD };
  const mStart = new Date(Date.UTC(run.periodEnd.getUTCFullYear(), run.periodEnd.getUTCMonth(), 1));
  const mEnd = new Date(Date.UTC(run.periodEnd.getUTCFullYear(), run.periodEnd.getUTCMonth() + 1, 0));
  for (const s of slips) {
    ytd.ytdTaxable += num(s.taxableIncome); ytd.ytdTax += num(s.withholdingTax);
    ytd.ytdExemptBenefits += num(s.exemptBenefits); ytd.ytd13th += num(s.thirteenthPay);
    if (s.run.kind === "REGULAR") ytd.ytdBasic += num(s.basicPay);
    if (s.run.periodEnd >= mStart && s.run.periodEnd <= mEnd) {
      ytd.monthCompensation += num(s.sssCompensation);
      ytd.monthSssEE += num(s.sssEE); ytd.monthSssER += num(s.sssER); ytd.monthEc += num(s.sssEC);
      ytd.monthMpfEE += num(s.mpfEE); ytd.monthMpfER += num(s.mpfER);
      ytd.monthPhicEE += num(s.phicEE); ytd.monthPhicER += num(s.phicER); ytd.monthHdmfEE += num(s.hdmfEE); ytd.monthHdmfER += num(s.hdmfER);
    }
  }
  for (const k of Object.keys(ytd) as (keyof YearToDate)[]) ytd[k] = round2(ytd[k]);
  return ytd;
}

/** Compute (or recompute) every payslip in a draft run from attendance, pay items and year-to-date figures. */
export async function computeRun(organizationId: string, userId: string, runId: string) {
  const run = await draftRun(organizationId, runId);
  const from = ymd(run.periodStart), to = ymd(run.periodEnd);
  const emps = await prisma.employee.findMany({
    where: {
      organizationId, isPartner: false, basicRate: { gt: 0 },
      AND: [
        { OR: [{ dateHired: null }, { dateHired: { lte: run.periodEnd } }] },
        { OR: [{ separationDate: null }, { separationDate: { gte: run.periodStart } }] },
        { OR: [{ isActive: true }, { separationDate: { gte: run.periodStart } }] },
      ],
    },
    orderBy: { code: "asc" },
  });
  const att = run.kind === "REGULAR" ? await attendanceFor(organizationId, emps.map((e) => e.id), from, to) : new Map();
  const items = await prisma.employeePayItem.findMany({
    where: {
      organizationId, isActive: true, employeeId: { in: emps.map((e) => e.id) },
      OR: [
        { runId: run.id },
        ...(run.kind === "REGULAR" ? [{
          runId: null,
          AND: [{ OR: [{ startDate: null }, { startDate: { lte: run.periodEnd } }] }, { OR: [{ endDate: null }, { endDate: { gte: run.periodStart } }] }],
        }] : []),
      ],
    },
  });
  const depts = await prisma.dimensionValue.findMany({ where: { organizationId, type: { in: ["DEPARTMENT", "COST_CENTER"] } } });
  const slips: Prisma.PayslipCreateManyInput[] = [];
  for (const e of emps) {
    const days = att.get(e.id)?.days ?? [];
    const my: PayItem[] = items.filter((i) => i.employeeId === e.id).map((i) => ({
      itemId: i.id, kind: i.kind as PayItem["kind"], category: i.category, name: i.name, amount: num(i.amount),
      deMinimisCode: i.deMinimisCode, balance: i.balance === null ? null : num(i.balance),
    }));
    const ytd = await ytdFor(organizationId, e.id, run);
    const r = computePayslip(
      { payBasis: e.payBasis === "DAILY" ? "DAILY" : "MONTHLY", basicRate: num(e.basicRate), workDaysPerYear: e.workDaysPerYear, minimumWageEarner: e.minimumWageEarner },
      days, my, ytd,
      { kind: run.kind as "REGULAR", frequency: run.frequency as "SEMI_MONTHLY", deductContributions: run.deductContributions, yearEndAdjustment: run.yearEndAdjustment },
    );
    const deptName = e.department ? depts.find((d) => d.type === "DEPARTMENT" && (d.code === e.department || d.name.toLowerCase() === e.department!.toLowerCase()))?.name ?? e.department : null;
    slips.push(slipData(organizationId, run.id, e, deptName, r, days.length ? { summary: summarize(days), days } : null));
  }
  await prisma.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where: { runId: run.id } });
    if (slips.length) await tx.payslip.createMany({ data: slips });
    await tx.payrollRun.update({ where: { id: run.id }, data: { computedAt: new Date(), returnReason: null } });
    await audit(tx, organizationId, userId, "payroll.compute", run.id, { number: run.number, employees: slips.length }, null, null, "payroll");
  }, { timeout: 60_000 });
  return slips.length;
}

function slipData(organizationId: string, runId: string, e: { id: string; code: string; firstName: string; lastName: string; middleName: string | null; costCenter: string | null; position: string | null; payBasis: string | null; basicRate: Prisma.Decimal; minimumWageEarner: boolean }, department: string | null, r: PayslipResult, attendance: unknown): Prisma.PayslipCreateManyInput {
  const j = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
  return {
    organizationId, runId, employeeId: e.id, employeeCode: e.code, employeeName: employeeName(e), department, costCenter: e.costCenter, position: e.position,
    payBasis: e.payBasis === "DAILY" ? "DAILY" : "MONTHLY", basicRate: e.basicRate, dailyRate: dec(r.dailyRate), hourlyRate: new Prisma.Decimal(r.hourlyRate.toFixed(4)),
    minimumWageEarner: e.minimumWageEarner, attendance: attendance ? j(attendance) : Prisma.JsonNull,
    earnings: j(r.earnings), deductions: j(r.deductions), employer: j(r.employer),
    gross: dec(r.gross), basicPay: dec(r.basicPay), sssCompensation: dec(r.sssCompensation), taxableEarnings: dec(r.taxableEarnings), nonTaxable: dec(r.nonTaxable),
    exemptBenefits: dec(r.exemptBenefitsUsed), thirteenthPay: dec(r.earnings.filter((l) => l.group === "THIRTEENTH").reduce((n, l) => n + l.amount, 0)),
    sssEE: dec(r.sss.ee), sssER: dec(r.sss.er), sssEC: dec(r.sss.ec), mpfEE: dec(r.sss.mpfEE), mpfER: dec(r.sss.mpfER),
    phicEE: dec(r.philhealth.ee), phicER: dec(r.philhealth.er), hdmfEE: dec(r.pagibig.ee), hdmfER: dec(r.pagibig.er),
    taxableIncome: dec(r.taxableIncome), withholdingTax: dec(r.withholdingTax), otherDeductions: dec(r.otherDeductions),
    netPay: dec(r.netPay), employerCost: dec(r.employerCost), warnings: r.warnings.length ? r.warnings : Prisma.JsonNull,
  };
}

/** One-off earning/deduction for one employee in a draft run (bonus, commission, adjustment). */
export async function addRunAdjustment(organizationId: string, userId: string, runId: string, input: { employeeId: string; kind: string; category: string; name: string; amount: string; deMinimisCode?: string | null }) {
  await draftRun(organizationId, runId);
  const amt = Number(input.amount);
  if (!(amt > 0)) fail("Enter an amount greater than zero");
  if (!["EARNING", "DEDUCTION", "EMPLOYER"].includes(input.kind)) fail("Choose earning or deduction");
  if (!input.name.trim()) fail("Enter a description");
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, organizationId } });
  if (!emp) fail("Choose the employee");
  return prisma.$transaction(async (tx) => {
    const it = await tx.employeePayItem.create({
      data: { organizationId, employeeId: emp!.id, runId, kind: input.kind, category: input.category, name: input.name.trim(), amount: dec(amt), deMinimisCode: input.deMinimisCode || null },
    });
    await audit(tx, organizationId, userId, "payroll.adjustment", runId, { employee: emp!.code, name: it.name, amount: amt }, null, it, "payroll");
    return it;
  });
}

export async function deleteRunAdjustment(organizationId: string, userId: string, runId: string, itemId: string) {
  await draftRun(organizationId, runId);
  await prisma.$transaction(async (tx) => {
    const it = await tx.employeePayItem.findFirst({ where: { id: itemId, organizationId, runId } });
    if (!it) fail("Adjustment not found");
    await tx.employeePayItem.delete({ where: { id: itemId } });
    await audit(tx, organizationId, userId, "payroll.adjustment_delete", runId, { name: it!.name }, it, null, "payroll");
  });
}

/** Recurring allowance, loan or employer benefit for an employee. */
export async function savePayItem(organizationId: string, userId: string, input: { id?: string; employeeId: string; kind: string; category: string; name: string; amount: string; balance?: string; deMinimisCode?: string | null; startDate?: string; endDate?: string; isActive?: boolean }) {
  const amt = Number(input.amount);
  if (!(amt > 0)) fail("Enter the amount per payroll");
  if (!input.name.trim()) fail("Enter a description");
  const bal = input.balance?.trim() ? Number(input.balance) : null;
  if (bal !== null && !(bal >= 0)) fail("Enter a valid balance");
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, organizationId } });
  if (!emp) fail("Employee not found");
  const data = {
    kind: input.kind, category: input.category, name: input.name.trim(), amount: dec(amt), balance: bal === null ? null : dec(bal),
    deMinimisCode: input.category === "DE_MINIMIS" ? input.deMinimisCode || null : null,
    startDate: input.startDate ? new Date(input.startDate) : null, endDate: input.endDate ? new Date(input.endDate) : null, isActive: input.isActive ?? true,
  };
  return prisma.$transaction(async (tx) => {
    const before = input.id ? await tx.employeePayItem.findFirst({ where: { id: input.id, organizationId, runId: null } }) : null;
    if (input.id && !before) fail("Pay item not found");
    const it = before ? await tx.employeePayItem.update({ where: { id: before.id }, data }) : await tx.employeePayItem.create({ data: { ...data, organizationId, employeeId: emp!.id } });
    await audit(tx, organizationId, userId, "payitem.save", it.id, { employee: emp!.code }, before, it, "payitem");
    return it;
  });
}

export async function setReviewed(organizationId: string, userId: string, runId: string, payslipIds: string[] | "all", reviewed: boolean) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) fail("Payroll run not found");
  if (!["DRAFT", "FOR_REVIEW"].includes(run!.status)) fail("This payroll is already finalized");
  await prisma.payslip.updateMany({ where: { runId, ...(payslipIds === "all" ? {} : { id: { in: payslipIds } }) }, data: { reviewed } });
  await prisma.$transaction((tx) => audit(tx, organizationId, userId, reviewed ? "payroll.review" : "payroll.unreview", runId, { count: payslipIds === "all" ? "all" : payslipIds.length }, null, null, "payroll"));
}

export async function submitRun(organizationId: string, userId: string, runId: string) {
  const run = await draftRun(organizationId, runId);
  const n = await prisma.payslip.count({ where: { runId } });
  if (!run.computedAt || n === 0) fail("Compute the payroll first");
  await prisma.$transaction(async (tx) => {
    await tx.payrollRun.update({ where: { id: runId }, data: { status: "FOR_REVIEW", submittedById: userId, submittedAt: new Date() } });
    await audit(tx, organizationId, userId, "payroll.submit", runId, { number: run.number }, null, null, "payroll");
  });
}

export async function returnRun(organizationId: string, userId: string, runId: string, reason: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) fail("Payroll run not found");
  if (run!.status !== "FOR_REVIEW") fail("Only a payroll for review can be returned");
  if (!reason.trim()) fail("Enter the reason for returning it");
  await prisma.$transaction(async (tx) => {
    await tx.payrollRun.update({ where: { id: runId }, data: { status: "DRAFT", returnReason: reason.trim() } });
    await tx.payslip.updateMany({ where: { runId }, data: { reviewed: false } });
    await audit(tx, organizationId, userId, "payroll.return", runId, { reason }, null, null, "payroll");
  });
}

type SlipRow = Awaited<ReturnType<typeof prisma.payslip.findMany>>[number];

/** Journal lines for the payroll accrual: expenses by department / cost center, liabilities by type, net pay per employee. */
export async function accrualLines(tx: Tx, organizationId: string, slips: SlipRow[], roles: Map<string, string>) {
  const dims = await tx.dimensionValue.findMany({ where: { organizationId, type: { in: ["DEPARTMENT", "COST_CENTER"] } } });
  const emps = await tx.employee.findMany({ where: { id: { in: slips.map((s) => s.employeeId) } } });
  const dimFor = (e: (typeof emps)[number] | undefined) => {
    const dep = e?.department ? dims.find((d) => d.type === "DEPARTMENT" && (d.code === e.department || d.name.toLowerCase() === e.department!.toLowerCase())) : undefined;
    const cc = e?.costCenter ? dims.find((d) => d.type === "COST_CENTER" && d.code === e.costCenter) : undefined;
    return { departmentId: dep?.id ?? null, costCenterId: cc?.id ?? null };
  };
  const acc = new Map<string, { role: string; amount: number; dims?: { departmentId: string | null; costCenterId: string | null }; party?: string; description: string }>();
  const put = (key: string, role: string, amount: number, description: string, extra: { dims?: { departmentId: string | null; costCenterId: string | null }; party?: string } = {}) => {
    const cur = acc.get(key) ?? { role, amount: 0, description, ...extra };
    cur.amount = round2(cur.amount + amount);
    acc.set(key, cur);
  };
  for (const s of slips) {
    const e = emps.find((x) => x.id === s.employeeId);
    const d = dimFor(e);
    const dk = `${d.departmentId}|${d.costCenterId}`;
    for (const l of s.earnings as unknown as Line[]) {
      const role = EARNING_ROLE[l.group ?? "BASIC"];
      put(`E|${role}|${dk}`, role, l.amount, `Payroll - ${role === "SALARIES_EXPENSE" ? "salaries and wages" : role.replace(/_EXPENSE$/, "").toLowerCase().replace(/_/g, " ")}`, { dims: d });
    }
    for (const l of s.employer as unknown as Line[]) {
      const expRole = l.role === "BENEFITS_EXPENSE" || l.role === "RETIREMENT_EXPENSE" ? l.role : "GOVT_CONTRIB_EXPENSE";
      const liab = l.role === "BENEFITS_EXPENSE" || l.role === "RETIREMENT_EXPENSE" ? "ACCRUED_BENEFITS" : l.role!;
      put(`E|${expRole}|${dk}`, expRole, l.amount, expRole === "GOVT_CONTRIB_EXPENSE" ? "Payroll - employer SSS, PhilHealth, Pag-IBIG" : "Payroll - employee benefits", { dims: d });
      put(`L|${liab}`, liab, -l.amount, liabLabel(liab));
    }
    for (const l of s.deductions as unknown as Line[]) {
      const role = l.role ?? "OTHER_PAYROLL_DEDUCTIONS";
      // Company loans reduce the employee's advance (asset), tagged to the employee.
      if (role === "EMPLOYEE_ADVANCES") put(`A|${role}|${s.employeeCode}`, role, -l.amount, `Loan / advance repayment - ${s.employeeName}`, { party: s.employeeCode });
      else put(`L|${role}`, role, -l.amount, liabLabel(role));
    }
    put(`N|${s.employeeCode}`, "SALARIES_PAYABLE", -num(s.netPay), `Net pay - ${s.employeeName}`, { party: s.employeeCode });
  }
  const lines: LineInput[] = [];
  for (const v of acc.values()) {
    if (v.amount === 0) continue;
    lines.push({
      accountId: roles.get(v.role)!, description: v.description,
      debit: v.amount > 0 ? v.amount.toFixed(2) : null, credit: v.amount < 0 ? (-v.amount).toFixed(2) : null,
      partyType: v.party ? "EMPLOYEE" : null, partyId: v.party ?? null,
      dims: v.dims ? { departmentId: v.dims.departmentId, costCenterId: v.dims.costCenterId } : undefined,
    });
  }
  return lines;
}
const liabLabel = (r: string) => ({
  SSS_PAYABLE: "SSS contributions payable (EE + ER + EC)", PHIC_PAYABLE: "PhilHealth contributions payable", HDMF_PAYABLE: "Pag-IBIG contributions payable",
  WTC_PAYABLE: "Withholding tax on compensation (1601-C)", GOVT_LOANS_PAYABLE: "SSS / Pag-IBIG loan amortizations", OTHER_PAYROLL_DEDUCTIONS: "Other payroll deductions",
  ACCRUED_BENEFITS: "Accrued HMO / retirement / insurance",
} as Record<string, string>)[r] ?? r;

/** Reviewer approves: posts the payroll accrual to the GL and reduces loan balances. */
export async function finalizeRun(organizationId: string, userId: string, runId: string) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.payrollRun.findFirst({ where: { id: runId, organizationId } });
    if (!run) fail("Payroll run not found");
    if (run!.status !== "FOR_REVIEW") fail("Submit the payroll for review first");
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (org.segregationOfDuties && (run!.preparedById === userId || run!.submittedById === userId))
      fail("Segregation of duties: someone other than the preparer must review and finalize this payroll");
    const slips = await tx.payslip.findMany({ where: { runId } });
    if (!slips.length) fail("There are no payslips in this payroll");
    const notReviewed = slips.filter((s) => !s.reviewed).length;
    if (notReviewed) fail(`${notReviewed} payslip(s) are not yet marked reviewed`);
    const negative = slips.filter((s) => num(s.netPay) < 0);
    if (negative.length) fail(`Net pay is negative for ${negative.map((s) => s.employeeCode).join(", ")}`);
    const roles = await ensurePayrollAccounts(tx, organizationId);
    const lines = await accrualLines(tx, organizationId, slips, roles);
    const je = await recordJournalTx(tx, {
      organizationId, userId, date: run!.periodEnd, transactionDate: run!.payDate, source: "PAYROLL", sourceId: run!.id, action: "post",
      memo: `Payroll ${run!.number} for ${ymd(run!.periodStart)} to ${ymd(run!.periodEnd)}`, reference: run!.number, lines,
    });
    // Loans: reduce the remaining balance by what was deducted.
    for (const s of slips) for (const l of s.deductions as unknown as Line[]) {
      if (!l.itemId) continue;
      const it = await tx.employeePayItem.findUnique({ where: { id: l.itemId } });
      if (it && it.balance !== null) await tx.employeePayItem.update({ where: { id: it.id }, data: { balance: dec(Math.max(0, num(it.balance) - l.amount)), isActive: num(it.balance) - l.amount > 0.004 ? it.isActive : false } });
    }
    const after = await tx.payrollRun.update({ where: { id: runId }, data: { status: "FINALIZED", finalizedById: userId, finalizedAt: new Date(), journalEntryId: je.id } });
    await audit(tx, organizationId, userId, "payroll.finalize", runId, { number: run!.number, journal: je.number }, run, after, "payroll");
    return { run: after, journal: je };
  }, { timeout: 60_000 });
}

/** Make the finalized payslips visible to employees in the portal. */
export async function releasePayslips(organizationId: string, userId: string, runId: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) fail("Payroll run not found");
  if (run!.status !== "FINALIZED") fail("Finalize the payroll before releasing payslips");
  if (run!.releasedAt) fail("Payslips were already released");
  await prisma.$transaction(async (tx) => {
    await tx.payrollRun.update({ where: { id: runId }, data: { releasedAt: new Date(), releasedById: userId } });
    await audit(tx, organizationId, userId, "payroll.release", runId, { number: run!.number }, null, null, "payroll");
  });
}

/** Salary payment: Dr Salaries payable (per employee) / Cr bank. */
export async function recordPayment(organizationId: string, userId: string, runId: string, bankAccountId: string, date: string) {
  return prisma.$transaction(async (tx) => {
    const run = await tx.payrollRun.findFirst({ where: { id: runId, organizationId } });
    if (!run) fail("Payroll run not found");
    if (run!.status !== "FINALIZED") fail("Finalize the payroll first");
    if (run!.paymentEntryId) fail("Payment was already recorded");
    const bank = await tx.bankAccount.findFirst({ where: { id: bankAccountId, organizationId, isActive: true } });
    if (!bank) fail("Choose the bank account the salaries are paid from");
    if (bank!.currencyCode !== "PHP") fail("Pay salaries from a peso account");
    const roles = await ensurePayrollAccounts(tx, organizationId);
    const slips = await tx.payslip.findMany({ where: { runId }, orderBy: { employeeCode: "asc" } });
    const total = round2(slips.reduce((n, s) => n + num(s.netPay), 0));
    const lines: LineInput[] = slips.filter((s) => num(s.netPay) > 0).map((s) => ({
      accountId: roles.get("SALARIES_PAYABLE")!, debit: num(s.netPay).toFixed(2), description: `Net pay - ${s.employeeName}`, partyType: "EMPLOYEE", partyId: s.employeeCode,
    }));
    lines.push({ accountId: bank!.glAccountId, credit: total.toFixed(2), description: `Payroll ${run!.number} salary credit` });
    const je = await recordJournalTx(tx, {
      organizationId, userId, date: new Date(date || ymd(run!.payDate)), source: "PAYROLL", sourceId: `${run!.id}:payment`, action: "post",
      memo: `Salary payment - payroll ${run!.number}`, reference: run!.number, lines,
    });
    await tx.payrollRun.update({ where: { id: runId }, data: { paidAt: new Date(), paymentEntryId: je.id, paymentBankAccountId: bank!.id } });
    await audit(tx, organizationId, userId, "payroll.pay", runId, { journal: je.number, total }, null, null, "payroll");
    return je;
  });
}

/** Void a run. A finalized run's GL entries (accrual and payment) are reversed and loan balances restored. */
export async function voidRun(organizationId: string, userId: string, runId: string, reason: string) {
  if (!reason.trim()) fail("Enter the reason for voiding");
  return prisma.$transaction(async (tx) => {
    const run = await tx.payrollRun.findFirst({ where: { id: runId, organizationId } });
    if (!run) fail("Payroll run not found");
    if (run!.status === "VOID") fail("Already void");
    if (run!.releasedAt) fail("Payslips were already released to employees. Correct it in the next payroll instead.");
    if (run!.status === "FINALIZED") {
      if (run!.paymentEntryId) await voidOrReverseTx(tx, organizationId, userId, run!.paymentEntryId, undefined, true);
      if (run!.journalEntryId) await voidOrReverseTx(tx, organizationId, userId, run!.journalEntryId, undefined, true);
      const slips = await tx.payslip.findMany({ where: { runId } });
      for (const s of slips) for (const l of s.deductions as unknown as Line[]) {
        if (!l.itemId) continue;
        const it = await tx.employeePayItem.findUnique({ where: { id: l.itemId } });
        if (it && it.balance !== null) await tx.employeePayItem.update({ where: { id: it.id }, data: { balance: dec(num(it.balance) + l.amount), isActive: true } });
      }
    }
    await tx.payrollRun.update({ where: { id: runId }, data: { status: "VOID", returnReason: reason.trim() } });
    await audit(tx, organizationId, userId, "payroll.void", runId, { reason }, null, null, "payroll");
  }, { timeout: 60_000 });
}

export const RUN_KIND_LABEL: Record<string, string> = { REGULAR: "Regular payroll", THIRTEENTH_MONTH: "13th month pay", SPECIAL: "Special (bonus / adjustment)" };
export const RUN_STATUS_LABEL: Record<string, string> = { DRAFT: "DRAFT", FOR_REVIEW: "FOR REVIEW", FINALIZED: "FINALIZED", VOID: "VOID" };
