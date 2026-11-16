// BIR attachments and lists built from the tax ledger:
//   SLSP (RELIEF) sales and purchases · QAP (1601-EQ / 1601-FQ) · SAWT · alphalists (1604-E, 1604-F, 1604-C) · BIR 2307 data.
import "server-only";
import { taxLines } from "./ledger";
import { splitTin } from "./tin";
import { monthInQuarter, quarter, yearPeriod, type Period } from "./periods";
import { getCompensationFeed, type Party, type TaxKind, type TaxLine } from "./types";

export type PartyKey = { key: string; party: Party; tin9: string; branch: string };

function partyKey(p: Party): PartyKey {
  const { tin9, branch } = splitTin(p.tin);
  return { key: tin9 ? `${tin9}-${branch}` : `name:${(p.name ?? "").trim().toUpperCase()}`, party: p, tin9, branch };
}

function groupBy<T>(xs: T[], k: (x: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of xs) { const key = k(x); const a = m.get(key); if (a) a.push(x); else m.set(key, [x]); }
  return m;
}
const sum = (xs: TaxLine[], f: (l: TaxLine) => bigint) => xs.reduce((s, l) => s + f(l), 0n);

// ---------- SLSP (Summary List of Sales and Purchases, RR 1-2017) ----------

export type SlsRow = PartyKey & { exempt: bigint; zeroRated: bigint; taxable: bigint; outputTax: bigint; gross: bigint };
export type SlpRow = PartyKey & { exempt: bigint; zeroRated: bigint; services: bigint; capitalGoods: bigint; goods: bigint; inputTax: bigint; grossTaxable: bigint };

export async function slsp(organizationId: string, p: Period) {
  const lines = await taxLines(organizationId, p.from, p.to, { kinds: ["OUTPUT_VAT", "INPUT_VAT"] });
  const sales: SlsRow[] = [];
  for (const ls of groupBy(lines.filter((l) => l.kind === "OUTPUT_VAT"), (l) => partyKey(l.party).key).values()) {
    const cls = (c: string) => ls.filter((l) => (l.vatClass ?? "VATABLE") === c);
    const taxable = sum([...cls("VATABLE"), ...cls("GOVERNMENT")], (l) => l.base);
    const outputTax = sum(ls, (l) => l.tax);
    const exempt = sum(cls("EXEMPT"), (l) => l.base), zeroRated = sum(cls("ZERO_RATED"), (l) => l.base);
    sales.push({ ...partyKey(ls[0].party), exempt, zeroRated, taxable, outputTax, gross: exempt + zeroRated + taxable + outputTax });
  }
  const purchases: SlpRow[] = [];
  const importations: TaxLine[] = [];
  for (const ls of groupBy(lines.filter((l) => l.kind === "INPUT_VAT"), (l) => partyKey(l.party).key).values()) {
    const cls = (...c: string[]) => ls.filter((l) => c.includes(l.vatClass ?? "GOODS"));
    importations.push(...cls("IMPORT_GOODS"));
    const services = sum(cls("SERVICES", "SERVICES_NONRESIDENT"), (l) => l.base);
    const capitalGoods = sum(cls("CAPITAL_GOODS"), (l) => l.base), goods = sum(cls("GOODS"), (l) => l.base);
    const exempt = sum(cls("EXEMPT", "NOT_QUALIFIED"), (l) => l.base), zeroRated = sum(cls("ZERO_RATED"), (l) => l.base);
    const inputTax = sum(cls("SERVICES", "SERVICES_NONRESIDENT", "CAPITAL_GOODS", "GOODS"), (l) => l.tax);
    if (!services && !capitalGoods && !goods && !exempt && !zeroRated) continue;
    purchases.push({ ...partyKey(ls[0].party), exempt, zeroRated, services, capitalGoods, goods, inputTax, grossTaxable: services + capitalGoods + goods + inputTax });
  }
  const byName = <T extends PartyKey>(a: T, b: T) => (a.party.name ?? "").localeCompare(b.party.name ?? "");
  return { sales: sales.sort(byName), purchases: purchases.sort(byName), importations };
}

// ---------- Withholding lists: QAP, SAWT, alphalists, 2307 ----------

export type PayeeRow = PartyKey & {
  atcCode: string; rate: number; base: bigint; tax: bigint;
  /** For 2307: income payments by month of the quarter. */
  months: [bigint, bigint, bigint];
  lines: TaxLine[];
};

function byPayeeAtc(lines: TaxLine[]): PayeeRow[] {
  const out: PayeeRow[] = [];
  for (const ls of groupBy(lines, (l) => `${partyKey(l.party).key}|${l.atcCode ?? ""}|${l.rate}`).values()) {
    const months: [bigint, bigint, bigint] = [0n, 0n, 0n];
    for (const l of ls) months[monthInQuarter(l.date) - 1] += l.base;
    out.push({ ...partyKey(ls[0].party), atcCode: ls[0].atcCode ?? "", rate: ls[0].rate, base: sum(ls, (l) => l.base), tax: sum(ls, (l) => l.tax), months, lines: ls });
  }
  return out.sort((a, b) => (a.party.name ?? "").localeCompare(b.party.name ?? "") || a.atcCode.localeCompare(b.atcCode));
}

/** Quarterly Alphalist of Payees, attached to 1601-EQ (expanded) or 1601-FQ (final). */
export async function qap(organizationId: string, form: "1601EQ" | "1601FQ", year: number, q: number) {
  const p = quarter(year, q);
  const kind: TaxKind = form === "1601EQ" ? "EWT" : "FWT";
  return { period: p, rows: byPayeeAtc(await taxLines(organizationId, p.from, p.to, { kinds: [kind] })) };
}

/** Summary Alphalist of Withholding Taxes: income tax / VAT / percentage tax withheld from us, per 2307 received. */
export async function sawt(organizationId: string, p: Period, form: "2550Q" | "2551Q" | "1702Q" | "1701Q" | "2550M") {
  const kinds: TaxKind[] = form === "2550Q" || form === "2550M" ? ["VAT_WITHHELD"] : form === "2551Q" ? ["PT_WITHHELD"] : ["CWT"];
  return { period: p, rows: byPayeeAtc(await taxLines(organizationId, p.from, p.to, { kinds })) };
}

/** Annual alphalists: 1604-E (expanded, schedule of payees), 1604-F (final). */
export async function alphalist(organizationId: string, kind: "1604E" | "1604F", year: number) {
  const p = yearPeriod(year);
  return { period: p, rows: byPayeeAtc(await taxLines(organizationId, p.from, p.to, { kinds: [kind === "1604E" ? "EWT" : "FWT"] })) };
}

/** 1604-C needs payroll: until the payroll module registers its feed, this returns null. */
export async function alphalistEmployees(organizationId: string, year: number) {
  const feed = getCompensationFeed();
  return feed ? feed.year2316(organizationId, year) : null;
}

/** BIR 2307 (Certificate of Creditable Tax Withheld at Source) per payee for a quarter. */
export async function certificates2307(organizationId: string, year: number, q: number) {
  const p = quarter(year, q);
  const rows = byPayeeAtc(await taxLines(organizationId, p.from, p.to, { kinds: ["EWT"] }));
  const payees = groupBy(rows, (r) => r.key);
  return { period: p, payees: [...payees.values()].map((rs) => ({ ...rs[0], rows: rs, base: rs.reduce((s, r) => s + r.base, 0n), tax: rs.reduce((s, r) => s + r.tax, 0n) })) };
}
