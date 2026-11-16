// All money math is done in whole centavos (BigInt) to avoid floating-point errors.

export function toCentavos(value: string | number | { toString(): string } | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  const s = String(value).replace(/,/g, "").trim();
  if (s === "") return 0n;
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) {
    throw new Error(`Invalid amount "${s}" (use up to 2 decimal places)`);
  }
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const c = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
  return neg ? -c : c;
}

export function fromCentavos(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function formatPeso(c: bigint, opts: { blankZero?: boolean } = {}): string {
  if (opts.blankZero && c === 0n) return "";
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return neg ? `(${whole}.${frac})` : `${whole}.${frac}`;
}
