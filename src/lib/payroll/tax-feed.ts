// Payroll's side of the BIR tax engine: the compensation feed behind 1601-C (monthly withholding on
// compensation), the 1604-C alphalist of employees and BIR 2316 data. Importing this module registers
// the feed (src/lib/tax/types.ts registerCompensationFeed); the tax engine imports it for that reason.
//
// Only FINALIZED payroll runs count, by pay date (BIR counts compensation when paid). Voided runs drop out.
// For the alphalist, a 2316 that payroll already finalized or released is used as frozen; drafts and
// employees without a form are computed live from their payslips.
import { prisma } from "../db";
import { registerCompensationFeed, type Bir2316Data, type CompensationFeed, type CompensationWithholding } from "../tax/types";
import { build2316, paidInYear, summarizeSlips, type Form2316Data, type SlipFigures } from "./bir2316";
import { round2 } from "./rates";

const php = (n: number) => round2(n).toFixed(2);
const s = (n: number | undefined) => php(n ?? 0);

/** Map payroll's 2316 figures onto the tax engine's Bir2316Data. Pure. */
export function toBir2316(employeeId: string, d: Form2316Data, emp: { lastName: string; firstName: string; middleName: string | null; separationDate: Date | null }, extra: { formStatus: string; taxWithheldJanNov: number }): Bir2316Data {
  const year = d.year;
  const separated = !!emp.separationDate && emp.separationDate < new Date(Date.UTC(year, 11, 31)) && emp.separationDate.getUTCFullYear() === year;
  const due = round2(d.i24_taxDue), withheld = round2(d.i26_totalWithheld);
  return {
    employeeId, year, employeeCode: d.employee.code, formStatus: extra.formStatus,
    periodFrom: new Date(`${d.employee.periodFrom}T00:00:00Z`), periodTo: new Date(`${d.employee.periodTo}T00:00:00Z`),
    tin: d.employee.tin, lastName: emp.lastName, firstName: emp.firstName, middleName: emp.middleName,
    address: d.employee.address, birthDate: d.employee.birthDate ? new Date(`${d.employee.birthDate}T00:00:00Z`) : null,
    minimumWageEarner: d.employee.mwe,
    grossCompensation: s(d.i19_gross),
    nonTaxable: {
      basicSmw: s(d.i27_basicSmw), holidayPay: s(d.i28_holidayMwe), overtimePay: s(d.i29_otMwe), nightDiff: s(d.i30_ndMwe), hazardPay: s(d.i31_hazardMwe),
      thirteenthMonthAndOther: s(d.i32_13thExempt), deMinimis: s(d.i33_deMinimis), govContributions: s(d.i34_contributions), salariesOther: s(d.i35_otherNonTax),
    },
    taxable: {
      basic: s(d.i37_basic), others: s(d.i42_otherAllowances), commission: s(d.i43_commission), thirteenthMonthExcess: s(d.i46_13thTaxable),
      overtimePay: s(d.i48_overtime), othersSupplementary: s(d.i49_others),
    },
    taxableFromPreviousEmployer: s(d.i22_taxablePrevious),
    taxDue: php(due), taxWithheldPresent: s(d.i25a_withheldPresent), taxWithheldPrevious: s(d.i25b_withheldPrevious),
    taxWithheldJanNov: php(extra.taxWithheldJanNov),
    separatedDuringYear: separated,
    // RR 2-98 Sec. 2.83.4 / RR 11-2018: purely compensation income from one employer for the whole year,
    // with tax withheld equal to tax due. Veritus has no other-income data, so this is the employer's view.
    substitutedFiling: !separated && !d.i22_taxablePrevious && Math.abs(due - withheld) < 0.005,
  };
}

