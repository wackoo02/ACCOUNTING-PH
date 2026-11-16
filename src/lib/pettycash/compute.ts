// Pure petty cash math: VAT split, EWT, tips, fixed asset rules and the replenishment journal.
// No database access, so it is unit-tested directly. All amounts are integer centavos.
import { fromCentavos, toCentavos } from "../money";

export type VoucherLineInput = {
  description: string;
  quantity?: string | number | null;
  unitPrice: string | number;
  amount?: string | number | null; // defaults to quantity x unit price
  accountId: string;
  isFixedAsset?: boolean;
};

export type AccountInfo = { id: string; code: string; name: string; type: string; ifrsGroup: string };

export type VoucherCalcInput = {
  lines: VoucherLineInput[];
  vendorVatRegistered: boolean;
  vatAmount?: string | number | null;       // as printed; if blank and VAT-registered, computed as 12/112
  vatExemptAmount?: string | number | null;
  zeroRatedAmount?: string | number | null;
  tipAmount?: string | number | null;
  ewtRate?: string | number | null;         // percent, e.g. 1 or 2
  fixedAssetThreshold: string | number;     // PHP
  accounts: Map<string, AccountInfo>;
  purchaseOrder?: { status: string; amount: string } | null;
};

export type CalcLine = {
  lineNo: number;
  description: string;
  quantity: string;
  unitPrice: bigint;
  amount: bigint;   // VAT-inclusive
  vat: bigint;      // VAT share of this line
  net: bigint;      // amount - vat, the expense or asset cost
  accountId: string;
  isFixedAsset: boolean;
};

export type VoucherCalc = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  lines: CalcLine[];
  gross: bigint;
  vat: bigint;
  vatExempt: bigint;
  zeroRated: bigint;
  netOfVat: bigint;
  ewt: bigint;
  tip: bigint;
  totalPaid: bigint;
  capitalAmount: bigint; // cost of the lines charged to fixed assets
  needsPurchaseOrder: boolean;
};

const PPE = "Property, plant and equipment";
export const isAssetAccount = (a?: AccountInfo) => !!a && a.type === "ASSET" && a.ifrsGroup === PPE;

