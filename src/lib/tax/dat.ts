// BIR data files (DAT) for eSubmission (esubmission@bir.gov.ph) and the RELIEF / Alphalist validation
// modules, plus CSV. Pure functions: no database access, unit-tested in tests/tax-dat.test.ts.
//
// Layouts follow the BIR Alphalist Data Entry (QAP, SAWT, 1604-E/F) and RELIEF (SLSP) modules:
// comma-separated, text in double quotes and upper case, amounts with 2 decimals and no commas,
// one header (H), detail (D) records and, for alphalists, a control (C) record with totals.
// Run every file through the BIR validation module before the first real submission; if BIR changes
// a layout, this file is the only place to update.
import { fromCentavos } from "@/lib/money";
import type { EmployeeRow, PayeeRow, SlpRow, SlsRow } from "./lists";
import { splitTin } from "./tin";

export type FilerInfo = {
  tin: string | null; rdoCode: string | null; name: string; tradeName?: string | null;
  address?: string | null; zipCode?: string | null; fiscalYearEndMonth?: number;
};

const amt = (c: bigint) => fromCentavos(c);
/** Text field: upper case, in quotes, without characters that break the layout. */
export const txt = (s: string | null | undefined) => `"${(s ?? "").toUpperCase().replace(/["\r\n]+/g, " ").replace(/\s+/g, " ").trim()}"`;
const mmyyyy = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const mmddyyyy = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
const rate = (r: number) => r.toFixed(2);
const rdo = (r: string | null | undefined) => (r ?? "").replace(/\D/g, "").padStart(3, "0").slice(-3);
const lines = (rs: string[]) => rs.join("\r\n") + "\r\n";

function addr(a?: string | null) {
  // RELIEF has two address fields: street/subdivision and city/municipality + ZIP.
  const s = (a ?? "").trim();
  const i = s.lastIndexOf(",");
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, ""];
}

function filerTin(f: FilerInfo) {
  const t = splitTin(f.tin);
  if (t.tin9.length !== 9) throw new Error("Set the company's TIN (e.g. 123-456-789-00000) in Company Settings first");
  return t;
}

export function issues(rows: { tin9: string; party: { name: string | null; lastName?: string | null } }[]) {
  return rows.filter((r) => r.tin9.length !== 9 || !(r.party.name || r.party.lastName)).map((r) => `${r.party.name ?? "(no name)"}: ${r.tin9 ? "TIN must have 9 digits" : "no TIN"}`);
}

// ---------- RELIEF: Summary List of Sales (S) and Purchases (P) ----------

export function reliefFileName(f: FilerInfo, type: "S" | "P", periodTo: Date) {
  return `${filerTin(f).tin9}${type}${String(periodTo.getUTCMonth() + 1).padStart(2, "0")}${periodTo.getUTCFullYear()}.DAT`;
}

export function reliefSales(f: FilerInfo, periodTo: Date, rows: SlsRow[]) {
  const t = filerTin(f);
  const [a1, a2] = addr([f.address, f.zipCode].filter(Boolean).join(" "));
  const tot = rows.reduce((s, r) => ({ ex: s.ex + r.exempt, zr: s.zr + r.zeroRated, tx: s.tx + r.taxable, out: s.out + r.outputTax }), { ex: 0n, zr: 0n, tx: 0n, out: 0n });
  const out = [[
    "H", "S", txt(t.tin9), txt(f.name), txt(""), txt(""), txt(""), txt(f.tradeName || f.name), txt(a1), txt(a2),
    amt(tot.ex), amt(tot.zr), amt(tot.tx), amt(tot.out), rdo(f.rdoCode), mmddyyyy(periodTo), String(f.fiscalYearEndMonth ?? 12),
  ].join(",")];
  for (const r of rows) {
    const [b1, b2] = addr(r.party.address);
    out.push(["D", "S", txt(r.tin9), txt(r.party.lastName ? "" : r.party.name), txt(r.party.lastName), txt(r.party.firstName), txt(r.party.middleName), txt(b1), txt(b2),
      amt(r.exempt), amt(r.zeroRated), amt(r.taxable), amt(r.outputTax), t.tin9, mmddyyyy(periodTo)].join(","));
  }
  return lines(out);
}

