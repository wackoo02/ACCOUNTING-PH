// Pure AP and purchasing math: line amounts, VAT, EWT, 3-way match and aging buckets.
// No database access, so it is unit-tested directly. Money is integer centavos.
import { fromCentavos } from "../money";

export const CATEGORIES = ["EXPENSE", "INVENTORY", "FIXED_ASSET", "PREPAYMENT"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABELS: Record<Category, string> = { EXPENSE: "Expense", INVENTORY: "Inventory", FIXED_ASSET: "Fixed asset (PPE)", PREPAYMENT: "Prepayment" };
export const VAT_TYPES = ["VATABLE", "ZERO_RATED", "EXEMPT"] as const;
export type VatType = (typeof VAT_TYPES)[number];
export const VAT_LABELS: Record<VatType, string> = { VATABLE: "VATable 12%", ZERO_RATED: "Zero-rated", EXEMPT: "VAT-exempt" };
export const VAT_RATE = 12n;

/** Parse a number with up to 4 decimals into ten-thousandths (1.5 -> 15000). */
export function q4(v: string | number | null | undefined, label = "Quantity"): bigint {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d{0,4})?$/.test(s)) throw new Error(`${label}: enter a number with up to 4 decimals`);
  const neg = s.startsWith("-");
  const [w, f = ""] = s.replace("-", "").split(".");
  const n = BigInt(w) * 10000n + BigInt((f + "0000").slice(0, 4));
  return neg ? -n : n;
}
export const fromQ4 = (n: bigint) => {
  const neg = n < 0n; const a = neg ? -n : n;
  const f = String(a % 10000n).padStart(4, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / 10000n}${f ? "." + f : ""}`;
};
export const roundDiv = (n: bigint, d: bigint) => (n >= 0n ? (n * 2n + d) / (2n * d) : -((-n * 2n + d) / (2n * d)));

export type LineIn = { quantity: string | number; unitPrice: string | number; vatType?: string | null; ewtRate?: string | number | null };
export type LineOut = { qty: bigint; price: bigint; gross: bigint; net: bigint; vat: bigint; ewt: bigint };

/**
 * One purchase line. gross = qty x unit price as entered. If `vatInclusive`, VAT is the 12/112 share
 * of gross; otherwise VAT is 12% on top. No VAT for non-VAT suppliers or zero-rated/exempt lines.
 * EWT is on the amount net of VAT.
 */
export function calcLine(l: LineIn, opts: { vatInclusive: boolean; vendorVatRegistered: boolean }): LineOut {
  const qty = q4(l.quantity);
  const price = q4(l.unitPrice, "Unit price");
  const gross = roundDiv(qty * price, 1000000n); // ten-thousandths x ten-thousandths -> centavos
  const vatable = opts.vendorVatRegistered && (l.vatType ?? "VATABLE") === "VATABLE";
  let net = gross, vat = 0n;
  if (vatable) {
    if (opts.vatInclusive) { vat = roundDiv(gross * VAT_RATE, 100n + VAT_RATE); net = gross - vat; }
    else vat = roundDiv(gross * VAT_RATE, 100n);
  }
  const rate = l.ewtRate === null || l.ewtRate === undefined || l.ewtRate === "" ? 0n : q4(l.ewtRate, "EWT rate"); // percent x 10,000
  const ewt = roundDiv(net * rate, 1000000n);
  return { qty, price, gross, net, vat, ewt };
}

export type DocTotals = { subtotal: bigint; vat: bigint; total: bigint; ewt: bigint; netPayable: bigint };
export function totals(lines: LineOut[]): DocTotals {
  const subtotal = lines.reduce((s, l) => s + l.net, 0n);
  const vat = lines.reduce((s, l) => s + l.vat, 0n);
  const ewt = lines.reduce((s, l) => s + l.ewt, 0n);
  return { subtotal, vat, total: subtotal + vat, ewt, netPayable: subtotal + vat - ewt };
}

/** Net unit cost (VAT excluded) of a PO line, in ten-thousandths of a peso. */
export function netUnitCost(unitPrice: bigint, vatType: string, vatInclusive: boolean, vendorVatRegistered: boolean) {
  if (!vatInclusive || !vendorVatRegistered || vatType !== "VATABLE") return unitPrice;
  return roundDiv(unitPrice * 100n, 100n + VAT_RATE);
}

/**
 * 3-way match for one bill line against its PO line: quantity billed cannot exceed what was received
 * and not yet billed; a different price is allowed but reported (the difference goes to the line's account).
 * Returns the amount to clear from Goods Received Not Yet Invoiced (at the PO's cost) and any messages.
 */
export function matchLine(input: { lineNo: number; billQty: bigint; billNet: bigint; poNetUnit: bigint; received: bigint; billedElsewhere: bigint; ordered: bigint }) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const open = input.received - input.billedElsewhere;
  if (input.received === 0n) errors.push(`Line ${input.lineNo}: nothing has been received on this PO line yet. Record the receiving report first.`);
  else if (input.billQty > open) errors.push(`Line ${input.lineNo}: billed quantity ${fromQ4(input.billQty)} is more than received and not yet billed (${fromQ4(open < 0n ? 0n : open)}).`);
  const grni = roundDiv(input.billQty * input.poNetUnit, 1000000n);
  const variance = input.billNet - grni;
  if (variance !== 0n) warnings.push(`Line ${input.lineNo}: price differs from the PO by ${fromCentavos(variance)} (net of VAT); the difference is charged to the line's account.`);
  if (input.billedElsewhere + input.billQty > input.ordered) warnings.push(`Line ${input.lineNo}: total billed is more than the quantity ordered.`);
  return { errors, warnings, grni, variance };
}

export const BUCKETS = ["CURRENT", "D1_30", "D31_60", "D61_90", "D91_120", "OVER_120"] as const;
export type Bucket = (typeof BUCKETS)[number];
export const BUCKET_LABELS: Record<Bucket, string> = { CURRENT: "Current", D1_30: "1-30 days", D31_60: "31-60 days", D61_90: "61-90 days", D91_120: "91-120 days", OVER_120: "Over 120 days" };
export function bucketOf(daysPastDue: number): Bucket {
  if (daysPastDue <= 0) return "CURRENT";
  if (daysPastDue <= 30) return "D1_30";
  if (daysPastDue <= 60) return "D31_60";
  if (daysPastDue <= 90) return "D61_90";
  if (daysPastDue <= 120) return "D91_120";
  return "OVER_120";
}
export const daysBetween = (from: Date, to: Date) => Math.round((Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / 86400000);
export const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));

/** Quarter of a date (1-4) and its month within the quarter (1-3), as used on BIR Form 2307. */
export const quarterOf = (d: Date) => ({ year: d.getUTCFullYear(), quarter: Math.floor(d.getUTCMonth() / 3) + 1, monthInQuarter: (d.getUTCMonth() % 3) + 1 });
