// Exact arithmetic for stock quantities and unit costs. No floating point.
//   quantity  -> bigint in ten-thousandths (4 decimals), e.g. 1.5 pcs = 15000n
//   unit cost -> bigint in millionths of a peso (6 decimals)
//   value     -> bigint centavos (same as src/lib/money.ts)
import { toCentavos } from "../money";

const Q = 10_000n;
const U = 1_000_000n;

function parseScaled(value: string | number | { toString(): string } | null | undefined, dp: number, what: string): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  const s = String(value).trim().replace(/,/g, "");
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`Invalid ${what}: ${value}`);
  const frac = (m[3] ?? "").padEnd(dp + 1, "0");
  let n = BigInt(m[2] || "0") * 10n ** BigInt(dp) + BigInt(frac.slice(0, dp) || "0");
  if (Number(frac[dp]) >= 5) n += 1n; // round half up on the next digit
  return m[1] ? -n : n;
}

export const toQty = (v: string | number | { toString(): string } | null | undefined) => parseScaled(v, 4, "quantity");
export const toUnitCost = (v: string | number | { toString(): string } | null | undefined) => parseScaled(v, 6, "unit cost");

function fmtScaled(n: bigint, dp: number, minDp: number) {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const scale = 10n ** BigInt(dp);
  let frac = (a % scale).toString().padStart(dp, "0").replace(/0+$/, "");
  if (frac.length < minDp) frac = frac.padEnd(minDp, "0");
  return `${neg ? "-" : ""}${a / scale}${frac ? "." + frac : ""}`;
}
/** "12.5" (trailing zeros dropped) - for the database and inputs. */
export const fromQty = (q: bigint) => fmtScaled(q, 4, 0);
export const fromUnitCost = (u: bigint) => fmtScaled(u, 6, 2);
/** "1,234.5" for display. */
export function formatQty(q: bigint) {
  const [i, f] = fromQty(q).split(".");
  const neg = i.startsWith("-");
  const int = BigInt(neg ? i.slice(1) : i).toLocaleString("en-PH");
  return `${neg ? "-" : ""}${int}${f ? "." + f : ""}`;
}
export function formatUnitCost(u: bigint) {
  const [i, f] = fromUnitCost(u).split(".");
  const neg = i.startsWith("-");
  return `${neg ? "-" : ""}${BigInt(neg ? i.slice(1) : i).toLocaleString("en-PH")}.${f}`;
}

/** a * b / d, rounded half away from zero. */
export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error("division by zero");
  const n = a * b;
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n, ad = d < 0n ? -d : d;
  const q = (an + ad / 2n) / ad;
  return neg ? -q : q;
}

/** Value in centavos of `qty` at `unitCost`. */
export const valueOf = (qty: bigint, unitCost: bigint) => mulDiv(qty, unitCost, (Q * U) / 100n);
/** Unit cost (6 dp) of `value` centavos over `qty`. */
export const unitCostOf = (value: bigint, qty: bigint) => (qty === 0n ? 0n : mulDiv(value, (Q * U) / 100n, qty));
/** Share of `value` for taking `part` out of `whole`; taking everything returns the exact remainder. */
export const share = (value: bigint, part: bigint, whole: bigint) => (part === whole ? value : mulDiv(value, part, whole));

export const cents = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");