/** Parse a quantity with up to 4 decimals into ten-thousandths. */
function qty4(v: string | number | null | undefined): bigint | null {
  const s = String(v ?? "1").replace(/,/g, "").trim() || "1";
  if (!/^\d+(\.\d{0,4})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 10000n + BigInt((f + "0000").slice(0, 4));
}
const roundDiv = (n: bigint, d: bigint) => (n >= 0n ? (n * 2n + d) / (2n * d) : -((-n * 2n + d) / (2n * d)));
const peso = (c: bigint) => `PHP ${fromCentavos(c)}`;

function money(v: string | number | null | undefined, label: string, errors: string[]): bigint {
  try {
    const c = toCentavos(v ?? "0");
    if (c < 0n) errors.push(`${label} cannot be negative`);
    return c;
  } catch {
    errors.push(`${label}: enter an amount with up to 2 decimals`);
    return 0n;
  }
}

export function computeVoucher(input: VoucherCalcInput): VoucherCalc {
  const errors: string[] = [];
  const warnings: string[] = [];
  const threshold = toCentavos(input.fixedAssetThreshold);
  if (!input.lines.length) errors.push("Add at least one item");

  const lines: CalcLine[] = input.lines.map((l, i) => {
    const n = i + 1;
    const q = qty4(l.quantity);
    if (q === null || q === 0n) errors.push(`Item ${n}: quantity must be a positive number`);
    const unit = money(l.unitPrice, `Item ${n} unit price`, errors);
    const computed = q ? roundDiv(unit * q, 10000n) : 0n;
    const amount = l.amount === null || l.amount === undefined || String(l.amount).trim() === "" ? computed : money(l.amount, `Item ${n} amount`, errors);
    if (q && amount !== computed && (amount - computed > 100n || computed - amount > 100n)) {
      warnings.push(`Item ${n}: amount ${peso(amount)} differs from quantity x unit price (${peso(computed)})`);
    }
    if (!l.description?.trim()) errors.push(`Item ${n}: enter a description`);
    const acct = input.accounts.get(l.accountId);
    if (!acct) errors.push(`Item ${n}: choose an account`);
    else if (acct.type !== "EXPENSE" && !isAssetAccount(acct)) errors.push(`Item ${n}: ${acct.code} ${acct.name} is not an expense or property and equipment account`);
    return {
      lineNo: n, description: (l.description ?? "").trim(), quantity: q ? `${q / 10000n}.${(q % 10000n).toString().padStart(4, "0")}` : "0",
      unitPrice: unit, amount, vat: 0n, net: amount, accountId: l.accountId, isFixedAsset: !!l.isFixedAsset || isAssetAccount(acct),
    };
  });

  const gross = lines.reduce((s, l) => s + l.amount, 0n);
  const vatExempt = money(input.vatExemptAmount, "VAT-exempt amount", errors);
  const zeroRated = money(input.zeroRatedAmount, "Zero-rated amount", errors);
  const tip = money(input.tipAmount, "Tip", errors);
  const vatableGross = gross - vatExempt - zeroRated;
  if (vatableGross < 0n) errors.push("VAT-exempt and zero-rated amounts are more than the receipt total");

  let vat = 0n;
  const vatGiven = input.vatAmount !== null && input.vatAmount !== undefined && String(input.vatAmount).trim() !== "";
  if (!input.vendorVatRegistered) {
    if (vatGiven && toCentavosSafe(input.vatAmount) !== 0n) errors.push("A non-VAT supplier cannot charge VAT; claim no input VAT on this receipt");
  } else {
    const expected = vatableGross > 0n ? roundDiv(vatableGross * 12n, 112n) : 0n;
    vat = vatGiven ? money(input.vatAmount, "VAT", errors) : expected;
    if (vatGiven && (vat - expected > 100n || expected - vat > 100n)) {
      warnings.push(`VAT on the receipt (${peso(vat)}) differs from 12/112 of the VATable amount (${peso(expected)})`);
    }
    if (vat > vatableGross) errors.push("VAT is more than the VATable amount");
  }

  // Spread VAT over the lines by amount; the largest line absorbs rounding.
  if (vat > 0n && gross > 0n) {
    let given = 0n;
    for (const l of lines) { l.vat = (vat * l.amount) / gross; given += l.vat; }
    const big = lines.reduce((a, b) => (b.amount > a.amount ? b : a));
    big.vat += vat - given;
    for (const l of lines) l.net = l.amount - l.vat;
  }

  const netOfVat = gross - vat;
  let ewt = 0n;
  if (input.ewtRate !== null && input.ewtRate !== undefined && String(input.ewtRate).trim() !== "") {
    const rate = Number(input.ewtRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.push("EWT rate must be a percentage");
    else ewt = roundDiv(netOfVat * BigInt(Math.round(rate * 10000)), 1_000_000n);
  }

  // Fixed asset rules.
  let capitalAmount = 0n;
  for (const l of lines) {
    const acct = input.accounts.get(l.accountId);
    const atOrAbove = l.unitPrice >= threshold;
    if (l.isFixedAsset && atOrAbove) {
      if (!isAssetAccount(acct)) errors.push(`Item ${l.lineNo}: unit cost ${peso(l.unitPrice)} is at or above the fixed asset threshold (${peso(threshold)}); charge it to a property and equipment account`);
      capitalAmount += l.net;
    } else if (isAssetAccount(acct) && !atOrAbove) {
      errors.push(`Item ${l.lineNo}: unit cost ${peso(l.unitPrice)} is below the fixed asset threshold (${peso(threshold)}); charge it to an expense account`);
    } else if (l.isFixedAsset && !atOrAbove) {
      warnings.push(`Item ${l.lineNo} looks like equipment but is below the fixed asset threshold, so it is expensed`);
    }
  }
  const needsPurchaseOrder = capitalAmount > 0n;
  if (needsPurchaseOrder) {
    const po = input.purchaseOrder;
    if (!po) errors.push("Fixed asset purchase: enter an approved PO number");
    else if (po.status !== "APPROVED") errors.push("Fixed asset purchase: the PO is not approved");
    else if (capitalAmount > toCentavos(po.amount)) errors.push(`Fixed asset cost ${peso(capitalAmount)} is more than the approved PO amount ${peso(toCentavos(po.amount))}`);
  }

  const totalPaid = gross + tip - ewt;
  return { ok: errors.length === 0, errors, warnings, lines, gross, vat, vatExempt, zeroRated, netOfVat, ewt, tip, totalPaid, capitalAmount, needsPurchaseOrder };
}

function toCentavosSafe(v: unknown) {
  try { return toCentavos(String(v)); } catch { return -1n; }
}

// ---------- Replenishment journal ----------

export type BatchVoucher = {
  id: string;
  number: string;
  vendorName: string;
  vendorId: string | null;
  docType: string;
  docNumber: string | null;
  vat: bigint;
  ewt: bigint;
  tip: bigint;
  totalPaid: bigint;
  ewtAccountId: string | null;
  dims: { departmentId?: string | null; costCenterId?: string | null; branchId?: string | null; projectId?: string | null };
  lines: { accountId: string; description: string; net: bigint }[];
};

export type JournalLineOut = {
  accountId: string;
  description: string;
  debit: string;
  credit: string;
  partyType?: string | null;
  partyId?: string | null;
  dims?: Record<string, string | null>;
};

/**
 * Dr expense / asset lines (net of VAT) and tips, Dr Input VAT,
 * Cr EWT payable (per supplier), Cr the fund's replenishment account for the cash paid out.
 */
export function buildReplenishmentLines(vouchers: BatchVoucher[], inputVatAccountId: string, creditAccountId: string): JournalLineOut[] {
  const out: JournalLineOut[] = [];
  let total = 0n;
  const amt = (c: bigint) => fromCentavos(c);
  for (const v of vouchers) {
    const ref = `${v.number} ${v.vendorName}${v.docNumber ? ` ${v.docType} ${v.docNumber}` : ""}`;
    const party = v.vendorId ? { partyType: "VENDOR", partyId: v.vendorId } : {};
    const dims = Object.fromEntries(Object.entries(v.dims).map(([k, x]) => [k, x ?? null]));
    for (const l of v.lines) {
      if (l.net !== 0n) out.push({ accountId: l.accountId, description: `${ref} - ${l.description}`.slice(0, 250), debit: amt(l.net), credit: "0", ...party, dims });
    }
    if (v.tip > 0n) {
      const biggest = v.lines.reduce((a, b) => (b.net > a.net ? b : a), v.lines[0]);
      out.push({ accountId: biggest.accountId, description: `${ref} - tip`, debit: amt(v.tip), credit: "0", ...party, dims });
    }
    if (v.vat > 0n) out.push({ accountId: inputVatAccountId, description: `${ref} - input VAT`, debit: amt(v.vat), credit: "0", ...party });
    if (v.ewt > 0n) {
      if (!v.ewtAccountId) throw new Error(`${v.number}: the EWT tax code has no GL account`);
      out.push({ accountId: v.ewtAccountId, description: `${ref} - EWT withheld`, debit: "0", credit: amt(v.ewt), ...party });
    }
    total += v.totalPaid;
  }
  out.push({ accountId: creditAccountId, description: `Petty cash replenishment (${vouchers.length} vouchers)`, debit: "0", credit: amt(total) });
  return out;
}

// ---------- Expense suggestion without AI ----------

const KEYWORDS: [RegExp, string][] = [
  [/\b(gas(oline)?|diesel|fuel|petron|shell|caltex|seaoil|unioil|phoenix|cleanfuel)\b/i, "6110"],
  [/\b(grab|taxi|jeep|bus|fare|toll|parking|easytrip|autosweep|rfid|angkas|joyride|lrt|mrt|flight|cebu pacific|pal|airasia|hotel|lodging)\b/i, "6050"],
  [/\b(lbc|jrs|2go|j&t|ninja ?van|lalamove|courier|delivery|postage|shipping|xde|gogo ?xpress)\b/i, "6052"],
  [/\b(meralco|electric|water bill|maynilad|manila water)\b/i, "6040"],
  [/\b(meal|food|lunch|dinner|breakfast|snack|coffee|jollibee|mcdo|mcdonald|chowking|starbucks|restaurant|kfc|greenwich|mang inasal|water|catering)\b/i, "6120"],
  [/\b(client|representation|entertainment|gift|token)\b/i, "6055"],
  [/\b(bond paper|paper|ink|toner|pen|folder|staple|envelope|notebook|office supplies|national bookstore|ballpen|tape|printing|photocopy|xerox)\b/i, "6060"],
  [/\b(repair|maintenance|plumbing|electrical|aircon cleaning|service fee|parts|tire|battery|vulcaniz)\b/i, "6065"],
  [/\b(load|prepaid|globe|smart|pldt|converge|internet|wifi|telephone|sim)\b/i, "6045"],
  [/\b(notar|permit|license|registration|cedula|barangay clearance|bir|dti|sec fee|lto)\b/i, "6075"],
  [/\b(laptop|computer|printer|monitor|aircon|air ?conditioner|refrigerator|furniture|chair|table|cabinet|projector|cctv|generator)\b/i, "1530"],
];

/** Best-guess account code from an item description, or null. */
export function suggestAccountCode(description: string): string | null {
  for (const [re, code] of KEYWORDS) if (re.test(description)) return code;
  return null;
}
