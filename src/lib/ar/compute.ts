// Pure invoice arithmetic (no database). Amounts are integer centavos.
// Philippine VAT is 12%. A VAT-registered seller splits sales into VATable, zero-rated and VAT-exempt;
// a non-VAT seller's sales carry no VAT (percentage tax is handled by the tax module).
import { toCentavos } from "../money";

export const VAT_RATE_BP = 1200n; // 12.00% in basis points
export type VatType = "VATABLE" | "ZERO_RATED" | "EXEMPT";
export const VAT_TYPES: VatType[] = ["VATABLE", "ZERO_RATED", "EXEMPT"];
export const VAT_LABELS: Record<VatType, string> = { VATABLE: "VATable (12%)", ZERO_RATED: "Zero-rated (0%)", EXEMPT: "VAT-exempt" };

export type LineCalcInput = { quantity: string; unitPrice: string; discount?: string | null; vatType: VatType };
export type LineCalc = { gross: bigint; net: bigint; vat: bigint };
export type InvoiceCalc = {
  lines: LineCalc[];
  vatableSales: bigint; vatAmount: bigint; zeroRatedSales: bigint; exemptSales: bigint; discount: bigint;
  total: bigint;      // what the customer owes (VAT included)
  ewt: bigint;        // expected creditable withholding tax
  amountDue: bigint;  // total less withholding
};

/** Quantity (up to 4 decimals) x unit price (up to 4 decimals), rounded half-up to centavos. */
export function extend(quantity: string, unitPrice: string): bigint {
  const q = scaled(quantity, 4, "Quantity");
  const p = scaled(unitPrice, 4, "Unit price");
  const prod = q * p; // scale 10^8; centavos = /10^6
  const neg = prod < 0n;
  const abs = neg ? -prod : prod;
  const c = (abs + 500_000n) / 1_000_000n;
  return neg ? -c : c;
}

function scaled(v: string, dp: number, label: string): bigint {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) throw new Error(`${label}: enter a number`);
  if (!new RegExp(`^-?\\d+(\\.\\d{0,${dp}})?$`).test(s)) throw new Error(`${label}: "${s}" is not a valid number (up to ${dp} decimals)`);
  const neg = s.startsWith("-");
  const [w, f = ""] = s.replace("-", "").split(".");
  const n = BigInt(w) * 10n ** BigInt(dp) + BigInt((f + "0".repeat(dp)).slice(0, dp));
  return neg ? -n : n;
}

const div = (a: bigint, b: bigint) => (a * 2n + b) / (2n * b); // half-up for positives

/**
 * Work out an invoice. `pricesIncludeVat`: unit prices already include 12% VAT (retail style);
 * otherwise VAT is added on top. VAT is computed once on total VATable sales (as printed on the
 * invoice) and any centavo difference is absorbed by the largest VATable line.
 */
export function computeInvoice(lines: LineCalcInput[], opts: { pricesIncludeVat: boolean; vatRegistered: boolean; ewtRatePct?: string | null }): InvoiceCalc {
  const out: LineCalc[] = [];
  let discount = 0n;
  for (const l of lines) {
    const ext = extend(l.quantity, l.unitPrice);
    const d = toCentavos(l.discount ?? "0");
    if (d < 0n) throw new Error("Discount cannot be negative");
    if (d > ext) throw new Error("Discount cannot be more than the line amount");
    discount += d;
    const gross = ext - d;
    out.push({ gross, net: gross, vat: 0n });
  }
  const vatable = (i: number) => opts.vatRegistered && lines[i].vatType === "VATABLE";
  let vatAmount = 0n, vatableSales = 0n;
  const vIdx = out.map((_, i) => i).filter(vatable);
  if (vIdx.length) {
    const sumGross = vIdx.reduce((s, i) => s + out[i].gross, 0n);
    if (opts.pricesIncludeVat) {
      vatableSales = div(sumGross * 10000n, 10000n + VAT_RATE_BP);
      vatAmount = sumGross - vatableSales;
      for (const i of vIdx) out[i].net = div(out[i].gross * 10000n, 10000n + VAT_RATE_BP);
    } else {
      vatableSales = sumGross;
      vatAmount = div(sumGross * VAT_RATE_BP, 10000n);
    }
    const netSum = vIdx.reduce((s, i) => s + out[i].net, 0n);
    const big = vIdx.reduce((a, b) => (out[b].net > out[a].net ? b : a), vIdx[0]);
    out[big].net += vatableSales - netSum;
    // Spread VAT over lines in proportion (for revenue by line); last centavos on the largest line.
    let vatLeft = vatAmount;
    for (const i of vIdx) { out[i].vat = vatableSales ? (vatAmount * out[i].net) / vatableSales : 0n; vatLeft -= out[i].vat; }
    out[big].vat += vatLeft;
    for (const i of vIdx) out[i].gross = out[i].net + out[i].vat;
  }
  let zeroRatedSales = 0n, exemptSales = 0n;
  out.forEach((l, i) => {
    if (vatable(i)) return;
    if (opts.vatRegistered && lines[i].vatType === "ZERO_RATED") zeroRatedSales += l.net;
    else exemptSales += l.net;
  });
  const total = vatableSales + vatAmount + zeroRatedSales + exemptSales;
  const base = vatableSales + zeroRatedSales + exemptSales; // withholding is on the amount before VAT
  const rate = opts.ewtRatePct ? scaled(opts.ewtRatePct, 4, "Withholding rate") : 0n; // percent x 10^4
  const ewt = rate ? div(base * rate, 1_000_000n) : 0n;
  return { lines: out, vatableSales, vatAmount, zeroRatedSales, exemptSales, discount, total, ewt, amountDue: total - ewt };
}

/** Days past due as of a date (negative = not yet due). */
export function daysPastDue(dueDate: Date, asOf: Date) {
  return Math.floor((asOf.getTime() - dueDate.getTime()) / 86_400_000);
}

export const AGING_BUCKETS = ["Current", "1-30", "31-60", "61-90", "91-120", "Over 120"] as const;
export function bucketOf(days: number): number {
  if (days <= 0) return 0;
  if (days <= 30) return 1;
  if (days <= 60) return 2;
  if (days <= 90) return 3;
  if (days <= 120) return 4;
  return 5;
}

/** Parse "a@x.ph; b@y.ph, c@z.ph" into a clean list. */
export function parseEmails(s: string | null | undefined): string[] {
  return [...new Set(String(s ?? "").split(/[;,\s]+/).map((e) => e.trim()).filter(Boolean))];
}
export const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

export function addDays(d: Date, n: number) {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Next billing date for a recurring contract. Keeps the day of month (clamped to month end). */
export function advance(d: Date, frequency: string, anchorDay?: number): Date {
  const months = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 }[frequency] ?? 1;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
  const day = anchorDay ?? d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}
