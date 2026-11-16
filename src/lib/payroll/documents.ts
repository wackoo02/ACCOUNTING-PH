// Builds the payroll and HR PDFs from the database.
import { prisma } from "../db";
import { LedgerError } from "../ledger/service";
import { attendanceFor, employeeName, leaveBalances, ymd, REQUEST_TYPES } from "../hr/service";
import { fmtClock, manilaMinutes, summarize } from "./attendance";
import type { Line } from "./compute";
import type { Form2316Data } from "./bir2316";
import { compute2316 } from "./bir2316";
import { Doc, peso } from "./pdf";
import { RUN_KIND_LABEL } from "./service";

const num = (d: unknown) => (d ? Number(d) : 0);
const sum = <T,>(xs: T[], f: (x: T) => number) => Math.round(xs.reduce((n, x) => n + f(x), 0) * 100) / 100;
const fail = (m: string): never => { throw new LedgerError([m]); };
async function orgName(id: string) { return (await prisma.organization.findUniqueOrThrow({ where: { id } })); }

// ---------- Payslips ----------

export async function payslipsPdf(organizationId: string, runId: string, employeeId?: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) fail("Payroll run not found");
  const org = await orgName(organizationId);
  const slips = await prisma.payslip.findMany({ where: { runId, ...(employeeId ? { employeeId } : {}) }, orderBy: { employeeCode: "asc" } });
  const doc = await Doc.create({ company: org.name, title: "PAYSLIP", subtitle: `${RUN_KIND_LABEL[run!.kind]} ${run!.number} · Period ${ymd(run!.periodStart)} to ${ymd(run!.periodEnd)} · Pay date ${ymd(run!.payDate)}${run!.status !== "FINALIZED" ? " · DRAFT - NOT FINAL" : ""}` });
  slips.forEach((s, i) => {
    if (i > 0) doc.addPage();
    doc.fields([
      ["Employee", `${s.employeeName} (${s.employeeCode})`], ["Position", s.position ?? ""],
      ["Department", s.department ?? ""], ["Pay basis", `${s.payBasis === "DAILY" ? "Daily" : "Monthly"} ${peso(num(s.basicRate))}`],
      ["Daily rate", peso(num(s.dailyRate))], ["Hourly rate", peso(num(s.hourlyRate))],
    ]);
    const att = s.attendance as { summary?: ReturnType<typeof summarize> } | null;
    if (att?.summary) {
      const a = att.summary;
      doc.text(`Attendance: ${a.daysWorked} day(s) worked, ${a.absences} absent, ${a.paidLeaveDays} paid leave, ${a.unpaidLeaveDays} unpaid leave, late/undertime ${a.lateMinutes + a.undertimeMinutes} min, OT ${(a.otMinutes / 60).toFixed(2)} hr, night ${(a.nightMinutes / 60).toFixed(2)} hr`, { size: 8, color: undefined });
    }
    doc.space(4);
    const earn = s.earnings as unknown as Line[], ded = s.deductions as unknown as Line[];
    doc.table([{ header: "Earnings", width: 5 }, { header: "Hours / days", width: 1.6, align: "right" }, { header: "Amount", width: 1.8, align: "right" }],
      [...earn.map((l) => [l.label + (l.taxable === false ? " (non-taxable)" : ""), l.qty !== undefined ? `${l.qty} ${l.unit ?? ""}` : "", l.amount]), ["**Gross pay", "", num(s.gross)]]);
    doc.table([{ header: "Deductions", width: 6.6 }, { header: "Amount", width: 1.8, align: "right" }],
      [...ded.map((l) => [l.label, l.amount]), ["**Total deductions", sum(ded, (l) => l.amount)]]);
    doc.table([{ header: "NET PAY", width: 6.6 }, { header: "", width: 1.8, align: "right" }], [["**Net pay", num(s.netPay)]], { size: 10 });
    doc.text(`Taxable compensation this pay: ${peso(num(s.taxableIncome))} · Non-taxable: ${peso(num(s.nonTaxable))} · Employer share: SSS ${peso(num(s.sssER) + num(s.mpfER) + num(s.sssEC))}, PhilHealth ${peso(num(s.phicER))}, Pag-IBIG ${peso(num(s.hdmfER))}`, { size: 7.5 });
    doc.signatures(["Prepared by", "Approved by", "Received by (employee)"]);
  });
  if (!slips.length) doc.text("No payslips.");
  return doc.bytes();
}

