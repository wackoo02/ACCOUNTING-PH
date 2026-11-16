// PDFs of sales invoices / credit memos (BIR-registered layout), collection receipts and statements
// of account. Built with pdf-lib so they render the same on the server for email attachments.
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { formatPeso, toCentavos } from "../money";
import { LedgerError } from "../ledger/service";
import { AGING_BUCKETS } from "./compute";
import { METHODS } from "./service";
import { customerStatement } from "./reports";

const cents = (d: Prisma.Decimal | string | null | undefined) => toCentavos(d?.toString() ?? "0");
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "");
const longDate = (d: Date) => d.toLocaleDateString("en-PH", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const INK = rgb(0.1, 0.1, 0.12), MUTED = rgb(0.4, 0.4, 0.45), LINE = rgb(0.75, 0.75, 0.8), BRAND = rgb(0.427, 0.157, 0.851);

/** Standard PDF fonts only cover Latin-1. */
function clean(s: string | null | undefined) {
  return String(s ?? "").replace(/₱/g, "PHP ").replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

class Pdf {
  doc!: PDFDocument; page!: PDFPage; font!: PDFFont; bold!: PDFFont;
  readonly W = 612; readonly H = 792; readonly M = 40;
  y = 0;
  static async create() {
    const p = new Pdf();
    p.doc = await PDFDocument.create();
    p.font = await p.doc.embedFont(StandardFonts.Helvetica);
    p.bold = await p.doc.embedFont(StandardFonts.HelveticaBold);
    p.addPage();
    return p;
  }
  addPage() { this.page = this.doc.addPage([this.W, this.H]); this.y = this.H - this.M; }
  width(s: string, size = 9, bold = false) { return (bold ? this.bold : this.font).widthOfTextAtSize(clean(s), size); }
  text(s: string, x: number, y: number, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; align?: "left" | "right" | "center"; maxWidth?: number } = {}) {
    const size = o.size ?? 9;
    let t = clean(s);
    if (o.maxWidth) while (t.length > 1 && this.width(t, size, o.bold) > o.maxWidth) t = t.slice(0, -1);
    const w = this.width(t, size, o.bold);
    const dx = o.align === "right" ? -w : o.align === "center" ? -w / 2 : 0;
    this.page.drawText(t, { x: x + dx, y, size, font: o.bold ? this.bold : this.font, color: o.color ?? INK });
  }
  /** Wrap text into lines that fit `width`. */
  wrap(s: string, width: number, size = 9) {
    const words = clean(s).split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (this.width(next, size) > width && cur) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }
  hline(y: number, x1 = this.M, x2 = this.W - this.M, color = LINE) { this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.6, color }); }
  box(x: number, y: number, w: number, h: number) { this.page.drawRectangle({ x, y, width: w, height: h, borderColor: LINE, borderWidth: 0.6 }); }
  stamp(s: string) {
    for (const pg of this.doc.getPages()) pg.drawText(s, { x: 120, y: 260, size: 54, font: this.bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.18, rotate: degrees(35) });
  }
  async bytes() { return this.doc.save(); }
}

type Org = Prisma.OrganizationGetPayload<object>;
type Series = Prisma.DocumentSeriesGetPayload<object> | null;

function tinLine(org: Org, series: Series) {
  const tin = org.tin ?? "(set the TIN in Company Settings)";
  const digits = (org.tin ?? "").replace(/\D/g, "");
  const branch = series?.branchCode && digits.length <= 9 ? `-${series.branchCode}` : "";
  return `${org.vatRegistered ? "VAT REG. TIN" : "NON-VAT REG. TIN"}: ${tin}${branch}`;
}

/** Seller block, top left. Returns the y below it. */
function sellerHeader(p: Pdf, org: Org, series: Series) {
  let y = p.H - p.M;
  p.text(org.name, p.M, y - 4, { size: 14, bold: true, color: BRAND, maxWidth: 330 });
  y -= 20;
  if (org.tradeName) { p.text(org.tradeName, p.M, y, { size: 9, maxWidth: 330 }); y -= 12; }
  for (const l of p.wrap(org.registeredAddress ?? "(set the registered address in Company Settings)", 330, 9).slice(0, 2)) { p.text(l, p.M, y, { color: MUTED }); y -= 12; }
  p.text(tinLine(org, series), p.M, y, { bold: true });
  return y - 10;
}

