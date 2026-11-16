// BIR return computations, built from the tax ledger plus the manual items saved on the draft return.
// Each return is a list of sections and rows so one screen, print layout and CSV export serve them all.
// Field names follow the current forms (2550Q / 2551Q Jan 2023 ENCS, 1601-EQ / 1601-FQ Jan 2018 ENCS,
// 0619-E / 0619-F); line numbers are left out on purpose because BIR renumbers them between versions.
import "server-only";
import { prisma } from "@/lib/db";
import { fromCentavos, toCentavos } from "@/lib/money";
import { taxLines } from "./ledger";
import { FORMS, periodFor, quarter, month, type FormCode, type Period } from "./periods";
import { CLASS_LABEL, type TaxLine } from "./types";

export type Row = {
  key: string;
  label: string;
  base?: bigint;   // tax base / taxable amount
  rate?: string;   // e.g. "12%"
  tax?: bigint;    // tax amount
  input?: boolean; // typed in by the user (saved on the draft return)
  note?: string;
  strong?: boolean;
};
export type Section = { title: string; rows: Row[] };
export type ReturnResult = {
  form: FormCode; name: string; period: Period; sections: Section[]; taxDue: bigint;
  /** 2550Q: input VAT to carry over to the next quarter. */
  carryOver?: bigint;
  warnings: string[];
  lines: TaxLine[];
  saved: { id: string; status: string; inputs: Record<string, string>; filedAt: Date | null; filingRef: string | null; amountPaid: bigint; paymentRef: string | null; journalEntryId: string | null; figures: unknown } | null;
};

const sum = (xs: TaxLine[], f: (l: TaxLine) => bigint = (l) => l.tax) => xs.reduce((s, l) => s + f(l), 0n);
const pos = (v: bigint) => (v > 0n ? v : 0n);
const cents = (v: unknown) => { try { return toCentavos(String(v ?? "")); } catch { return 0n; } };

export async function savedReturn(organizationId: string, form: FormCode, period: Period) {
  return prisma.taxReturn.findUnique({ where: { organizationId_form_periodFrom_amended: { organizationId, form, periodFrom: period.from, amended: false } } });
}

/** The figure a filed return left for the next one (VAT carry-over, or what was remitted). */
async function filedFigure(organizationId: string, form: FormCode, period: Period, field: "carryOver" | "taxDue" | "amountPaid") {
  const r = await savedReturn(organizationId, form, period);
  if (!r || r.status !== "FILED") return null;
  if (field === "amountPaid") return cents(r.amountPaid);
  const f = (r.figures ?? {}) as Record<string, string>;
  return field === "carryOver" ? cents(f.carryOver) : cents(r.taxDue);
}

