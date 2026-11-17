// BIR Form 2316 (Certificate of Compensation Payment / Tax Withheld) figures from finalized payslips.
import { prisma } from "../db";
import { LedgerError, audit } from "../ledger/service";
import type { Line } from "./compute";
import { round2, withholdingTax } from "./rates";

const fail = (m: string): never => { throw new LedgerError([m]); };
const num = (d: unknown) => (d ? Number(d) : 0);

export type Form2316Data = {
  year: number;
  employee: { code: string; name: string; tin: string | null; birthDate: string | null; address: string | null; mwe: boolean; periodFrom: string; periodTo: string };
  employer: { name: string; tin: string | null; address: string | null };
  // Part IV-B A. Non-taxable / exempt compensation
  i27_basicSmw: number; i28_holidayMwe: number; i29_otMwe: number; i30_ndMwe: number; i31_hazardMwe: number;
  i32_13thExempt: number; i33_deMinimis: number; i34_contributions: number; i35_otherNonTax: number; i36_totalNonTax: number;
  // B. Taxable compensation
  i37_basic: number; i42_otherAllowances: number; i43_commission: number; i46_13thTaxable: number; i48_overtime: number; i49_others: number; i50_totalTaxable: number;
  // Part IV-A summary
  i19_gross: number; i20_lessNonTax: number; i21_taxablePresent: number; i22_taxablePrevious: number; i23_grossTaxable: number;
  i24_taxDue: number; i25a_withheldPresent: number; i25b_withheldPrevious: number; i26_totalWithheld: number;
  payslips: number;
};

/** What the 2316 / 1601-C figures need from a finalized payslip. */
export type SlipFigures = {
  minimumWageEarner: boolean; earnings: unknown;
  sssEE: unknown; mpfEE: unknown; phicEE: unknown; hdmfEE: unknown; withholdingTax: unknown;
};

/** Part IV-B figures (non-taxable / taxable compensation) and tax withheld for a set of payslips. */
export type CompensationFigures = Pick<Form2316Data,
  "i27_basicSmw" | "i28_holidayMwe" | "i29_otMwe" | "i30_ndMwe" | "i31_hazardMwe" | "i32_13thExempt" | "i33_deMinimis" | "i34_contributions" | "i35_otherNonTax" | "i36_totalNonTax" |
  "i37_basic" | "i42_otherAllowances" | "i43_commission" | "i46_13thTaxable" | "i48_overtime" | "i49_others" | "i50_totalTaxable" | "i19_gross" | "i25a_withheldPresent">;

/**
 * Classify payslip earnings the way BIR 2316 Part IV-B (and 1601-C items 14-22) lays them out.
 * Pure: used for the annual 2316, the 1604-C alphalist and the monthly 1601-C.
 */
export function summarizeSlips(slips: SlipFigures[]): CompensationFigures {
  const d: CompensationFigures = {
    i27_basicSmw: 0, i28_holidayMwe: 0, i29_otMwe: 0, i30_ndMwe: 0, i31_hazardMwe: 0, i32_13thExempt: 0, i33_deMinimis: 0, i34_contributions: 0, i35_otherNonTax: 0, i36_totalNonTax: 0,
    i37_basic: 0, i42_otherAllowances: 0, i43_commission: 0, i46_13thTaxable: 0, i48_overtime: 0, i49_others: 0, i50_totalTaxable: 0, i19_gross: 0, i25a_withheldPresent: 0,
  };
  for (const s of slips) {
    const mwe = s.minimumWageEarner;
    for (const l of (s.earnings ?? []) as Line[]) {
      const a = l.amount;
      d.i19_gross += a;
      switch (l.group) {
        case "BASIC": if (mwe) d.i27_basicSmw += a; else d.i37_basic += a; break;
        case "PREMIUM": if (mwe) d.i28_holidayMwe += a; else d.i49_others += a; break;
        case "NIGHT_DIFF": if (mwe) d.i30_ndMwe += a; else d.i49_others += a; break;
        case "OVERTIME": if (mwe) d.i29_otMwe += a; else d.i48_overtime += a; break;
        case "COMMISSION": d.i43_commission += a; break;
        case "THIRTEENTH": case "BONUS":
          if (l.taxable) d.i46_13thTaxable += a; else d.i32_13thExempt += a; break;
        case "ALLOWANCE":
          if (l.code === "DM") d.i33_deMinimis += a;
          else if (l.code === "DM_EXCESS" || l.code === "DM_EXCESS_TAXABLE") { if (l.taxable) d.i46_13thTaxable += a; else d.i32_13thExempt += a; }
          else if (l.taxable) d.i42_otherAllowances += a;
          else d.i35_otherNonTax += a;
          break;
        default: if (l.taxable) d.i49_others += a; else d.i35_otherNonTax += a;
      }
    }
    const contrib = num(s.sssEE) + num(s.mpfEE) + num(s.phicEE) + num(s.hdmfEE);
    d.i34_contributions += contrib;
    // Contributions are part of gross pay but not taxable: report basic net of them.
    if (mwe) d.i27_basicSmw -= contrib; else d.i37_basic -= contrib;
    d.i25a_withheldPresent += num(s.withholdingTax);
  }
  for (const k of Object.keys(d) as (keyof CompensationFigures)[]) d[k] = round2(d[k]);
  d.i36_totalNonTax = round2(d.i27_basicSmw + d.i28_holidayMwe + d.i29_otMwe + d.i30_ndMwe + d.i31_hazardMwe + d.i32_13thExempt + d.i33_deMinimis + d.i34_contributions + d.i35_otherNonTax);
  d.i50_totalTaxable = round2(d.i37_basic + d.i42_otherAllowances + d.i43_commission + d.i46_13thTaxable + d.i48_overtime + d.i49_others);
  return d;
}