// ---------- Payroll register ----------

export async function registerPdf(organizationId: string, runId: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId } });
  if (!run) fail("Payroll run not found");
  const org = await orgName(organizationId);
  const slips = await prisma.payslip.findMany({ where: { runId }, orderBy: [{ department: "asc" }, { employeeCode: "asc" }] });
  const doc = await Doc.create({ landscape: true, company: org.name, title: "PAYROLL REGISTER", subtitle: `${run!.number} · ${RUN_KIND_LABEL[run!.kind]} · ${ymd(run!.periodStart)} to ${ymd(run!.periodEnd)} · pay date ${ymd(run!.payDate)} · status ${run!.status}` });
  const g = (s: (typeof slips)[number], groups: string[]) => sum((s.earnings as unknown as Line[]).filter((l) => groups.includes(l.group ?? "")), (l) => l.amount);
  const cols = [
    { header: "Employee", width: 3.2 }, { header: "Dept", width: 1.4 }, { header: "Basic", width: 1.3 }, { header: "OT", width: 1 }, { header: "Hol/ND", width: 1 },
    { header: "Allow./Other", width: 1.2 }, { header: "Gross", width: 1.3 }, { header: "SSS", width: 1 }, { header: "PHIC", width: 1 }, { header: "HDMF", width: 0.9 },
    { header: "W/Tax", width: 1.1 }, { header: "Loans/Other", width: 1.1 }, { header: "Net pay", width: 1.3 }, { header: "ER share", width: 1.1 },
  ];
  const row = (s: (typeof slips)[number]) => [
    `${s.employeeCode} ${s.employeeName}`, s.department ?? "", g(s, ["BASIC"]), g(s, ["OVERTIME"]), g(s, ["PREMIUM", "NIGHT_DIFF"]),
    g(s, ["ALLOWANCE", "BONUS", "COMMISSION", "THIRTEENTH"]), num(s.gross), num(s.sssEE) + num(s.mpfEE), num(s.phicEE), num(s.hdmfEE),
    num(s.withholdingTax), num(s.otherDeductions), num(s.netPay), num(s.employerCost),
  ];
  const rows = slips.map(row) as (string | number)[][];
  const tot: (string | number)[] = ["**TOTAL", `${slips.length} employees`];
  for (let i = 2; i < cols.length; i++) tot.push(Math.round(rows.reduce((n, r) => n + (r[i] as number), 0) * 100) / 100);
  doc.table(cols, [...rows, tot], { size: 7 });
  doc.signatures(["Prepared by", "Reviewed and finalized by", "Approved for payment"]);
  return doc.bytes();
}

// ---------- Period reports ----------

async function finalizedSlips(organizationId: string, from: string, to: string) {
  return prisma.payslip.findMany({
    where: { organizationId, run: { status: "FINALIZED", payDate: { gte: new Date(from), lte: new Date(to) } } },
    include: { run: true }, orderBy: [{ department: "asc" }, { employeeCode: "asc" }],
  });
}