export function reliefPurchases(f: FilerInfo, periodTo: Date, rows: SlpRow[], nonCreditable = 0n) {
  const t = filerTin(f);
  const [a1, a2] = addr([f.address, f.zipCode].filter(Boolean).join(" "));
  const tot = rows.reduce((s, r) => ({ ex: s.ex + r.exempt, zr: s.zr + r.zeroRated, sv: s.sv + r.services, cg: s.cg + r.capitalGoods, gd: s.gd + r.goods, it: s.it + r.inputTax }), { ex: 0n, zr: 0n, sv: 0n, cg: 0n, gd: 0n, it: 0n });
  const out = [[
    "H", "P", txt(t.tin9), txt(f.name), txt(""), txt(""), txt(""), txt(f.tradeName || f.name), txt(a1), txt(a2),
    amt(tot.ex), amt(tot.zr), amt(tot.sv), amt(tot.cg), amt(tot.gd), amt(tot.it), amt(tot.it - nonCreditable), amt(nonCreditable),
    rdo(f.rdoCode), mmddyyyy(periodTo), String(f.fiscalYearEndMonth ?? 12),
  ].join(",")];
  for (const r of rows) {
    const [b1, b2] = addr(r.party.address);
    out.push(["D", "P", txt(r.tin9), txt(r.party.lastName ? "" : r.party.name), txt(r.party.lastName), txt(r.party.firstName), txt(r.party.middleName), txt(b1), txt(b2),
      amt(r.exempt), amt(r.zeroRated), amt(r.services), amt(r.capitalGoods), amt(r.goods), amt(r.inputTax), t.tin9, mmddyyyy(periodTo)].join(","));
  }
  return lines(out);
}

// ---------- Alphalist Data Entry: QAP (1601-EQ / 1601-FQ) and SAWT ----------

export function alphaFileName(f: FilerInfo, periodTo: Date, form: string) {
  const t = filerTin(f);
  return `${t.tin9}${t.branch.slice(-4)}${String(periodTo.getUTCMonth() + 1).padStart(2, "0")}${periodTo.getUTCFullYear()}${form}.DAT`;
}

const payeeNames = (r: PayeeRow) => r.party.lastName
  ? [txt(""), txt(r.party.lastName), txt(r.party.firstName), txt(r.party.middleName)]
  : [txt(r.party.name), txt(""), txt(""), txt("")];

/** QAP for 1601-EQ or 1601-FQ: HQAP header, D1 per payee and ATC, C1 control totals. */
export function qapDat(f: FilerInfo, form: "1601EQ" | "1601FQ", periodTo: Date, rows: PayeeRow[]) {
  const t = filerTin(f);
  const p = mmyyyy(periodTo);
  const out = [["HQAP", `H${form}`, t.tin9, t.branch.slice(-4), txt(f.name), p, rdo(f.rdoCode)].join(",")];
  rows.forEach((r, i) => out.push(["D1", form, i + 1, r.tin9, r.branch.slice(-4), ...payeeNames(r), p, r.atcCode, rate(r.rate), amt(r.base), amt(r.tax)].join(",")));
  out.push(["C1", form, t.tin9, t.branch.slice(-4), p, amt(rows.reduce((s, r) => s + r.base, 0n)), amt(rows.reduce((s, r) => s + r.tax, 0n))].join(","));
  return lines(out);
}

/** SAWT attached to 2550Q / 2551Q / 1702Q: HSAWT header, DSAWT per withholding agent and ATC, CSAWT control. */
export function sawtDat(f: FilerInfo, form: string, periodTo: Date, rows: PayeeRow[]) {
  const t = filerTin(f);
  const p = mmyyyy(periodTo);
  const out = [["HSAWT", `H${form}`, t.tin9, t.branch.slice(-4), txt(f.name), txt(""), txt(""), txt(""), p, rdo(f.rdoCode)].join(",")];
  rows.forEach((r, i) => out.push(["DSAWT", `D${form}`, i + 1, r.tin9, r.branch.slice(-4), ...payeeNames(r), p, "", r.atcCode, rate(r.rate), amt(r.base), amt(r.tax)].join(",")));
  out.push(["CSAWT", `C${form}`, t.tin9, t.branch.slice(-4), p, amt(rows.reduce((s, r) => s + r.base, 0n)), amt(rows.reduce((s, r) => s + r.tax, 0n))].join(","));
  return lines(out);
}

/** Annual alphalist of payees: 1604-E schedule 3 (D3) or 1604-F schedule 4 (D4). */
export function alphalistDat(f: FilerInfo, form: "1604E" | "1604F", year: number, rows: PayeeRow[]) {
  const t = filerTin(f);
  const end = `12/31/${year}`;
  const sch = form === "1604E" ? "3" : "4";
  const out = [[`H${form}`, t.tin9, t.branch.slice(-4), end].join(",")];
  rows.forEach((r, i) => out.push([`D${sch}`, form, t.tin9, t.branch.slice(-4), end, i + 1, r.tin9, r.branch.slice(-4), ...payeeNames(r), r.atcCode, rate(r.rate), amt(r.base), amt(r.tax)].join(",")));
  out.push([`C${sch}`, form, t.tin9, t.branch.slice(-4), end, amt(rows.reduce((s, r) => s + r.base, 0n)), amt(rows.reduce((s, r) => s + r.tax, 0n))].join(","));
  return lines(out);
}

