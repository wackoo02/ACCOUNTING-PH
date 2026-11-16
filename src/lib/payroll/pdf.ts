// PDF documents for payroll and HR (payslips, BIR 2316, registers, attendance and leave reports).
// Reports for admins and managers are PDF only by design.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const PURPLE = rgb(0.427, 0.157, 0.851);
const GREY = rgb(0.45, 0.45, 0.5);
const LINE = rgb(0.82, 0.82, 0.86);

export const peso = (n: number) => {
  const neg = n < 0;
  const s = Math.abs(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `(${s})` : s;
};

// Standard PDF fonts only cover WinAnsi characters: replace anything else.
const clean = (s: unknown) => String(s ?? "").replace(/₱/g, "P").replace(/[–—]/g, "-").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

export type Col = { header: string; width: number; align?: "left" | "right" };

export class Doc {
  pdf!: PDFDocument;
  font!: PDFFont;
  bold!: PDFFont;
  page!: PDFPage;
  y = 0;
  readonly margin = 36;
  constructor(private landscape = false, private header?: { company: string; title: string; subtitle?: string }) {}

  static async create(opts: { landscape?: boolean; company: string; title: string; subtitle?: string }) {
    const d = new Doc(!!opts.landscape, opts);
    d.pdf = await PDFDocument.create();
    d.pdf.setTitle(`${opts.title} - ${opts.company}`);
    d.pdf.setProducer("Veritus ERP");
    d.font = await d.pdf.embedFont(StandardFonts.Helvetica);
    d.bold = await d.pdf.embedFont(StandardFonts.HelveticaBold);
    d.addPage();
    return d;
  }
  get width() { return this.page.getWidth(); }
  get inner() { return this.width - this.margin * 2; }

  addPage() {
    this.page = this.pdf.addPage(this.landscape ? [842, 595] : [595, 842]);
    this.y = this.page.getHeight() - this.margin;
    if (this.header) {
      this.text(this.header.company, { size: 9, color: GREY });
      this.text(this.header.title, { size: 14, font: this.bold, color: PURPLE });
      if (this.header.subtitle) this.text(this.header.subtitle, { size: 9, color: GREY });
      this.y -= 6;
    }
  }
  ensure(h: number) { if (this.y - h < this.margin + 14) this.addPage(); }

  text(s: string, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; gap?: number } = {}) {
    const size = o.size ?? 9;
    this.ensure(size + 4);
    this.page.drawText(clean(s), { x: o.x ?? this.margin, y: this.y - size, size, font: o.font ?? this.font, color: o.color ?? rgb(0, 0, 0) });
    this.y -= size + (o.gap ?? 4);
  }
  at(s: string, x: number, y: number, o: { size?: number; font?: PDFFont; align?: "left" | "right"; width?: number; color?: ReturnType<typeof rgb> } = {}) {
    const size = o.size ?? 8.5, font = o.font ?? this.font;
    let t = clean(s);
    if (o.width) while (t.length > 1 && font.widthOfTextAtSize(t, size) > o.width - 2) t = t.slice(0, -1);
    const w = font.widthOfTextAtSize(t, size);
    this.page.drawText(t, { x: o.align === "right" && o.width ? x + o.width - w - 2 : x + 2, y, size, font, color: o.color ?? rgb(0, 0, 0) });
  }
  rule(color = LINE) { this.page.drawLine({ start: { x: this.margin, y: this.y }, end: { x: this.width - this.margin, y: this.y }, thickness: 0.6, color }); this.y -= 4; }
  space(h = 8) { this.y -= h; }

  /** Key/value pairs in two columns. */
  fields(pairs: [string, string][], cols = 2) {
    const w = this.inner / cols;
    for (let i = 0; i < pairs.length; i += cols) {
      this.ensure(14);
      for (let c = 0; c < cols && i + c < pairs.length; c++) {
        const [k, v] = pairs[i + c];
        this.at(k, this.margin + c * w, this.y - 9, { size: 7.5, color: GREY, width: w * 0.42 });
        this.at(v, this.margin + c * w + w * 0.42, this.y - 9, { size: 8.5, font: this.bold, width: w * 0.58 });
      }
      this.y -= 13;
    }
  }

  /** A table; widths are fractions of the page's inner width. Rows starting with "**" are bold totals. */
  table(cols: Col[], rows: (string | number)[][], o: { size?: number; boldLast?: boolean } = {}) {
    const size = o.size ?? 8;
    const total = cols.reduce((n, c) => n + c.width, 0);
    const xs: number[] = []; let x = this.margin;
    const ws = cols.map((c) => (c.width / total) * this.inner);
    for (const w of ws) { xs.push(x); x += w; }
    const head = () => {
      this.ensure(size + 10);
      this.page.drawRectangle({ x: this.margin, y: this.y - size - 5, width: this.inner, height: size + 6, color: rgb(0.95, 0.94, 0.99) });
      cols.forEach((c, i) => this.at(c.header, xs[i], this.y - size - 1, { size: size - 0.5, font: this.bold, align: c.align, width: ws[i] }));
      this.y -= size + 8;
    };
    head();
    rows.forEach((r, ri) => {
      if (this.y - size - 6 < this.margin + 14) { this.addPage(); head(); }
      const isBold = (o.boldLast && ri === rows.length - 1) || String(r[0]).startsWith("**");
      cols.forEach((c, i) => {
        const v = typeof r[i] === "number" ? peso(r[i] as number) : String(r[i] ?? "").replace(/^\*\*/, "");
        this.at(v, xs[i], this.y - size, { size, font: isBold ? this.bold : this.font, align: c.align ?? (typeof r[i] === "number" ? "right" : "left"), width: ws[i] });
      });
      this.y -= size + 5;
      if (isBold) { this.page.drawLine({ start: { x: this.margin, y: this.y + size + 4 }, end: { x: this.width - this.margin, y: this.y + size + 4 }, thickness: 0.5, color: LINE }); }
    });
    this.y -= 4;
  }

  signatures(labels: string[]) {
    this.ensure(50);
    this.y -= 30;
    const w = this.inner / labels.length;
    labels.forEach((l, i) => {
      const x = this.margin + i * w;
      this.page.drawLine({ start: { x: x + 6, y: this.y }, end: { x: x + w - 12, y: this.y }, thickness: 0.6, color: GREY });
      this.at(l, x + 4, this.y - 10, { size: 7.5, color: GREY });
    });
    this.y -= 18;
  }

  async bytes() {
    const pages = this.pdf.getPages();
    pages.forEach((p, i) => p.drawText(`Page ${i + 1} of ${pages.length} - generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by Veritus ERP`, { x: this.margin, y: 18, size: 6.5, font: this.font, color: GREY }));
    return this.pdf.save();
  }
}