export async function laborCostPdf(organizationId: string, from: string, to: string) {
  const org = await orgName(organizationId);
  const slips = await finalizedSlips(organizationId, from, to);
  const doc = await Doc.create({ company: org.name, title: "LABOR COST BY DEPARTMENT", subtitle: `Finalized payrolls paid ${from} to ${to}` });
  const by = new Map<string, { heads: Set<string>; gross: number; ot: number; er: number }>();
  for (const s of slips) {
    const k = `${s.department ?? "(no department)"}${s.costCenter ? ` / ${s.costCenter}` : ""}`;
    const v = by.get(k) ?? { heads: new Set(), gross: 0, ot: 0, er: 0 };
    v.heads.add(s.employeeId); v.gross += num(s.gross); v.er += num(s.employerCost);
    v.ot += sum((s.earnings as unknown as Line[]).filter((l) => l.group === "OVERTIME"), (l) => l.amount);
    by.set(k, v);
  }
  const rows = [...by.entries()].map(([k, v]) => [k, String(v.heads.size), v.gross - v.ot, v.ot, v.er, v.gross + v.er]);
  rows.push(["**TOTAL", String(new Set(slips.map((s) => s.employeeId)).size), sum(rows, (r) => r[2] as number), sum(rows, (r) => r[3] as number), sum(rows, (r) => r[4] as number), sum(rows, (r) => r[5] as number)]);
  doc.table([{ header: "Department / cost center", width: 4 }, { header: "Headcount", width: 1, align: "right" }, { header: "Salaries & allowances", width: 1.8 }, { header: "Overtime", width: 1.4 }, { header: "Employer contributions & benefits", width: 2 }, { header: "Total labor cost", width: 1.8 }], rows);
  return doc.bytes();
}

export async function taxReportPdf(organizationId: string, from: string, to: string) {
  const org = await orgName(organizationId);
  const slips = await finalizedSlips(organizationId, from, to);
  const doc = await Doc.create({ landscape: true, company: org.name, title: "WITHHOLDING TAX AND STATUTORY CONTRIBUTIONS", subtitle: `Finalized payrolls paid ${from} to ${to} · basis for BIR 1601-C and SSS / PhilHealth / Pag-IBIG remittances · TIN ${org.tin ?? "-"}` });
  const emps = await prisma.employee.findMany({ where: { id: { in: [...new Set(slips.map((s) => s.employeeId))] } } });
  const by = new Map<string, (typeof slips)>();
  for (const s of slips) by.set(s.employeeId, [...(by.get(s.employeeId) ?? []), s]);
  const rows = [...by.entries()].map(([id, ss]) => {
    const e = emps.find((x) => x.id === id)!;
    return [`${e.code} ${employeeName(e)}`, e.tin ?? "", sum(ss, (s) => num(s.gross)), sum(ss, (s) => num(s.nonTaxable)), sum(ss, (s) => num(s.taxableIncome)), sum(ss, (s) => num(s.withholdingTax)),
      sum(ss, (s) => num(s.sssEE) + num(s.mpfEE)), sum(ss, (s) => num(s.sssER) + num(s.mpfER) + num(s.sssEC)), sum(ss, (s) => num(s.phicEE)), sum(ss, (s) => num(s.phicER)), sum(ss, (s) => num(s.hdmfEE)), sum(ss, (s) => num(s.hdmfER))];
  });
  const tot: (string | number)[] = ["**TOTAL", ""];
  for (let i = 2; i < 12; i++) tot.push(sum(rows, (r) => r[i] as number));
  doc.table([
    { header: "Employee", width: 3 }, { header: "TIN", width: 1.6 }, { header: "Gross comp.", width: 1.3 }, { header: "Non-taxable", width: 1.2 }, { header: "Taxable comp.", width: 1.3 },
    { header: "Tax withheld", width: 1.2 }, { header: "SSS EE", width: 1 }, { header: "SSS ER+EC", width: 1.1 }, { header: "PHIC EE", width: 1 }, { header: "PHIC ER", width: 1 }, { header: "HDMF EE", width: 1 }, { header: "HDMF ER", width: 1 },
  ], [...rows, tot], { size: 7 });
  doc.space(6);
  doc.text("Remittance summary", { size: 10, font: doc.bold });
  doc.table([{ header: "Agency / form", width: 5 }, { header: "Employee share", width: 2 }, { header: "Employer share", width: 2 }, { header: "Total to remit", width: 2 }], [
    ["BIR 1601-C - withholding tax on compensation", tot[5] as number, 0, tot[5] as number],
    ["SSS (incl. MPF and EC)", tot[6] as number, tot[7] as number, (tot[6] as number) + (tot[7] as number)],
    ["PhilHealth", tot[8] as number, tot[9] as number, (tot[8] as number) + (tot[9] as number)],
    ["Pag-IBIG (HDMF)", tot[10] as number, tot[11] as number, (tot[10] as number) + (tot[11] as number)],
  ]);
  return doc.bytes();
}