export async function computeReturn(organizationId: string, form: FormCode, year: number, n: number): Promise<ReturnResult> {
  const period = periodFor(form, year, n);
  const saved = await savedReturn(organizationId, form, period);
  const inputs = ((saved?.inputs ?? {}) as Record<string, string>) || {};
  const inp = (k: string) => cents(inputs[k]);
  const warnings: string[] = [];
  const base = { form, name: FORMS[form].name, period, warnings, saved: saved && {
    id: saved.id, status: saved.status, inputs, filedAt: saved.filedAt, filingRef: saved.filingRef, amountPaid: cents(saved.amountPaid),
    paymentRef: saved.paymentRef, journalEntryId: saved.journalEntryId, figures: saved.figures,
  } };

  if (form === "2550Q" || form === "2550M") {
    const lines = await taxLines(organizationId, period.from, period.to, { kinds: ["OUTPUT_VAT", "INPUT_VAT", "VAT_WITHHELD"] });
    const out = lines.filter((l) => l.kind === "OUTPUT_VAT");
    const inn = lines.filter((l) => l.kind === "INPUT_VAT");
    const sale = (cls: string) => out.filter((l) => (l.vatClass ?? "VATABLE") === cls);
    const buy = (cls: string) => inn.filter((l) => (l.vatClass ?? "GOODS") === cls);
    const salesRows: Row[] = ["VATABLE", "GOVERNMENT", "ZERO_RATED", "EXEMPT"].map((k) => ({ key: `sales.${k}`, label: CLASS_LABEL[k], base: sum(sale(k), (l) => l.base), tax: k === "ZERO_RATED" || k === "EXEMPT" ? undefined : sum(sale(k)) }));
    const totalSales = sum(out, (l) => l.base), outputTax = sum(out);
    const adjOut = outputTax - inp("outLessUncollected") + inp("outAddRecovered");

    // Carry-over from the previous period's filed return (2550Q -> previous quarter; 2550M -> previous month).
    let carry = inp("carryOver");
    if (!inputs.carryOver) {
      const prev = form === "2550Q" ? (n === 1 ? quarter(year - 1, 4) : quarter(year, n - 1)) : (n === 1 ? month(year - 1, 12) : month(year, n - 1));
      const c = await filedFigure(organizationId, form, prev, "carryOver");
      if (c !== null) carry = c;
      else if (inn.length || out.length) warnings.push(`No filed ${form} for ${prev.label} in Veritus: enter the input VAT carried over from your last filed return.`);
    }
    const beginning = carry + inp("deferredCapital") + inp("transitional") + inp("presumptive") + inp("otherBeginning");
    const buyKeys = ["CAPITAL_GOODS", "GOODS", "SERVICES", "IMPORT_GOODS", "SERVICES_NONRESIDENT"];
    const currentRows: Row[] = buyKeys.map((k) => ({ key: `buy.${k}`, label: CLASS_LABEL[k], base: sum(buy(k), (l) => l.base), tax: sum(buy(k)) }));
    const noInput = [...buy("NOT_QUALIFIED"), ...buy("EXEMPT"), ...buy("ZERO_RATED")];
    const currentInput = buyKeys.reduce((s, k) => s + sum(buy(k)), 0n);
    const totalAvailable = beginning + currentInput;
    // Input VAT on purchases used for both exempt and vatable sales is apportioned by sales (NIRC Sec. 110(A)(3)).
    const exemptShare = totalSales > 0n ? (sum(sale("EXEMPT"), (l) => l.base) * 10000n) / totalSales : 0n;
    const suggestedExempt = (currentInput * exemptShare) / 10000n;
    const deductions = inp("lessExempt") + inp("lessGovernment") + inp("lessRefund") + inp("lessOther");
    const allowable = totalAvailable - deductions;
    const netPayable = adjOut - allowable;
    const vatWithheld = sum(lines.filter((l) => l.kind === "VAT_WITHHELD"));
    let monthly = 0n;
    if (form === "2550Q" && !inputs.monthlyPaid) {
      for (let k = 0; k < 3; k++) { const p = month(year, (n - 1) * 3 + 1 + k); const paid = await filedFigure(organizationId, "2550M", p, "amountPaid"); if (paid) monthly += paid; }
    } else monthly = inp("monthlyPaid");
    const credits = vatWithheld + inp("advancePayments") + monthly + inp("previouslyFiled") + inp("otherCredits");
    const stillDue = netPayable - credits;
    const penalties = inp("surcharge") + inp("interest") + inp("compromise");
    const taxDue = pos(stillDue) + (stillDue > 0n ? penalties : 0n);
    if (inn.some((l) => !l.party.tin)) warnings.push("Some purchases have no supplier TIN. BIR disallows input VAT without a valid VAT invoice showing the supplier's TIN.");
    if (sale("EXEMPT").length && !inputs.lessExempt) warnings.push(`You have VAT-exempt sales: input VAT attributable to them is not creditable. Suggested by sales ratio: ${fromCentavos(suggestedExempt)}.`);
    return {
      ...base, lines,
      sections: [
        { title: "Sales / receipts and output tax", rows: [...salesRows,
          { key: "sales.total", label: "Total sales / receipts and output tax due", base: totalSales, tax: outputTax, strong: true },
          { key: "outLessUncollected", label: "Less: output VAT on uncollected receivables", tax: inp("outLessUncollected"), input: true },
          { key: "outAddRecovered", label: "Add: output VAT on recovered uncollected receivables", tax: inp("outAddRecovered"), input: true },
          { key: "out.adjusted", label: "Total adjusted output tax due", tax: adjOut, strong: true }] },
        { title: "Allowable input tax", rows: [
          { key: "carryOver", label: "Input tax carried over from previous period", tax: carry, input: true, note: inputs.carryOver ? undefined : "from the last filed return" },
          { key: "deferredCapital", label: "Input tax deferred on capital goods exceeding P1 million from previous period", tax: inp("deferredCapital"), input: true },
          { key: "transitional", label: "Transitional input tax", tax: inp("transitional"), input: true },
          { key: "presumptive", label: "Presumptive input tax", tax: inp("presumptive"), input: true },
          { key: "otherBeginning", label: "Others", tax: inp("otherBeginning"), input: true },
          { key: "beginning.total", label: "Total", tax: beginning, strong: true },
          ...currentRows,
          { key: "buy.noInput", label: "Domestic purchases with no input tax / VAT-exempt", base: sum(noInput, (l) => l.base) },
          { key: "buy.total", label: "Total current purchases and input tax", base: sum(inn, (l) => l.base), tax: currentInput, strong: true },
          { key: "available", label: "Total available input tax", tax: totalAvailable, strong: true }] },
        { title: "Deductions from input tax", rows: [
          { key: "lessExempt", label: "Input tax directly attributable to VAT-exempt sales", tax: inp("lessExempt"), input: true, note: suggestedExempt > 0n ? `suggested ${fromCentavos(suggestedExempt)}` : undefined },
          { key: "lessGovernment", label: "Input tax on sales to government closed to expense", tax: inp("lessGovernment"), input: true },
          { key: "lessRefund", label: "Input tax claimed for VAT refund / TCC", tax: inp("lessRefund"), input: true },
          { key: "lessOther", label: "Others", tax: inp("lessOther"), input: true },
          { key: "deductions", label: "Total deductions", tax: deductions, strong: true },
          { key: "allowable", label: "Total allowable input tax", tax: allowable, strong: true }] },
        { title: "Tax payable", rows: [
          { key: "net", label: "Net VAT payable / (excess input tax)", tax: netPayable, strong: true },
          { key: "vatWithheld", label: "Less: creditable VAT withheld (2307 received, per SAWT)", tax: vatWithheld },
          { key: "advancePayments", label: "Less: advance VAT payments", tax: inp("advancePayments"), input: true },
          { key: "monthlyPaid", label: form === "2550Q" ? "Less: VAT paid in 2550M for this quarter" : "Less: VAT paid in previously filed declaration", tax: monthly, input: true },
          { key: "previouslyFiled", label: "Less: tax paid in return previously filed (if amended)", tax: inp("previouslyFiled"), input: true },
          { key: "otherCredits", label: "Less: other credits / payments", tax: inp("otherCredits"), input: true },
          { key: "stillDue", label: "Tax still payable / (overpayment)", tax: stillDue, strong: true },
          { key: "surcharge", label: "Add: surcharge", tax: inp("surcharge"), input: true },
          { key: "interest", label: "Add: interest", tax: inp("interest"), input: true },
          { key: "compromise", label: "Add: compromise", tax: inp("compromise"), input: true },
          { key: "taxDue", label: "Total amount payable", tax: taxDue, strong: true }] },
      ],
      taxDue,
      carryOver: netPayable < 0n ? -netPayable : 0n,
    };
  }

  if (form === "2551Q") {
    const lines = await taxLines(organizationId, period.from, period.to, { kinds: ["PERCENTAGE", "PT_WITHHELD"] });
    const pt = lines.filter((l) => l.kind === "PERCENTAGE");
    const rows: Row[] = [];
    if (pt.length) {
      const byAtc = new Map<string, TaxLine[]>();
      for (const l of pt) { const k = `${l.atcCode ?? "PT010"}|${l.rate}`; byAtc.set(k, [...(byAtc.get(k) ?? []), l]); }
      for (const [k, ls] of byAtc) { const [atc, rate] = k.split("|"); rows.push({ key: `atc.${k}`, label: `ATC ${atc}`, base: sum(ls, (l) => l.base), rate: `${rate}%`, tax: sum(ls) }); }
    } else {
      // No sales module feeding percentage tax yet: estimate from revenue posted to the GL (Sec. 116, 3%).
      const rev = await prisma.journalLine.aggregate({
        _sum: { credit: true, debit: true },
        where: { organizationId, account: { type: "INCOME", ifrsGroup: "Revenue" }, journalEntry: { status: "POSTED", book: "STATUTORY", date: { gte: period.from, lte: period.to }, source: { notIn: ["CLOSING"] } } },
      });
      const gross = cents(rev._sum.credit) - cents(rev._sum.debit);
      if (gross !== 0n) {
        const tax = (gross * 3n + 50n) / 100n;
        rows.push({ key: "atc.PT010", label: "ATC PT010 (persons exempt from VAT under Sec. 116)", base: gross, rate: "3%", tax, note: "from revenue in the GL" });
        warnings.push("Percentage tax was estimated from revenue posted to the GL (3%). Once sales invoices feed the tax engine, the return uses them instead.");
      }
    }
    const due = rows.reduce((s, r) => s + (r.tax ?? 0n), 0n);
    const withheld = sum(lines.filter((l) => l.kind === "PT_WITHHELD"));
    const credits = withheld + inp("previouslyFiled") + inp("otherCredits");
    const still = due - credits;
    const penalties = inp("surcharge") + inp("interest") + inp("compromise");
    const taxDue = pos(still) + (still > 0n ? penalties : 0n);
    return {
      ...base, lines, taxDue,
      sections: [
        { title: "Computation of tax", rows: [...rows, { key: "due", label: "Total tax due", tax: due, strong: true }] },
        { title: "Tax credits / payments", rows: [
          { key: "withheld", label: "Creditable percentage tax withheld per BIR 2307", tax: withheld },
          { key: "previouslyFiled", label: "Tax paid in return previously filed (if amended)", tax: inp("previouslyFiled"), input: true },
          { key: "otherCredits", label: "Other tax credits / payments", tax: inp("otherCredits"), input: true },
          { key: "still", label: "Tax still payable / (overpayment)", tax: still, strong: true },
          { key: "surcharge", label: "Add: surcharge", tax: inp("surcharge"), input: true },
          { key: "interest", label: "Add: interest", tax: inp("interest"), input: true },
          { key: "compromise", label: "Add: compromise", tax: inp("compromise"), input: true },
          { key: "taxDue", label: "Total amount payable", tax: taxDue, strong: true }] },
      ],
    };
  }

  // Withholding: 0619-E / 1601-EQ (expanded) and 0619-F / 1601-FQ (final).
  const kind = form === "0619E" || form === "1601EQ" ? "EWT" : "FWT";
  const lines = await taxLines(organizationId, period.from, period.to, { kinds: [kind] });
  const byAtc = new Map<string, TaxLine[]>();
  for (const l of lines) { const k = `${l.atcCode ?? "?"}|${l.rate}`; byAtc.set(k, [...(byAtc.get(k) ?? []), l]); }
  const atcRows: Row[] = [...byAtc.entries()].sort().map(([k, ls]) => { const [atc, rate] = k.split("|"); return { key: `atc.${k}`, label: `ATC ${atc}`, base: sum(ls, (l) => l.base), rate: `${rate}%`, tax: sum(ls) }; });
  const total = sum(lines);
  if (lines.some((l) => !l.atcCode)) warnings.push("Some withholding has no ATC. Set the ATC on the tax code.");
  if (lines.some((l) => !l.party.tin)) warnings.push("Some payees have no TIN. The QAP needs the payee's TIN.");
  const penalties = inp("surcharge") + inp("interest") + inp("compromise");
  if (form === "0619E" || form === "0619F") {
    const still = total - inp("previouslyFiled");
    const taxDue = pos(still) + (still > 0n ? penalties : 0n);
    return { ...base, lines, taxDue, sections: [
      { title: kind === "EWT" ? "Expanded withholding tax for the month" : "Final taxes withheld for the month", rows: [...atcRows, { key: "total", label: "Amount of remittance", tax: total, strong: true }] },
      { title: "Payable", rows: [
        { key: "previouslyFiled", label: "Less: amount remitted in return previously filed (if amended)", tax: inp("previouslyFiled"), input: true },
        { key: "surcharge", label: "Add: surcharge", tax: inp("surcharge"), input: true },
        { key: "interest", label: "Add: interest", tax: inp("interest"), input: true },
        { key: "compromise", label: "Add: compromise", tax: inp("compromise"), input: true },
        { key: "taxDue", label: "Total amount of remittance", tax: taxDue, strong: true }] },
    ] };
  }
  // Quarterly: less what the 0619 returns for the first two months remitted.
  const monthly = form === "1601EQ" ? "0619E" : "0619F";
  const rem: Row[] = [];
  let remitted = 0n;
  for (const k of [1, 2]) {
    const mn = (n - 1) * 3 + k;
    const key = `month${k}`;
    let v = inp(key);
    let note: string | undefined;
    if (!inputs[key]) {
      const paid = await filedFigure(organizationId, monthly, month(year, mn), "amountPaid");
      if (paid !== null) { v = paid; note = `from filed ${monthly}`; }
      else if (total > 0n) warnings.push(`No filed ${monthly} for ${month(year, mn).label} in Veritus: enter what you remitted, if any.`);
    }
    remitted += v;
    rem.push({ key, label: `Less: remittance for ${month(year, mn).label} (${monthly})`, tax: v, input: true, note });
  }
  const still = total - remitted - inp("previouslyFiled") - inp("overRemittance");
  const taxDue = pos(still) + (still > 0n ? penalties : 0n);
  return { ...base, lines, taxDue, sections: [
    { title: "Schedule of taxes withheld (by ATC)", rows: [...atcRows, { key: "total", label: "Total taxes withheld for the quarter", tax: total, strong: true }] },
    { title: "Remittances and tax still due", rows: [...rem,
      { key: "previouslyFiled", label: "Less: tax remitted in return previously filed (if amended)", tax: inp("previouslyFiled"), input: true },
      { key: "overRemittance", label: "Less: over-remittance from previous quarter", tax: inp("overRemittance"), input: true },
      { key: "still", label: "Tax still due / (over-remittance)", tax: still, strong: true },
      { key: "surcharge", label: "Add: surcharge", tax: inp("surcharge"), input: true },
      { key: "interest", label: "Add: interest", tax: inp("interest"), input: true },
      { key: "compromise", label: "Add: compromise", tax: inp("compromise"), input: true },
      { key: "taxDue", label: "Total amount still due", tax: taxDue, strong: true }] },
  ] };
}

/** Plain figures for the filed snapshot. */
export function figuresOf(r: ReturnResult) {
  const f: Record<string, string> = {};
  for (const s of r.sections) for (const row of s.rows) {
    if (row.base !== undefined) f[`${row.key}.base`] = fromCentavos(row.base);
    if (row.tax !== undefined) f[row.key] = fromCentavos(row.tax);
  }
  if (r.carryOver !== undefined) f.carryOver = fromCentavos(r.carryOver);
  f.taxDue = fromCentavos(r.taxDue);
  return f;
}
