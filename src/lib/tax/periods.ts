// Taxable periods and BIR filing deadlines (calendar-year taxpayers).
// Sources: NIRC Sec. 114(A) as amended by TRAIN (2550Q within 25 days after the quarter);
// RMC 52-2023 (2550M optional from 2023); NIRC Sec. 128(A) (2551Q within 25 days after the quarter);
// RR 2-98 Sec. 2.58 as amended by RR 11-2018 (0619-E/0619-F by the 10th of the following month,
// 1601-EQ/1601-FQ with QAP by the last day of the month after the quarter, 2307 within 20 days
// after the quarter, 1604-E by March 1, 1604-C/1604-F by January 31); RR 1-2017 (SLSP quarterly,
// 25th day after the quarter). eFPS filers in groups A-E may have staggered 0619 deadlines.

export type Period = { from: Date; to: Date; label: string };
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
export const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function quarter(year: number, q: number): Period {
  const m1 = (q - 1) * 3 + 1;
  return { from: utc(year, m1, 1), to: utc(year, m1 + 2, lastDay(year, m1 + 2)), label: `Q${q} ${year}` };
}
export function month(year: number, m: number): Period {
  return { from: utc(year, m, 1), to: utc(year, m, lastDay(year, m)), label: utc(year, m, 1).toLocaleString("en-PH", { month: "long", year: "numeric", timeZone: "UTC" }) };
}
export function yearPeriod(year: number): Period {
  return { from: utc(year, 1, 1), to: utc(year, 12, 31), label: String(year) };
}
export const quarterOf = (d: Date) => Math.floor(d.getUTCMonth() / 3) + 1;
/** 1, 2 or 3: which month of its quarter a date falls in. */
export const monthInQuarter = (d: Date) => (d.getUTCMonth() % 3) + 1;

export const FORMS = {
  "2550Q": { name: "Quarterly VAT Return", freq: "Q", vat: true },
  "2550M": { name: "Monthly VAT Declaration (optional since 2023)", freq: "M", vat: true },
  "2551Q": { name: "Quarterly Percentage Tax Return", freq: "Q", vat: false },
  "0619E": { name: "Monthly Remittance of Expanded Withholding Tax", freq: "M", vat: null },
  "1601EQ": { name: "Quarterly Remittance of Expanded Withholding Tax", freq: "Q", vat: null },
  "0619F": { name: "Monthly Remittance of Final Income Taxes Withheld", freq: "M", vat: null },
  "1601FQ": { name: "Quarterly Remittance of Final Income Taxes Withheld", freq: "Q", vat: null },
} as const;
export type FormCode = keyof typeof FORMS;
export const isForm = (f: string): f is FormCode => f in FORMS;

/** The period a return covers, from ?year=&q= or ?year=&m=. */
export function periodFor(form: FormCode, year: number, n: number): Period {
  return FORMS[form].freq === "Q" ? quarter(year, n) : month(year, n);
}

/** Due date of a return / attachment for the period ending `to`. */
export function dueDate(kind: FormCode | "SLSP" | "2307" | "1604E" | "1604F" | "1604C" | "QAP" | "SAWT", to: Date): Date {
  const y = to.getUTCFullYear(), m = to.getUTCMonth() + 1;
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  switch (kind) {
    case "2550Q": case "2551Q": case "SLSP": case "2550M": case "SAWT": return utc(next.y, next.m, 25);
    case "0619E": case "0619F": return utc(next.y, next.m, 10);
    case "1601EQ": case "1601FQ": case "QAP": return utc(next.y, next.m, lastDay(next.y, next.m));
    case "2307": return utc(next.y, next.m, 20);
    case "1604E": return utc(y + 1, 3, 1);
    case "1604F": case "1604C": return utc(y + 1, 1, 31);
  }
}

export type Deadline = { form: string; label: string; period: Period; due: Date; href: string; n: number };

/** Every filing for a year, in due-date order. 0619 is not filed for the third month of a quarter (1601-EQ/FQ covers it). */
export function deadlines(year: number, vatRegistered: boolean): Deadline[] {
  const out: Deadline[] = [];
  for (let q = 1; q <= 4; q++) {
    const p = quarter(year, q);
    if (vatRegistered) out.push({ form: "2550Q", label: "2550Q VAT return + SLSP", period: p, due: dueDate("2550Q", p.to), href: `/tax/returns/2550Q?year=${year}&n=${q}`, n: q });
    else out.push({ form: "2551Q", label: "2551Q percentage tax", period: p, due: dueDate("2551Q", p.to), href: `/tax/returns/2551Q?year=${year}&n=${q}`, n: q });
    out.push({ form: "1601EQ", label: "1601-EQ + QAP", period: p, due: dueDate("1601EQ", p.to), href: `/tax/returns/1601EQ?year=${year}&n=${q}`, n: q });
    out.push({ form: "1601FQ", label: "1601-FQ + QAP", period: p, due: dueDate("1601FQ", p.to), href: `/tax/returns/1601FQ?year=${year}&n=${q}`, n: q });
    out.push({ form: "2307", label: "Issue BIR 2307 to payees", period: p, due: dueDate("2307", p.to), href: `/tax/2307?year=${year}&q=${q}`, n: q });
    for (const k of [1, 2]) {
      const m = month(year, (q - 1) * 3 + k);
      out.push({ form: "0619E", label: "0619-E", period: m, due: dueDate("0619E", m.to), href: `/tax/returns/0619E?year=${year}&n=${(q - 1) * 3 + k}`, n: (q - 1) * 3 + k });
      out.push({ form: "0619F", label: "0619-F", period: m, due: dueDate("0619F", m.to), href: `/tax/returns/0619F?year=${year}&n=${(q - 1) * 3 + k}`, n: (q - 1) * 3 + k });
    }
  }
  const y = yearPeriod(year);
  out.push({ form: "1604C", label: "1604-C alphalist of employees + 2316", period: y, due: dueDate("1604C", y.to), href: `/tax/alphalist?year=${year}&kind=1604C`, n: 0 });
  out.push({ form: "1604F", label: "1604-F alphalist (final)", period: y, due: dueDate("1604F", y.to), href: `/tax/alphalist?year=${year}&kind=1604F`, n: 0 });
  out.push({ form: "1604E", label: "1604-E alphalist (expanded)", period: y, due: dueDate("1604E", y.to), href: `/tax/alphalist?year=${year}&kind=1604E`, n: 0 });
  return out.sort((a, b) => a.due.getTime() - b.due.getTime());
}