async function year2316(organizationId: string, year: number): Promise<Bir2316Data[]> {
  const [org, slips, forms] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    prisma.payslip.findMany({ where: paidInYear(organizationId, year), include: { run: { select: { payDate: true } } }, orderBy: { run: { payDate: "asc" } } }),
    prisma.form2316.findMany({ where: { organizationId, year } }),
  ]);
  const byEmp = new Map<string, typeof slips>();
  for (const sl of slips) { const a = byEmp.get(sl.employeeId); if (a) a.push(sl); else byEmp.set(sl.employeeId, [sl]); }
  const formOf = new Map(forms.map((f) => [f.employeeId, f]));
  const emps = await prisma.employee.findMany({ where: { organizationId, id: { in: [...new Set([...byEmp.keys(), ...forms.filter((f) => f.status !== "DRAFT").map((f) => f.employeeId)])] } } });
  const employer = { name: org.name, tin: org.tin, address: org.registeredAddress };
  const dec1 = new Date(Date.UTC(year, 11, 1));
  const out: Bir2316Data[] = [];
  for (const e of emps) {
    const mine = byEmp.get(e.id) ?? [];
    const f = formOf.get(e.id);
    const frozen = f && f.status !== "DRAFT";
    const d = frozen ? (f!.data as unknown as Form2316Data) : build2316(year, e, employer, mine);
    if (!frozen && !mine.length) continue;
    const janNov = summarizeSlips(mine.filter((x) => x.run.payDate < dec1)).i25a_withheldPresent;
    out.push(toBir2316(e.id, d, e, { formStatus: f?.status ?? "NONE", taxWithheldJanNov: Math.min(janNov, d.i26_totalWithheld) }));
  }
  return out.sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
}

type SlipWithRun = SlipFigures & { employeeId: string; run: { id: string; number: string; payDate: Date; journalEntryId: string | null } };

/** Group finalized payslips by month of pay date into 1601-C lines. Pure. */
export function monthlyLines(slips: SlipWithRun[]): CompensationWithholding[] {
  const months = new Map<string, SlipWithRun[]>();
  for (const sl of slips) {
    const k = `${sl.run.payDate.getUTCFullYear()}-${String(sl.run.payDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const a = months.get(k); if (a) a.push(sl); else months.set(k, [sl]);
  }
  const out: CompensationWithholding[] = [];
  for (const [k, ms] of [...months.entries()].sort()) {
    const f = summarizeSlips(ms);
    // Item 23: non-MWE employees with no tax withheld for the month (annual taxable pay within the 0% bracket).
    const perEmp = new Map<string, SlipWithRun[]>();
    for (const sl of ms) { const a = perEmp.get(sl.employeeId); if (a) a.push(sl); else perEmp.set(sl.employeeId, [sl]); }
    let notWithheld = 0;
    for (const es of perEmp.values()) {
      const ef = summarizeSlips(es);
      if (!es.some((x) => x.minimumWageEarner) && ef.i25a_withheldPresent === 0) notWithheld += ef.i50_totalTaxable;
    }
    const runs = new Map<string, SlipWithRun[]>();
    for (const sl of ms) { const a = runs.get(sl.run.id); if (a) a.push(sl); else runs.set(sl.run.id, [sl]); }
    out.push({
      month: new Date(`${k}-01T00:00:00Z`),
      totalCompensation: php(f.i19_gross),
      taxableCompensation: php(f.i50_totalTaxable),
      nonTaxable: php(f.i36_totalNonTax),
      taxWithheld: php(f.i25a_withheldPresent),
      employees: perEmp.size,
      breakdown: {
        smwMwe: php(f.i27_basicSmw), holidayOtNdHazardMwe: php(f.i28_holidayMwe + f.i29_otMwe + f.i30_ndMwe + f.i31_hazardMwe),
        thirteenthMonthAndOther: php(f.i32_13thExempt), deMinimis: php(f.i33_deMinimis), govContributions: php(f.i34_contributions),
        otherNonTaxable: php(f.i35_otherNonTax), taxableNotWithheld: php(notWithheld),
      },
      runs: [...runs.values()].map((rs) => {
        const rf = summarizeSlips(rs);
        const r = rs[0].run;
        return { id: r.id, number: r.number, payDate: r.payDate, journalEntryId: r.journalEntryId, employees: new Set(rs.map((x) => x.employeeId)).size, taxableCompensation: php(rf.i50_totalTaxable), taxWithheld: php(rf.i25a_withheldPresent) };
      }).sort((a, b) => a.payDate.getTime() - b.payDate.getTime() || a.number.localeCompare(b.number)),
    });
  }
  return out;
}

async function monthly1601C(organizationId: string, from: Date, to: Date): Promise<CompensationWithholding[]> {
  const slips = await prisma.payslip.findMany({
    where: { organizationId, run: { status: "FINALIZED", payDate: { gte: from, lte: to } } },
    include: { run: { select: { id: true, number: true, payDate: true, journalEntryId: true } } },
  });
  return monthlyLines(slips);
}

export const payrollCompensationFeed: CompensationFeed = { year2316, monthly1601C };
registerCompensationFeed(payrollCompensationFeed);