function titleBlock(p: Pdf, title: string, number: string | null | false, date: Date, extra: [string, string][] = []) {
  const x = p.W - p.M;
  let y = p.H - p.M - 4;
  p.text(title, x, y, { size: 16, bold: true, align: "right" });
  y -= 18;
  if (number !== false) {
    p.text(`No. ${number ?? "(not yet issued)"}`, x, y, { size: 12, bold: true, color: rgb(0.75, 0.1, 0.1), align: "right" });
    y -= 15;
  }
  p.text(`Date: ${longDate(date)}`, x, y, { align: "right" });
  for (const [k, v] of extra) { y -= 12; p.text(`${k}: ${v}`, x, y, { align: "right" }); }
}

function permitFooter(p: Pdf, series: Series, opts: { supplementary?: boolean; vatRegistered: boolean }) {
  let y = p.M + 34;
  p.hline(y + 10);
  const small = { size: 7, color: MUTED };
  if (series) {
    const range = `${series.prefix}${String(series.startNo).padStart(series.padding, "0")}-${series.endNo ? `${series.prefix}${String(series.endNo).padStart(series.padding, "0")}` : "onwards"}`;
    const auth = series.authorityType === "ATP" ? "BIR Authority to Print No." : series.authorityType === "CAS" ? "CAS Acknowledgement Certificate No." : series.authorityType === "CRM_POS" ? "CRM/POS Permit to Use No." : "EIS Certificate No.";
    p.text(`${auth} ${series.authorityNo ?? "________"}  Date issued: ${ymd(series.authorityDate) || "________"}${series.validUntil ? `  Valid until: ${ymd(series.validUntil)}` : ""}  Series: ${range}`, p.M, y, small);
    y -= 9;
    if (series.printerName) {
      p.text(`Printer: ${series.printerName}${series.printerTin ? `  TIN ${series.printerTin}` : ""}${series.printerAddress ? `  ${series.printerAddress}` : ""}`, p.M, y, { ...small, maxWidth: p.W - 2 * p.M });
      y -= 9;
      if (series.printerAccreditationNo) { p.text(`Printer's Accreditation No. ${series.printerAccreditationNo}  Date issued: ${ymd(series.printerAccreditationDate)}`, p.M, y, small); y -= 9; }
    }
  } else {
    p.text("BIR permit details not set up (Receivables > Invoice Series). Not valid as a BIR-registered invoice until they are.", p.M, y, small);
    y -= 9;
  }
  if (opts.supplementary || !opts.vatRegistered) p.text("THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX.", p.W / 2, y - 2, { size: 8, bold: true, align: "center" });
  p.text("Generated by Veritus ERP", p.W - p.M, p.M - 10, { size: 6, color: MUTED, align: "right" });
}

