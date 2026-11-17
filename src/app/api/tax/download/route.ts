import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { alphaFileName, alphalist1604CDat, alphalistDat, csv, nonTaxableTotal, taxableTotal, qapDat, reliefFileName, reliefPurchases, reliefSales, sawtDat, type FilerInfo } from "@/lib/tax/dat";
import { alphalist, alphalistEmployees, certificates2307, qap, sawt, slsp } from "@/lib/tax/lists";
import { computeReturn } from "@/lib/tax/returns";
import { BOOKS, book, isBook } from "@/lib/tax/books";
import { isForm, quarter } from "@/lib/tax/periods";
import { formatTin } from "@/lib/tax/tin";
import { fromCentavos } from "@/lib/money";

// GET /api/tax/download?type=relief-s|relief-p|slsp-csv|qap|qap-csv|sawt|sawt-csv|alpha|alpha-csv|2307-csv|return|book&...
export async function GET(req: Request) {
  const ctx = await requireCtx("reports.view");
  const q = new URL(req.url).searchParams;
  const type = q.get("type") ?? "";
  const year = Number(q.get("year")) || new Date().getUTCFullYear();
  const n = Math.min(12, Math.max(1, Number(q.get("n")) || 1));
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const filer: FilerInfo = { tin: org.tin, rdoCode: org.rdoCode, name: org.name, tradeName: org.tradeName, address: org.registeredAddress, zipCode: org.zipCode, fiscalYearEndMonth: ((org.fiscalYearStartMonth + 10) % 12) + 1 };
  const send = (body: string, name: string, mime = "text/plain") =>
    new NextResponse(body, { headers: { "Content-Type": `${mime}; charset=utf-8`, "Content-Disposition": `attachment; filename="${name}"` } });
  const party = (p: { name: string | null; lastName?: string | null; firstName?: string | null }) => p.lastName ? `${p.lastName}, ${p.firstName ?? ""}` : p.name ?? "";
  try {
    const p = quarter(year, Math.min(4, n));
    switch (type) {
      case "relief-s": { const r = await slsp(org.id, p); return send(reliefSales(filer, p.to, r.sales), reliefFileName(filer, "S", p.to)); }
      case "relief-p": { const r = await slsp(org.id, p); return send(reliefPurchases(filer, p.to, r.purchases), reliefFileName(filer, "P", p.to)); }
      case "slsp-csv": {
        const r = await slsp(org.id, p);
        const rows = [
          ...r.sales.map((s) => ["SALES", formatTin(s.party.tin), party(s.party), s.party.address, s.exempt, s.zeroRated, s.taxable, s.outputTax, "", "", "", s.gross]),
          ...r.purchases.map((s) => ["PURCHASES", formatTin(s.party.tin), party(s.party), s.party.address, s.exempt, s.zeroRated, s.goods, s.inputTax, s.services, s.capitalGoods, "", s.grossTaxable]),
        ];
        return send(csv(["List", "TIN", "Name", "Address", "Exempt", "Zero-rated", "Taxable sales / goods other than capital", "Output / input tax", "Services", "Capital goods", "", "Gross"], rows), `SLSP-${p.label.replace(" ", "-")}.csv`, "text/csv");
      }
      case "qap": case "qap-csv": {
        const form = q.get("form") === "1601FQ" ? "1601FQ" : "1601EQ";
        const r = await qap(org.id, form, year, Math.min(4, n));
        if (type === "qap") return send(qapDat(filer, form, p.to, r.rows), alphaFileName(filer, p.to, form));
        return send(csv(["Seq", "TIN", "Branch", "Payee", "ATC", "Rate", "Income payment", "Tax withheld"], r.rows.map((x, i) => [i + 1, x.tin9, x.branch, party(x.party), x.atcCode, x.rate, x.base, x.tax])), `QAP-${form}-${p.label.replace(" ", "-")}.csv`, "text/csv");
      }
      case "sawt": case "sawt-csv": {
        const form = (["2550Q", "2551Q", "1702Q", "1701Q"] as const).find((f) => f === q.get("form")) ?? "2550Q";
        const r = await sawt(org.id, p, form);
        if (type === "sawt") return send(sawtDat(filer, form, p.to, r.rows), alphaFileName(filer, p.to, form));
        return send(csv(["Seq", "TIN", "Branch", "Withholding agent", "ATC", "Rate", "Income payment", "Tax withheld"], r.rows.map((x, i) => [i + 1, x.tin9, x.branch, party(x.party), x.atcCode, x.rate, x.base, x.tax])), `SAWT-${form}-${p.label.replace(" ", "-")}.csv`, "text/csv");
      }
      case "alpha": case "alpha-csv": {
        if (q.get("kind") === "1604C") {
          const rows = (await alphalistEmployees(org.id, year)) ?? [];
          if (type === "alpha") return send(alphalist1604CDat(filer, year, rows), alphaFileName(filer, new Date(Date.UTC(year, 11, 31)), "1604C"));
          return send(csv(
            ["Schedule", "Seq", "TIN", "Branch", "Employee code", "Last name", "First name", "Middle name", "Period from", "Period to", "MWE", "Gross compensation", "Non-taxable", "Taxable", "Taxable from previous employer", "Tax due", "Withheld Jan-Nov", "Withheld total (present employer)", "Withheld previous employer", "Substituted filing", "2316 status"],
            rows.map((r, i) => [r.schedule, i + 1, r.tin9, r.branch, r.employeeCode, r.lastName, r.firstName, r.middleName, r.periodFrom, r.periodTo, r.minimumWageEarner ? "Y" : "N", r.grossCompensation, nonTaxableTotal(r).toFixed(2), taxableTotal(r).toFixed(2), r.taxableFromPreviousEmployer ?? "0.00", r.taxDue, r.taxWithheldJanNov ?? "", r.taxWithheldPresent, r.taxWithheldPrevious ?? "0.00", r.substitutedFiling ? "Y" : "N", r.formStatus ?? ""]),
          ), `1604C-${year}.csv`, "text/csv");
        }
        const kind = q.get("kind") === "1604F" ? "1604F" : "1604E";
        const r = await alphalist(org.id, kind, year);
        if (type === "alpha") return send(alphalistDat(filer, kind, year, r.rows), alphaFileName(filer, new Date(Date.UTC(year, 11, 31)), kind));
        return send(csv(["Seq", "TIN", "Branch", "Payee", "ATC", "Rate", "Income payments", "Tax withheld"], r.rows.map((x, i) => [i + 1, x.tin9, x.branch, party(x.party), x.atcCode, x.rate, x.base, x.tax])), `${kind}-${year}.csv`, "text/csv");
      }
      case "2307-csv": {
        const c = await certificates2307(org.id, year, Math.min(4, n));
        const rows = c.payees.flatMap((pp) => pp.rows.map((r) => [formatTin(pp.party.tin), pp.party.name, pp.party.address, formatTin(org.tin), org.name, r.atcCode, r.rate, r.months[0], r.months[1], r.months[2], r.base, r.tax]));
        return send(csv(["Payee TIN", "Payee", "Payee address", "Payor TIN", "Payor", "ATC", "Rate", "Month 1", "Month 2", "Month 3", "Total", "Tax withheld"], rows), `2307-${c.period.label.replace(" ", "-")}.csv`, "text/csv");
      }
      case "return": {
        const form = q.get("form") ?? "";
        if (!isForm(form)) return new NextResponse("Unknown return", { status: 400 });
        const r = await computeReturn(org.id, form, year, n);
        const rows = r.sections.flatMap((s) => s.rows.map((x) => [s.title, x.label, x.base ?? "", x.rate ?? "", x.tax ?? ""]));
        rows.push(["", "Total amount payable", "", "", fromCentavos(r.taxDue)]);
        return send(csv(["Section", "Item", "Amount / tax base", "Rate", "Tax"], rows), `${form}-${r.period.label.replace(/\s+/g, "-")}.csv`, "text/csv");
      }
      case "book": {
        const kind = q.get("book") ?? "";
        if (!isBook(kind)) return new NextResponse("Unknown book", { status: 400 });
        const from = q.get("from") ?? `${year}-01-01`, to = q.get("to") ?? `${year}-12-31`;
        const rows = (await book(org.id, kind, new Date(from), new Date(to))).flatMap((e) => e.lines.map((l) => [e.date, e.number, e.reference, e.memo, l.accountCode, l.accountName, l.description, l.debit, l.credit]));
        return send(csv(["Date", "Entry no.", "Reference", "Particulars", "Account code", "Account", "Line description", "Debit", "Credit"], rows), `${BOOKS[kind].replace(/\s+/g, "-")}-${from}-to-${to}.csv`, "text/csv");
      }
    }
    return new NextResponse("Unknown file", { status: 404 });
  } catch (e) {
    return new NextResponse((e as Error).message, { status: 400 });
  }
}