type EmployeeFor2316 = { code: string; lastName: string; firstName: string; middleName: string | null; tin: string | null; birthDate: Date | null; address: string | null; minimumWageEarner: boolean; dateHired: Date | null; separationDate: Date | null };

/** The whole 2316 from the employee, employer and the year's finalized payslips. Pure. */
export function build2316(year: number, emp: EmployeeFor2316, employer: Form2316Data["employer"], slips: SlipFigures[]): Form2316Data {
  const f = summarizeSlips(slips);
  const d: Form2316Data = {
    year,
    employee: {
      code: emp.code, name: `${emp.lastName}, ${emp.firstName}${emp.middleName ? " " + emp.middleName : ""}`, tin: emp.tin, birthDate: emp.birthDate?.toISOString().slice(0, 10) ?? null,
      address: emp.address, mwe: emp.minimumWageEarner,
      periodFrom: (emp.dateHired && emp.dateHired.getUTCFullYear() === year ? emp.dateHired.toISOString().slice(0, 10) : `${year}-01-01`),
      periodTo: (emp.separationDate && emp.separationDate.getUTCFullYear() === year ? emp.separationDate.toISOString().slice(0, 10) : `${year}-12-31`),
    },
    employer,
    ...f,
    i20_lessNonTax: f.i36_totalNonTax, i21_taxablePresent: f.i50_totalTaxable, i22_taxablePrevious: 0, i23_grossTaxable: 0,
    i24_taxDue: 0, i25b_withheldPrevious: 0, i26_totalWithheld: 0,
    payslips: slips.length,
  };
  d.i23_grossTaxable = round2(d.i21_taxablePresent + d.i22_taxablePrevious);
  d.i24_taxDue = withholdingTax(d.i23_grossTaxable, "ANNUAL");
  d.i26_totalWithheld = round2(d.i25a_withheldPresent + d.i25b_withheldPrevious);
  return d;
}

/** Finalized payslips paid in a calendar year (pay date decides the year, as BIR counts compensation paid). */
export const paidInYear = (organizationId: string, year: number) => ({
  organizationId, run: { status: "FINALIZED", payDate: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) } },
});

export async function compute2316(organizationId: string, employeeId: string, year: number): Promise<Form2316Data> {
  const [org, emp] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    prisma.employee.findFirst({ where: { id: employeeId, organizationId } }),
  ]);
  if (!emp) fail("Employee not found");
  const slips = await prisma.payslip.findMany({ where: { ...paidInYear(organizationId, year), employeeId }, include: { run: true }, orderBy: { run: { payDate: "asc" } } });
  return build2316(year, emp!, { name: org.name, tin: org.tin, address: org.registeredAddress }, slips);
}

/** Recompute drafts for all employees paid in the year (finalized/released forms are kept). */
export async function generate2316(organizationId: string, userId: string, year: number) {
  const paid = await prisma.payslip.findMany({
    where: paidInYear(organizationId, year),
    distinct: ["employeeId"], select: { employeeId: true },
  });
  let n = 0;
  for (const { employeeId } of paid) {
    const cur = await prisma.form2316.findUnique({ where: { employeeId_year: { employeeId, year } } });
    if (cur && cur.status !== "DRAFT") continue;
    const data = JSON.parse(JSON.stringify(await compute2316(organizationId, employeeId, year)));
    await prisma.form2316.upsert({ where: { employeeId_year: { employeeId, year } }, create: { organizationId, employeeId, year, data }, update: { data } });
    n++;
  }
  await prisma.$transaction((tx) => audit(tx, organizationId, userId, "bir2316.generate", String(year), { year, count: n }, null, null, "bir2316"));
  return n;
}

export async function set2316Status(organizationId: string, userId: string, id: string, op: "finalize" | "release" | "reopen") {
  const f = await prisma.form2316.findFirst({ where: { id, organizationId } });
  if (!f) fail("Form not found");
  if (op === "finalize") {
    if (f!.status !== "DRAFT") fail("Already finalized");
    // Refresh the figures one last time before locking them.
    const data = JSON.parse(JSON.stringify(await compute2316(organizationId, f!.employeeId, f!.year)));
    await prisma.form2316.update({ where: { id }, data: { data, status: "FINALIZED", finalizedById: userId, finalizedAt: new Date() } });
  } else if (op === "release") {
    if (f!.status !== "FINALIZED") fail("Review and finalize the form before releasing it to the employee");
    await prisma.form2316.update({ where: { id }, data: { status: "RELEASED", releasedAt: new Date() } });
  } else {
    if (f!.status === "DRAFT") fail("Already a draft");
    await prisma.form2316.update({ where: { id }, data: { status: "DRAFT", releasedAt: null, finalizedAt: null, finalizedById: null } });
  }
  await prisma.$transaction((tx) => audit(tx, organizationId, userId, `bir2316.${op}`, id, { year: f!.year }, null, null, "bir2316"));
}