export async function earningsSummaryPdf(organizationId: string, year: number) {
  const org = await orgName(organizationId);
  const slips = await finalizedSlips(organizationId, `${year}-01-01`, `${year}-12-31`);
  const doc = await Doc.create({ landscape: true, company: org.name, title: "EMPLOYEE EARNINGS SUMMARY", subtitle: `Year ${year}, finalized payrolls` });
  const by = new Map<string, (typeof slips)>();
  for (const s of slips) by.set(s.employeeId, [...(by.get(s.employeeId) ?? []), s]);
  const g = (ss: typeof slips, groups: string[]) => sum(ss, (s) => sum((s.earnings as unknown as Line[]).filter((l) => groups.includes(l.group ?? "")), (l) => l.amount));
  const rows = [...by.values()].map((ss) => [`${ss[0].employeeCode} ${ss[0].employeeName}`, ss[0].department ?? "", g(ss, ["BASIC"]), g(ss, ["OVERTIME"]), g(ss, ["PREMIUM", "NIGHT_DIFF"]), g(ss, ["ALLOWANCE", "COMMISSION"]), g(ss, ["BONUS", "THIRTEENTH"]), sum(ss, (s) => num(s.gross)), sum(ss, (s) => num(s.withholdingTax)), sum(ss, (s) => num(s.netPay))]);
  const tot: (string | number)[] = ["**TOTAL", ""];
  for (let i = 2; i < 10; i++) tot.push(sum(rows, (r) => r[i] as number));
  doc.table([{ header: "Employee", width: 3.2 }, { header: "Department", width: 1.6 }, { header: "Basic", width: 1.3 }, { header: "Overtime", width: 1.1 }, { header: "Holiday/ND", width: 1.1 }, { header: "Allowances/comm.", width: 1.3 }, { header: "13th/bonus", width: 1.2 }, { header: "Gross", width: 1.3 }, { header: "Tax withheld", width: 1.2 }, { header: "Net pay", width: 1.3 }], [...rows, tot], { size: 7 });
  return doc.bytes();
}

// ---------- BIR 2316 ----------

