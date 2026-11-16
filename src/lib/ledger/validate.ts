// Pure double-entry validation with multi-currency support. No database access.
//
// Amounts on each line are entered in the line's transaction currency (forex).
// The base (local reporting) amount = forex amount x rate, rounded to the centavo.
// Rules:
//  * Base debits must equal base credits (that's what the GL and BIR books use).
//  * If every line uses the same currency, forex debits must also equal forex credits,
//    and any 1-2 centavo rounding difference in base is absorbed by the largest line.
//  * Mixed-currency entries (e.g. USD bank receipt against a PHP receivable) must balance
//    in base; the user adds a Foreign Exchange Gain/Loss line for any difference (IAS 21).
import { toCentavos } from "../money";
import { DIM_KEYS, type DimKey } from "./dimensions";

export type Dims = Partial<Record<DimKey, string | null>>;

export type LineInput = {
  accountId: string;
  description?: string | null;
  debit?: string | number | null;
  credit?: string | number | null;
  currencyCode?: string | null;
  fxRate?: string | number | null;
  partyType?: string | null;
  partyId?: string | null;
  dims?: Dims;
  intercompanyOrgId?: string | null;
};

export type NormalizedLine = {
  lineNo: number;
  accountId: string;
  description: string | null;
  currencyCode: string;
  fxRate: string;     // decimal string, 6 dp
  fxDebit: bigint;    // centavos in transaction currency
  fxCredit: bigint;
  debit: bigint;      // centavos in base currency
  credit: bigint;
  partyType: string | null;
  partyId: string | null;
  dims: Record<DimKey, string | null>;
  intercompanyOrgId: string | null;
};

export type ValidationResult =
  | { ok: true; lines: NormalizedLine[]; totalDebit: bigint; totalCredit: bigint }
  | { ok: false; errors: string[] };

const RATE_SCALE = 1_000_000n;

/** Parse an exchange rate to micro-units (6 decimal places). */
export function parseRate(v: string | number | null | undefined): bigint | null {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (s === "") return null;
  if (!/^\d+(\.\d{0,6})?$/.test(s)) return -1n;
  const [w, f = ""] = s.split(".");
  return BigInt(w) * RATE_SCALE + BigInt((f + "000000").slice(0, 6));
}

const rateStr = (r: bigint) => `${r / RATE_SCALE}.${(r % RATE_SCALE).toString().padStart(6, "0")}`;

/** fx centavos x rate, rounded half-up to base centavos. */
export function convert(fxCents: bigint, rateMicro: bigint): bigint {
  return (fxCents * rateMicro + RATE_SCALE / 2n) / RATE_SCALE;
}

export function validateLines(input: LineInput[], baseCurrency = "PHP"): ValidationResult {
  const errors: string[] = [];
  const lines: NormalizedLine[] = [];

  const rows = input.filter((l) => l.accountId || nonBlank(l.debit) || nonBlank(l.credit));

  rows.forEach((l, i) => {
    const n = i + 1;
    let fxDebit = 0n, fxCredit = 0n;
    try {
      fxDebit = toCentavos(l.debit);
      fxCredit = toCentavos(l.credit);
    } catch (e) {
      errors.push(`Line ${n}: ${(e as Error).message}`);
      return;
    }
    const currencyCode = (l.currencyCode || baseCurrency).toUpperCase();
    let rate = currencyCode === baseCurrency ? RATE_SCALE : parseRate(l.fxRate);
    if (rate === null) { errors.push(`Line ${n}: enter the exchange rate for ${currencyCode}`); rate = RATE_SCALE; }
    else if (rate <= 0n) { errors.push(`Line ${n}: exchange rate must be a positive number (up to 6 decimals)`); rate = RATE_SCALE; }

    if (!l.accountId) errors.push(`Line ${n}: choose an account`);
    if (fxDebit < 0n || fxCredit < 0n) errors.push(`Line ${n}: amounts cannot be negative`);
    if (fxDebit > 0n && fxCredit > 0n) errors.push(`Line ${n}: enter either a debit or a credit, not both`);
    if (fxDebit === 0n && fxCredit === 0n) errors.push(`Line ${n}: enter an amount`);
    lines.push({
      lineNo: n,
      accountId: l.accountId,
      description: l.description?.trim() || null,
      currencyCode,
      fxRate: rateStr(rate),
      fxDebit,
      fxCredit,
      debit: convert(fxDebit, rate),
      credit: convert(fxCredit, rate),
      partyType: l.partyType || null,
      partyId: l.partyId || null,
      dims: Object.fromEntries(DIM_KEYS.map((k) => [k, l.dims?.[k] || null])) as Record<DimKey, string | null>,
      intercompanyOrgId: l.intercompanyOrgId || null,
    });
  });

  if (rows.length < 2) errors.push("An entry needs at least two lines");
  if (errors.length) return { ok: false, errors };

  const currencies = new Set(lines.map((l) => l.currencyCode));
  if (currencies.size === 1) {
    const [cur] = currencies;
    const fd = sum(lines, "fxDebit"), fc = sum(lines, "fxCredit");
    if (fd !== fc) return { ok: false, errors: [`Debits (${cur} ${fmt(fd)}) and credits (${cur} ${fmt(fc)}) must be equal`] };
    // Absorb conversion rounding in base currency on the largest line of the heavier side.
    const diff = sum(lines, "debit") - sum(lines, "credit");
    const abs = diff < 0n ? -diff : diff;
    if (abs > BigInt(lines.length)) {
      return { ok: false, errors: [`Use one exchange rate for all ${cur} lines in this entry`] };
    }
    if (diff !== 0n) {
      const side = diff > 0n ? "debit" : "credit";
      const target = lines.filter((l) => l[side] > 0n).sort((a, b) => (b[side] > a[side] ? 1 : -1))[0];
      target[side] -= diff > 0n ? diff : -diff;
    }
  }

  const totalDebit = sum(lines, "debit");
  const totalCredit = sum(lines, "credit");
  if (totalDebit !== totalCredit) {
    return { ok: false, errors: [`In ${baseCurrency}, debits (${fmt(totalDebit)}) and credits (${fmt(totalCredit)}) must be equal. Add a foreign exchange gain or loss line for the difference of ${fmt(totalDebit > totalCredit ? totalDebit - totalCredit : totalCredit - totalDebit)}.`] };
  }
  if (totalDebit === 0n) return { ok: false, errors: ["Entry total cannot be zero"] };
  return { ok: true, lines, totalDebit, totalCredit };
}

function sum(ls: NormalizedLine[], k: "debit" | "credit" | "fxDebit" | "fxCredit") {
  return ls.reduce((s, l) => s + l[k], 0n);
}
function nonBlank(v: unknown) {
  return String(v ?? "").trim() !== "";
}
function fmt(c: bigint) {
  return (Number(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 });
}