async function orgAndSeries(organizationId: string, seriesId: string | null, docType: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const series = seriesId
    ? await prisma.documentSeries.findUnique({ where: { id: seriesId } })
    : await prisma.documentSeries.findFirst({ where: { organizationId, docType, isActive: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  return { org, series };
}

export async function invoicePdf(organizationId: string, id: string) {
  const inv = await prisma.salesInvoice.findFirst({ where: { id, organizationId }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!inv) throw new LedgerError(["Document not found"]);
  const cm = inv.kind === "CREDIT_MEMO";
  const { org, series } = await orgAndSeries(organizationId, inv.seriesId, cm ? "CREDIT_MEMO" : "SALES_INVOICE");
  const [ewt, creditFor] = await Promise.all([
    inv.ewtTaxCodeId ? prisma.taxCode.findUnique({ where: { id: inv.ewtTaxCodeId } }) : null,
    inv.creditForId ? prisma.salesInvoice.findUnique({ where: { id: inv.creditForId } }) : null,
  ]);
  const p = await Pdf.create();
  const ccy = inv.currencyCode === org.baseCurrency ? "" : `${inv.currencyCode} `;
  const m = (c: bigint) => `${ccy}${formatPeso(c)}`;
  let y = sellerHeader(p, org, series);
  titleBlock(p, cm ? "CREDIT MEMO" : "SALES INVOICE", inv.number, inv.date, cm ? [] : [["Terms", inv.termsDays ? `${inv.termsDays} days` : "Cash / due on receipt"], ["Due date", longDate(inv.dueDate)]]);

  // Buyer
  y -= 8;
  const bh = 62;
  p.box(p.M, y - bh, p.W - 2 * p.M, bh);
  const L = p.M + 8;
  p.text(cm ? "Issued to" : "Sold to", L, y - 13, { size: 7, color: MUTED });
  p.text(inv.customerName, L, y - 25, { size: 10, bold: true, maxWidth: 330 });
  p.text(`TIN: ${inv.customerTin ?? ""}`, L, y - 37);
  p.text(`Address: ${inv.customerAddress ?? ""}`, L, y - 49, { maxWidth: 340 });
  if (inv.customerBusinessStyle) p.text(`Business style: ${inv.customerBusinessStyle}`, L, y - 59, { size: 8, maxWidth: 340 });
  const R = p.W - p.M - 8;
  if (inv.reference) p.text(`Ref. / PO: ${inv.reference}`, R, y - 25, { align: "right", maxWidth: 170 });
  if (creditFor) p.text(`For invoice no. ${creditFor.number} (${ymd(creditFor.date)})`, R, y - 37, { align: "right", maxWidth: 170 });
  if (ccy) p.text(`Currency: ${inv.currencyCode}`, R, y - 49, { align: "right" });
  y -= bh + 14;

  // Lines
  const cols = { qty: p.M + 4, unit: p.M + 54, desc: p.M + 94, price: p.W - p.M - 96, amt: p.W - p.M - 4 };
  p.page.drawRectangle({ x: p.M, y: y - 4, width: p.W - 2 * p.M, height: 16, color: rgb(0.95, 0.94, 0.98) });
  p.text("QTY", cols.qty, y, { size: 8, bold: true });
  p.text("UNIT", cols.unit, y, { size: 8, bold: true });
  p.text(cm ? "PARTICULARS" : "ITEM DESCRIPTION / NATURE OF SERVICE", cols.desc, y, { size: 8, bold: true });
  p.text("UNIT PRICE", cols.price, y, { size: 8, bold: true, align: "right" });
  p.text("AMOUNT", cols.amt, y, { size: 8, bold: true, align: "right" });
  y -= 18;
  for (const l of inv.lines) {
    const desc = p.wrap(`${l.description}${l.vatType === "ZERO_RATED" && org.vatRegistered ? " (zero-rated)" : l.vatType === "EXEMPT" && org.vatRegistered ? " (VAT-exempt)" : ""}${cents(l.discount) > 0n ? ` - less discount ${formatPeso(cents(l.discount))}` : ""}`, cols.price - cols.desc - 70, 9);
    if (y - desc.length * 11 < 250) { p.addPage(); y = p.H - p.M; }
    const qty = Number(l.quantity);
    p.text(qty.toLocaleString("en-PH", { maximumFractionDigits: 4 }), cols.qty, y);
    p.text(l.unit ?? "", cols.unit, y, { maxWidth: 38 });
    desc.forEach((t, k) => p.text(t, cols.desc, y - k * 11));
    p.text(Number(l.unitPrice).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 4 }), cols.price, y, { align: "right" });
    const shown = inv.pricesIncludeVat ? cents(l.netAmount) + cents(l.vatAmount) : cents(l.netAmount);
    p.text(formatPeso(shown), cols.amt, y, { align: "right" });
    y -= desc.length * 11 + 4;
    p.hline(y + 6, p.M, p.W - p.M, rgb(0.9, 0.9, 0.92));
  }
  if (inv.memo) { y -= 4; for (const t of p.wrap(inv.memo, 400, 8).slice(0, 3)) { p.text(t, cols.desc, y, { size: 8, color: MUTED }); y -= 10; } }
  if (cm && inv.reason) { p.text(`Reason: ${inv.reason}`, cols.desc, y, { size: 8 }); y -= 10; }

  // Totals
  y = Math.min(y - 8, 300);
  const top = y;
  const vat = cents(inv.vatAmount), total = cents(inv.totalAmount), wht = cents(inv.ewtAmount);
  const left: [string, bigint][] = org.vatRegistered
    ? [["VATable Sales", cents(inv.vatableSales)], ["VAT-Exempt Sales", cents(inv.exemptSales)], ["Zero-Rated Sales", cents(inv.zeroRatedSales)], ["VAT Amount (12%)", vat]]
    : [["Total Sales", total]];
  p.box(p.M, top - left.length * 13 - 8, 230, left.length * 13 + 8);
  left.forEach(([k, v], i) => { p.text(k, p.M + 8, top - 13 - i * 13); p.text(m(v), p.M + 222, top - 13 - i * 13, { align: "right" }); });
  const right: [string, bigint, boolean][] = [];
  if (org.vatRegistered) {
    right.push(["Total Sales (VAT inclusive)", total, false], ["Less: VAT", vat, false], ["Amount: Net of VAT", total - vat, false]);
    if (cents(inv.discountAmount) > 0n) right.push(["Discount given (already deducted)", cents(inv.discountAmount), false]);
    right.push(["Add: VAT", vat, false]);
  } else if (cents(inv.discountAmount) > 0n) right.push(["Discount given (already deducted)", cents(inv.discountAmount), false]);
  if (wht > 0n && !cm) right.push([`Less: Withholding Tax${ewt ? ` (${ewt.atcCode ?? ewt.code} ${Number(ewt.rate)}%)` : ""}`, wht, false]);
  right.push([cm ? "TOTAL CREDIT" : "TOTAL AMOUNT DUE", cm ? total : total - (cm ? 0n : wht), true]);
  const rx = p.W - p.M - 250;
  p.box(rx, top - right.length * 13 - 8, 250, right.length * 13 + 8);
  right.forEach(([k, v, b], i) => { p.text(k, rx + 8, top - 13 - i * 13, { bold: b }); p.text(m(v), p.W - p.M - 8, top - 13 - i * 13, { align: "right", bold: b }); });
  y = top - Math.max(left.length, right.length) * 13 - 30;

  // Signatures
  if (!cm) p.text("Received the above goods / services in good order and condition.", p.M, y, { size: 8, color: MUTED });
  y -= 34;
  p.hline(y, p.M, p.M + 220, INK);
  p.hline(y, p.W - p.M - 220, p.W - p.M, INK);
  p.text(cm ? "Received by (customer)" : "Customer's signature over printed name / date", p.M, y - 10, { size: 7, color: MUTED });
  p.text("Authorized signature", p.W - p.M - 220, y - 10, { size: 7, color: MUTED });

  permitFooter(p, series, { vatRegistered: org.vatRegistered });
  if (inv.status === "VOID") p.stamp("CANCELLED");
  else if (inv.status !== "POSTED") p.stamp("DRAFT - NOT VALID");
  return { bytes: await p.bytes(), fileName: `${cm ? "CreditMemo" : "SalesInvoice"}-${inv.number ?? "draft"}.pdf` };
}

export async function receiptPdf(organizationId: string, id: string) {
  const r = await prisma.arReceipt.findFirst({ where: { id, organizationId } });
  if (!r) throw new LedgerError(["Collection not found"]);
  const { org, series } = await orgAndSeries(organizationId, r.seriesId, "COLLECTION_RECEIPT");
  const [customer, bank, tax, invs] = await Promise.all([
    prisma.customer.findUnique({ where: { id: r.customerId } }),
    prisma.bankAccount.findUnique({ where: { id: r.bankAccountId } }),
    r.withholdingTaxCodeId ? prisma.taxCode.findUnique({ where: { id: r.withholdingTaxCodeId } }) : null,
    prisma.salesInvoice.findMany({ where: { id: { in: (r.plan as { invoiceId: string }[]).map((a) => a.invoiceId) } } }),
  ]);
  const p = await Pdf.create();
  const ccy = r.currencyCode === org.baseCurrency ? "" : `${r.currencyCode} `;
  const m = (c: bigint) => `${ccy}${formatPeso(c)}`;
  let y = sellerHeader(p, org, series);
  titleBlock(p, "COLLECTION RECEIPT", r.number, r.date);
  y -= 16;
  const cash = cents(r.cashAmount), wht = cents(r.withholdingAmount);
  p.text("Received from", p.M, y, { size: 7, color: MUTED });
  p.text(r.customerName, p.M, y - 13, { size: 11, bold: true });
  p.text(`TIN: ${customer?.tin ?? ""}`, p.M, y - 26);
  p.text(`Address: ${customer?.address ?? ""}`, p.M, y - 38, { maxWidth: 400 });
  p.text("the sum of", p.W - p.M, y, { size: 7, color: MUTED, align: "right" });
  p.text(m(cash + wht), p.W - p.M, y - 15, { size: 14, bold: true, align: "right" });
  y -= 62;
  p.text("In payment of:", p.M, y, { bold: true });
  y -= 14;
  // What the receipt was issued for. Advances applied later are not part of the printed receipt.
  const apps = (r.plan as { invoiceId: string; amount: string }[]).map((a) => ({ invoiceId: a.invoiceId, amount: toCentavos(a.amount) }));
  for (const a of apps) {
    const inv = invs.find((i) => i.id === a.invoiceId);
    p.text(`Sales Invoice No. ${inv?.number ?? ""} dated ${ymd(inv?.date)}`, p.M + 10, y);
    p.text(m(a.amount), p.M + 380, y, { align: "right" });
    y -= 12;
  }
  const applied = apps.reduce((s, a) => s + a.amount, 0n);
  if (cash + wht - applied > 0n) { p.text("Advance payment / not yet applied", p.M + 10, y); p.text(m(cash + wht - applied), p.M + 380, y, { align: "right" }); y -= 12; }
  y -= 10;
  const rows: [string, string][] = [
    ["Form of payment", `${METHODS[r.method as keyof typeof METHODS] ?? r.method}${r.checkNo ? ` - check no. ${r.checkNo}${r.checkBank ? `, ${r.checkBank}` : ""}${r.checkDate ? `, dated ${ymd(r.checkDate)}` : ""}` : ""}`],
    ["Cash / check received", m(cash)],
  ];
  if (wht > 0n) rows.push([`Tax withheld (BIR 2307)${tax ? ` ${tax.atcCode ?? tax.code} ${Number(tax.rate)}%` : ""}`, m(wht)]);
  rows.push(["Total", m(cash + wht)]);
  if (bank) rows.push(["Deposited to", `${bank.name}`]);
  if (r.reference) rows.push(["Reference", r.reference]);
  for (const [k, v] of rows) { p.text(k, p.M, y, { color: MUTED }); p.text(v, p.M + 160, y, { bold: k === "Total", maxWidth: 360 }); y -= 13; }
  y -= 40;
  p.hline(y, p.W - p.M - 220, p.W - p.M, INK);
  p.text("Cashier / authorized representative", p.W - p.M - 220, y - 10, { size: 7, color: MUTED });
  permitFooter(p, series, { supplementary: true, vatRegistered: org.vatRegistered });
  if (r.status === "VOID") p.stamp("CANCELLED");
  else if (r.status !== "POSTED") p.stamp("DRAFT - NOT VALID");
  return { bytes: await p.bytes(), fileName: `CollectionReceipt-${r.number ?? "draft"}.pdf` };
}

export async function statementPdf(organizationId: string, customerId: string, from: Date, to: Date) {
  const st = await customerStatement(organizationId, customerId, from, to);
  if (!st) throw new LedgerError(["Customer not found"]);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const p = await Pdf.create();
  let y = sellerHeader(p, org, null);
  titleBlock(p, "STATEMENT OF ACCOUNT", false, to, [["Period", `${ymd(st.from)} to ${ymd(st.to)}`]]);
  y -= 14;
  p.text(st.customer.name, p.M, y, { size: 11, bold: true });
  p.text(`${st.customer.code}${st.customer.tin ? `  ·  TIN ${st.customer.tin}` : ""}`, p.M, y - 12, { color: MUTED });
  if (st.customer.address) p.text(st.customer.address, p.M, y - 24, { color: MUTED, maxWidth: 400 });
  y -= 44;
  const c = { date: p.M + 2, no: p.M + 62, desc: p.M + 150, chg: p.W - p.M - 150, cr: p.W - p.M - 75, bal: p.W - p.M - 2 };
  const header = () => {
    p.page.drawRectangle({ x: p.M, y: y - 4, width: p.W - 2 * p.M, height: 16, color: rgb(0.95, 0.94, 0.98) });
    p.text("DATE", c.date, y, { size: 8, bold: true }); p.text("DOCUMENT", c.no, y, { size: 8, bold: true }); p.text("DESCRIPTION", c.desc, y, { size: 8, bold: true });
    p.text("CHARGES", c.chg, y, { size: 8, bold: true, align: "right" }); p.text("CREDITS", c.cr, y, { size: 8, bold: true, align: "right" }); p.text("BALANCE", c.bal, y, { size: 8, bold: true, align: "right" });
    y -= 18;
  };
  header();
  p.text(ymd(st.from), c.date, y); p.text("Balance forward", c.desc, y, { bold: true }); p.text(formatPeso(st.opening), c.bal, y, { align: "right" });
  y -= 13;
  const tag = { INVOICE: "SI", CREDIT_MEMO: "CM", PAYMENT: "OR" } as const;
  for (const l of st.lines) {
    if (y < 150) { p.addPage(); y = p.H - p.M; header(); }
    p.text(ymd(l.date), c.date, y); p.text(`${tag[l.type]} ${l.number ?? ""}`, c.no, y, { maxWidth: 85 }); p.text(l.description, c.desc, y, { maxWidth: c.chg - c.desc - 70 });
    p.text(formatPeso(l.charges, { blankZero: true }), c.chg, y, { align: "right" }); p.text(formatPeso(l.credits, { blankZero: true }), c.cr, y, { align: "right" }); p.text(formatPeso(l.balance), c.bal, y, { align: "right" });
    y -= 13;
  }
  p.hline(y + 8);
  y -= 4;
  p.text(`AMOUNT DUE${st.customer.currencyCode !== org.baseCurrency ? ` (${st.customer.currencyCode})` : ""}`, c.cr, y, { bold: true, align: "right" });
  p.text(formatPeso(st.closing), c.bal, y, { bold: true, align: "right" });
  y -= 30;
  if (st.aging) {
    const b = AGING_BUCKETS.map((_, k) => st.aging!.rows.filter((r) => r.bucket === k).reduce((s, r) => s + r.open, 0n));
    const w = (p.W - 2 * p.M) / AGING_BUCKETS.length;
    p.text("Aging of unpaid invoices (days past due)", p.M, y, { bold: true });
    y -= 16;
    AGING_BUCKETS.forEach((label, k) => { p.box(p.M + k * w, y - 22, w, 30); p.text(label, p.M + k * w + w / 2, y, { size: 7, color: MUTED, align: "center" }); p.text(formatPeso(b[k]), p.M + k * w + w / 2, y - 14, { align: "center", bold: true }); });
    y -= 44;
  }
  p.text("Please examine this statement and report any discrepancy within 15 days. Kindly disregard if payment has already been made.", p.M, y, { size: 8, color: MUTED });
  p.text("Generated by Veritus ERP", p.W - p.M, p.M - 10, { size: 6, color: MUTED, align: "right" });
  return { bytes: await p.bytes(), fileName: `Statement-${st.customer.code}-${ymd(st.to)}.pdf` };
}