export async function form2316Pdf(organizationId: string, employeeId: string, year: number, stored?: Form2316Data | null, status = "DRAFT") {
  const d = stored ?? await compute2316(organizationId, employeeId, year);
  const doc = await Doc.create({ company: "BIR Form No. 2316", title: "CERTIFICATE OF COMPENSATION PAYMENT / TAX WITHHELD", subtitle: `For compensation payment with or without tax withheld · For the year ${year} · ${status === "DRAFT" ? "DRAFT - FOR REVIEW" : status}` });
  doc.text("Part I - Employee Information", { size: 10, font: doc.bold });
  doc.fields([["3 TIN", d.employee.tin ?? ""], ["4 Employee's name", d.employee.name], ["6 Registered address", d.employee.address ?? ""], ["7 Date of birth", d.employee.birthDate ?? ""],
    ["2 Period (from - to)", `${d.employee.periodFrom} to ${d.employee.periodTo}`], ["8 Minimum wage earner", d.employee.mwe ? "Yes" : "No"]]);
  doc.text("Part II - Employer Information (Present)", { size: 10, font: doc.bold });
  doc.fields([["13 TIN", d.employer.tin ?? ""], ["14 Employer's name", d.employer.name], ["15 Registered address", d.employer.address ?? ""], ["Type", "Main employer"]]);
  doc.text("Part IV-A - Summary", { size: 10, font: doc.bold });
  doc.table([{ header: "Item", width: 7 }, { header: "Amount", width: 2, align: "right" }], [
    ["19 Gross compensation income from present employer", d.i19_gross], ["20 Less: total non-taxable / exempt compensation (item 36)", d.i20_lessNonTax],
    ["21 Taxable compensation income from present employer (item 50)", d.i21_taxablePresent], ["22 Add: taxable compensation income from previous employer", d.i22_taxablePrevious],
    ["23 Gross taxable compensation income", d.i23_grossTaxable], ["24 Tax due", d.i24_taxDue],
    ["25A Amount of taxes withheld - present employer", d.i25a_withheldPresent], ["25B Amount of taxes withheld - previous employer", d.i25b_withheldPrevious],
    ["**26 Total amount of taxes withheld as adjusted", d.i26_totalWithheld],
  ]);
  doc.text("Part IV-B - Details of compensation income and tax withheld from present employer", { size: 10, font: doc.bold });
  doc.table([{ header: "A. Non-taxable / exempt compensation income", width: 7 }, { header: "Amount", width: 2, align: "right" }], [
    ["27 Basic salary / statutory minimum wage (MWE)", d.i27_basicSmw], ["28 Holiday pay (MWE)", d.i28_holidayMwe], ["29 Overtime pay (MWE)", d.i29_otMwe],
    ["30 Night shift differential (MWE)", d.i30_ndMwe], ["31 Hazard pay (MWE)", d.i31_hazardMwe], ["32 13th month pay and other benefits (max P90,000)", d.i32_13thExempt],
    ["33 De minimis benefits", d.i33_deMinimis], ["34 SSS, GSIS, PHIC and Pag-IBIG contributions and union dues (employee share)", d.i34_contributions],
    ["35 Salaries and other forms of compensation", d.i35_otherNonTax], ["**36 Total non-taxable / exempt compensation income", d.i36_totalNonTax],
  ]);
  doc.table([{ header: "B. Taxable compensation income regular", width: 7 }, { header: "Amount", width: 2, align: "right" }], [
    ["37 Basic salary (net of employee contributions)", d.i37_basic], ["42 Others - taxable allowances", d.i42_otherAllowances], ["43 Commission", d.i43_commission],
    ["46 Taxable 13th month pay and other benefits", d.i46_13thTaxable], ["48 Overtime pay", d.i48_overtime], ["49 Others - holiday, rest day and night differential pay", d.i49_others],
    ["**50 Total taxable compensation income", d.i50_totalTaxable],
  ]);
  doc.text("I/We declare, under the penalties of perjury, that this certificate has been made in good faith, verified by me/us, and to the best of my/our knowledge and belief, is true and correct.", { size: 7 });
  doc.signatures(["51 Present employer / authorized agent", "Date signed", "53 Employee signature", "Date signed"]);
  doc.text("Generated from finalized payrolls. Transcribe onto the official BIR Form 2316 (or the BIR-approved format) for signing and filing.", { size: 7 });
  return doc.bytes();
}

// ---------- Attendance and leave (admin and managers) ----------

export async function attendancePdf(organizationId: string, employeeIds: string[], from: string, to: string, title = "ATTENDANCE REPORT") {
  const org = await orgName(organizationId);
  const emps = await prisma.employee.findMany({ where: { id: { in: employeeIds }, organizationId }, orderBy: { code: "asc" } });
  const att = await attendanceFor(organizationId, emps.map((e) => e.id), from, to);
  const doc = await Doc.create({ landscape: true, company: org.name, title, subtitle: `${from} to ${to} · approved time, overtime and leave only` });
  const rows = emps.map((e) => {
    const s = summarize(att.get(e.id)!.days);
    return [`${e.code} ${employeeName(e)}`, e.department ?? "", String(s.daysScheduled), String(s.daysWorked), String(s.absences), String(s.paidLeaveDays), String(s.unpaidLeaveDays), String(s.lateMinutes), String(s.undertimeMinutes), (s.otMinutes / 60).toFixed(2), (s.nightMinutes / 60).toFixed(2)];
  });
  doc.table([{ header: "Employee", width: 3.2 }, { header: "Department", width: 1.6 }, { header: "Sched. days", width: 1, align: "right" }, { header: "Worked", width: 1, align: "right" }, { header: "Absent", width: 1, align: "right" }, { header: "Paid leave", width: 1, align: "right" }, { header: "Unpaid leave", width: 1, align: "right" }, { header: "Late (min)", width: 1, align: "right" }, { header: "Undertime (min)", width: 1.1, align: "right" }, { header: "OT (hr)", width: 1, align: "right" }, { header: "Night (hr)", width: 1, align: "right" }], rows, { size: 7.5 });
  if (emps.length <= 3) for (const e of emps) {
    doc.text(`Daily time record - ${e.code} ${employeeName(e)}`, { size: 10, font: doc.bold });
    doc.table([{ header: "Date", width: 1.3 }, { header: "Day type", width: 1.8 }, { header: "Shift", width: 1 }, { header: "In", width: 0.8 }, { header: "Out", width: 0.8 }, { header: "Reg hr", width: 0.8, align: "right" }, { header: "Late", width: 0.7, align: "right" }, { header: "UT", width: 0.7, align: "right" }, { header: "OT hr", width: 0.8, align: "right" }, { header: "ND hr", width: 0.8, align: "right" }, { header: "Remarks", width: 2 }],
      att.get(e.id)!.days.map((d) => [d.date, d.dayType.replace(/_/g, " ").toLowerCase(), d.shiftCode ?? "", d.timeIn ? fmtClock(manilaMinutes(d.date, d.timeIn)) : "", d.timeOut ? fmtClock(manilaMinutes(d.date, d.timeOut)) : "",
        (d.regularMinutes / 60).toFixed(2), String(d.lateMinutes || ""), String(d.undertimeMinutes || ""), d.otMinutes ? (d.otMinutes / 60).toFixed(2) : "", (d.nightMinutes + d.otNightMinutes) ? ((d.nightMinutes + d.otNightMinutes) / 60).toFixed(2) : "",
        !d.employed ? "not employed" : d.leave ? `${d.leave.code}${d.leave.fraction < 1 ? " (half)" : ""}${d.leave.paid ? "" : " unpaid"}` : d.absentDays ? "ABSENT" : ""]), { size: 7 });
  }
  return doc.bytes();
}

