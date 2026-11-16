// Helpers shared by purchasing and payables.
import { Prisma, type Account } from "@prisma/client";
import { LedgerError } from "../ledger/service";
import { DIM_KEYS, type DimKey } from "../ledger/dimensions";
import { convert, parseRate, type Dims, type LineInput } from "../ledger/validate";
import { fromCentavos, toCentavos } from "../money";
import { CATEGORIES, type Category } from "./compute";

export type Tx = Prisma.TransactionClient;
export const dec = (c: bigint) => new Prisma.Decimal(fromCentavos(c));
export const cents = (d: Prisma.Decimal | string | null | undefined) => toCentavos(d?.toString() ?? "0");
/** A Decimal(18,4) value in ten-thousandths. */
export const q4of = (d: Prisma.Decimal | string | number | null | undefined) => {
  const s = new Prisma.Decimal(d?.toString() ?? "0").toFixed(4);
  const neg = s.startsWith("-");
  const [w, f] = s.replace("-", "").split(".");
  const n = BigInt(w) * 10000n + BigInt(f);
  return neg ? -n : n;
};
export const decQ4 = (n: bigint) => {
  const neg = n < 0n; const a = neg ? -n : n;
  return new Prisma.Decimal(`${neg ? "-" : ""}${a / 10000n}.${String(a % 10000n).padStart(4, "0")}`);
};

const PPE = ["Property, plant and equipment", "Intangible assets", "Right-of-use assets"];

/** The account must fit the line's classification, so assets and prepayments don't end up in expense. */
export function checkCategory(a: Pick<Account, "code" | "name" | "type" | "ifrsGroup" | "isPostable" | "isActive"> | undefined, category: string, label: string): string | null {
  if (!(CATEGORIES as readonly string[]).includes(category)) return `${label}: choose expense, inventory, fixed asset or prepayment`;
  if (!a) return `${label}: choose an account`;
  if (!a.isPostable || !a.isActive) return `${label}: ${a.code} ${a.name} is a header or inactive account`;
  const c = category as Category;
  if (c === "FIXED_ASSET" && !(a.type === "ASSET" && PPE.includes(a.ifrsGroup))) return `${label}: a fixed asset must go to a property and equipment (or intangible) account, not ${a.code} ${a.name}`;
  if (c === "INVENTORY" && !(a.type === "ASSET" && a.ifrsGroup === "Inventories")) return `${label}: inventory must go to an inventory account, not ${a.code} ${a.name}`;
  if (c === "PREPAYMENT" && a.type !== "ASSET") return `${label}: a prepayment must go to an asset account (e.g. Prepaid Expenses), not ${a.code} ${a.name}`;
  if (c === "EXPENSE" && a.type !== "EXPENSE") return `${label}: an expense line must use an expense account, not ${a.code} ${a.name}. Change the classification if this is an asset.`;
  return null;
}

export function cleanDims(d: unknown): Dims {
  const out: Dims = {};
  if (d && typeof d === "object") for (const k of DIM_KEYS) { const v = (d as Record<string, unknown>)[k]; if (typeof v === "string" && v) out[k as DimKey] = v; }
  return out;
}

/** The "Goods Received Not Yet Invoiced" clearing account. Created on first use for companies set up before AP. */
export async function grniAccount(tx: Tx, organizationId: string) {
  const found = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: "GRNI" } } });
  if (found) return found;
  const parent = await tx.account.findUnique({ where: { organizationId_code: { organizationId, code: "2000" } } });
  let code = "2012";
  for (let i = 0; i < 20 && (await tx.account.findUnique({ where: { organizationId_code: { organizationId, code } } })); i++) code = String(2012 + i + 1);
  return tx.account.create({ data: {
    organizationId, code, name: "Goods Received Not Yet Invoiced", type: "LIABILITY", ifrsGroup: "Trade and other payables", isCurrent: true,
    normalBalance: "CREDIT", parentId: parent?.id ?? null, systemRole: "GRNI", allowManualPosting: false,
    description: "Clearing account: receiving reports credit it, supplier bills matched to a PO debit it.",
  } });
}

export async function roleAccount(tx: Tx, organizationId: string, systemRole: string, label: string) {
  const a = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole } } });
  if (!a) throw new LedgerError([`Assign the ${label} account first (Chart of Accounts → system role ${systemRole})`]);
  return a;
}

export const STATUS_LABEL = (s: string) => (s === "PENDING_APPROVAL" ? "FOR APPROVAL" : s.replace(/_/g, " "));

/**
 * When lines carry different exchange rates (a foreign-currency bill clearing GRNI booked at the PO rate,
 * or a payment at today's rate settling bills booked at their own rates), add the realized FX gain/loss
 * line that makes the entry balance in base currency (PAS 21).
 */
export async function withFxDifference(tx: Tx, organizationId: string, lines: LineInput[], description: string): Promise<LineInput[]> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const base = org.baseCurrency;
  const key = (l: LineInput) => `${(l.currencyCode || base).toUpperCase()}@${(l.currencyCode || base).toUpperCase() === base ? "1" : String(l.fxRate)}`;
  if (new Set(lines.map(key)).size <= 1) return lines;
  let diff = 0n;
  for (const l of lines) {
    const foreign = (l.currencyCode || base).toUpperCase() !== base;
    const rate = foreign ? parseRate(l.fxRate) ?? 1000000n : 1000000n;
    diff += convert(toCentavos(l.debit ?? "0"), rate) - convert(toCentavos(l.credit ?? "0"), rate);
  }
  if (diff === 0n) return lines;
  const role = diff < 0n ? "FX_LOSS" : "FX_GAIN"; // credits heavier -> a debit (loss) balances it
  const acct = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: role } } });
  if (!acct) throw new LedgerError([`Assign the ${role === "FX_GAIN" ? "realized FX gain" : "realized FX loss"} account first`]);
  const amt = fromCentavos(diff < 0n ? -diff : diff);
  return [...lines, { accountId: acct.id, [diff < 0n ? "debit" : "credit"]: amt, currencyCode: base, description }];
}