// ---------- 1604-C: alphalist of employees (from payroll, per BIR 2316) ----------

const p2 = (v: string | undefined | null) => Number(v ?? 0).toFixed(2);
const yn = (b: boolean) => (b ? "Y" : "N");
const decWithheld = (r: EmployeeRow) => Number(r.taxWithheldPresent) - Number(r.taxWithheldJanNov ?? r.taxWithheldPresent);
export const nonTaxableTotal = (r: EmployeeRow) => Object.values(r.nonTaxable).reduce((s, v) => s + Number(v ?? 0), 0);
export const taxableTotal = (r: EmployeeRow) => Object.values(r.taxable).reduce((s, v) => s + Number(v ?? 0), 0);

export function issues1604C(rows: EmployeeRow[]) {
  const out: string[] = [];
  for (const r of rows) {
    const who = `${r.lastName}, ${r.firstName}`;
    if (r.tin9.length !== 9) out.push(`${who}: ${r.tin9 ? "TIN must have 9 digits" : "no TIN"} (set it on the employee record)`);
  }
  return out;
}

/**
 * 1604-C DAT: H1604C header; one detail record per employee in its schedule (D7.1, D7.3, D7.4, D7.5)
 * with the BIR 2316 figures; a control record per schedule (C7.x) with totals.
 */
export function alphalist1604CDat(f: FilerInfo, year: number, rows: EmployeeRow[]) {
  const t = filerTin(f);
  const end = `12/31/${year}`;
  const out = [["H1604C", t.tin9, t.branch.slice(-4), end, rdo(f.rdoCode)].join(",")];
  for (const sch of ["7.1", "7.3", "7.4", "7.5"] as const) {
    const rs = rows.filter((r) => r.schedule === sch);
    if (!rs.length) continue;
    rs.forEach((r, i) => {
      const n = r.nonTaxable, x = r.taxable;
      const head = [`D${sch}`, "1604C", t.tin9, t.branch.slice(-4), end, i + 1, r.tin9, r.branch.slice(-4), txt(r.lastName), txt(r.firstName), txt(r.middleName)];
      const period = sch === "7.1" ? [mmddyyyy(r.periodFrom), mmddyyyy(r.periodTo)] : [];
      const mwe = sch === "7.5" ? [p2(n.basicSmw), p2(n.holidayPay), p2(n.overtimePay), p2(n.nightDiff), p2(n.hazardPay)] : [];
      const nonTax = [p2(n.thirteenthMonthAndOther), p2(n.deMinimis), p2(n.govContributions), p2(n.salariesOther), nonTaxableTotal(r).toFixed(2)];
      const tax = [p2(x.basic), p2(x.thirteenthMonthExcess), (Number(x.others ?? 0) + Number(x.commission ?? 0) + Number(x.overtimePay ?? 0) + Number(x.othersSupplementary ?? 0)).toFixed(2), taxableTotal(r).toFixed(2)];
      const prev = sch === "7.4" ? [p2(r.taxableFromPreviousEmployer), p2(r.taxWithheldPrevious)] : [];
      const withheld = Number(r.taxWithheldPresent) + Number(r.taxWithheldPrevious ?? 0);
      const diff = withheld - Number(r.taxDue);
      const refund = diff > 0 ? diff : 0;
      // Tax due · withheld Jan-Nov · withheld December (year-end adjustment) · over-withheld refunded · withheld as adjusted
      const wt = [p2(r.taxDue), p2(r.taxWithheldJanNov ?? r.taxWithheldPresent), decWithheld(r).toFixed(2), refund.toFixed(2), (withheld - refund).toFixed(2)];
      out.push([...head, ...period, p2(r.grossCompensation), ...mwe, ...nonTax, ...tax, ...prev, ...wt, ...(sch === "7.1" ? [] : [yn(r.substitutedFiling)])].join(","));
    });
    const sum = (g: (r: EmployeeRow) => number) => rs.reduce((s, r) => s + g(r), 0).toFixed(2);
    out.push([`C${sch}`, "1604C", t.tin9, t.branch.slice(-4), end, sum((r) => Number(r.grossCompensation)), sum(nonTaxableTotal), sum(taxableTotal), sum((r) => Number(r.taxDue)), sum((r) => Number(r.taxWithheldPresent) + Number(r.taxWithheldPrevious ?? 0))].join(","));
  }
  return lines(out);
}

// ---------- CSV ----------

const csvCell = (v: unknown) => {
  const s = typeof v === "bigint" ? fromCentavos(v) : v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function csv(header: string[], rows: unknown[][]) {
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