export async function leavePdf(organizationId: string, employeeIds: string[], year: number) {
  const org = await orgName(organizationId);
  const emps = await prisma.employee.findMany({ where: { id: { in: employeeIds }, organizationId }, orderBy: { code: "asc" } });
  const doc = await Doc.create({ landscape: true, company: org.name, title: "LEAVE BALANCES AND REQUESTS", subtitle: `Year ${year}` });
  const rows: (string | number)[][] = [];
  for (const e of emps) {
    for (const b of await leaveBalances(organizationId, e.id, year)) {
      if (!b.credits && !b.used && !b.pending) continue;
      rows.push([`${e.code} ${employeeName(e)}`, `${b.code} ${b.name}`, b.tracked ? b.credits.toFixed(2) : "-", b.used.toFixed(2), b.pending.toFixed(2), b.tracked ? b.available.toFixed(2) : "-"]);
    }
  }
  doc.table([{ header: "Employee", width: 3 }, { header: "Leave type", width: 3 }, { header: "Credits", width: 1, align: "right" }, { header: "Used", width: 1, align: "right" }, { header: "Pending", width: 1, align: "right" }, { header: "Available", width: 1, align: "right" }], rows, { size: 7.5 });
  const reqs = await prisma.hrRequest.findMany({ where: { organizationId, employeeId: { in: emps.map((e) => e.id) }, dateFrom: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) } }, include: { employee: true }, orderBy: { dateFrom: "asc" } });
  const lts = new Map((await prisma.leaveType.findMany({ where: { organizationId } })).map((l) => [l.id, l.code]));
  doc.text("Requests", { size: 10, font: doc.bold });
  doc.table([{ header: "No.", width: 1.5 }, { header: "Employee", width: 2.6 }, { header: "Type", width: 1.8 }, { header: "Dates", width: 2 }, { header: "Days / hours", width: 1 }, { header: "Status", width: 1.1 }, { header: "Reason", width: 3 }],
    reqs.map((r) => [r.number, `${r.employee.code} ${employeeName(r.employee)}`, `${REQUEST_TYPES[r.type]}${r.leaveTypeId ? " " + (lts.get(r.leaveTypeId) ?? "") : ""}`, `${ymd(r.dateFrom)}${+r.dateTo !== +r.dateFrom ? " to " + ymd(r.dateTo) : ""}`, r.days ? Number(r.days).toFixed(1) + " d" : r.minutes ? (r.minutes / 60).toFixed(2) + " h" : "", r.status, r.reason]), { size: 7 });
  return doc.bytes();
}
