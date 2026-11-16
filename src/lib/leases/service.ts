// Lease accounting (PFRS 16, lessee): lease register, commencement, monthly interest / depreciation /
// payments, modifications, terminations. Every GL entry goes through recordJournalTx with source LEASE
// and sourceId = the lease id, so the journal screen cannot reverse them on its own (undo is here).
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { convert, parseRate, type Dims, type LineInput } from "../ledger/validate";
import { DIM_KEYS } from "../ledger/dimensions";
import { LedgerError, asDay, audit, nextNumber, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import {
  accrue, addDays, buildSchedule, daysBetween, depreciationEnd, generatePayments, measureLease, termMonths,
  type Frequency, type Payment, type ScheduleRow, type Timing,
} from "./engine";

type Tx = Prisma.TransactionClient;
type LeaseRow = Prisma.LeaseGetPayload<object>;

export const LEASE_TYPES: Record<string, string> = {
  PROPERTY: "Office / store / warehouse space", LAND: "Land", VEHICLE: "Vehicle", EQUIPMENT: "Machinery and equipment", IT_EQUIPMENT: "IT and office equipment", OTHER: "Other",
};
export const FREQUENCIES: Record<Frequency, string> = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", SEMI_ANNUAL: "Semi-annual", ANNUAL: "Annual" };
export const EXEMPTIONS: Record<string, string> = { NONE: "None: recognise ROU asset and lease liability", SHORT_TERM: "Short-term lease (12 months or less)", LOW_VALUE: "Low-value asset" };
export const STATUS_LABELS: Record<string, string> = { DRAFT: "Draft", ACTIVE: "Active", ENDED: "Ended", TERMINATED: "Terminated" };
const VAT_RATE = 12n; // PH VAT %

const cents = (d: Prisma.Decimal | string | number | null | undefined) => toCentavos(d?.toString() ?? "0");
const dec = (c: bigint) => new Prisma.Decimal(fromCentavos(c));
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (c: bigint) => (Number(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 });
const pct = (c: bigint, rateTimes100: bigint) => (c * rateTimes100 + 5000n) / 10000n; // c x (rate% with 2 dp)

export function paymentsOf(l: { payments: Prisma.JsonValue }): Payment[] {
  return ((l.payments ?? []) as { date: string; amount: string; eod?: boolean }[]).map((p) => ({ date: p.date, amount: BigInt(p.amount), ...(p.eod ? { eod: true } : {}) }));
}
const paymentsJson = (ps: Payment[]) => ps.map((p) => ({ date: p.date, amount: p.amount.toString(), ...(p.eod ? { eod: true } : {}) }));

export function rowOf(r: Prisma.LeaseScheduleLineGetPayload<object>): ScheduleRow & { id: string; journalEntryId: string | null; postedAt: Date | null } {
  return {
    id: r.id, journalEntryId: r.journalEntryId, postedAt: r.postedAt, periodStart: ymd(r.periodStart), periodEnd: ymd(r.periodEnd),
    opening: cents(r.opening), interest: cents(r.interest), payment: cents(r.payment), closing: cents(r.closing), currentPortion: cents(r.currentPortion),
    depreciation: cents(r.depreciation), rouOpening: cents(r.rouOpening), rouClosing: cents(r.rouClosing),
  };
}
const rowData = (leaseId: string, organizationId: string, r: ScheduleRow) => ({
  leaseId, organizationId, periodStart: new Date(r.periodStart), periodEnd: new Date(r.periodEnd),
  opening: dec(r.opening), interest: dec(r.interest), payment: dec(r.payment), closing: dec(r.closing), currentPortion: dec(r.currentPortion),
  depreciation: dec(r.depreciation), rouOpening: dec(r.rouOpening), rouClosing: dec(r.rouClosing),
});

const isExempt = (l: { exemption: string }) => l.exemption !== "NONE";
const rateOf = (l: { discountRate: Prisma.Decimal }) => Number(l.discountRate.toString()) / 100;

// ---------- Lease master ----------

export type LeaseInput = {
  organizationId: string;
  userId: string;
  number?: string | null;
  lessorName?: string | null;
  lessorVendorCode?: string | null;
  leaseType: string;
  assetDescription: string;
  location?: string | null;
  commencementDate: string;
  endDate: string;
  paymentAmount: string;
  paymentFrequency: string;
  paymentTiming: string;
  escalationPct?: string | null;
  escalationEveryMonths?: string | number | null;
  incrementalBorrowingRate?: string | null;
  discountRate?: string | null;
  currencyCode?: string | null;
  fxRate?: string | null;
  exemption?: string | null;
  transfersOwnership?: boolean;
  usefulLifeMonths?: string | number | null;
  initialDirectCosts?: string | null;
  prepaidLeasePayments?: string | null;
  leaseIncentives?: string | null;
  restorationCost?: string | null;
  vatable?: boolean;
  ewtTaxCodeId?: string | null;
  rouAccountId?: string | null;
  accumDepAccountId?: string | null;
  liabilityAccountId?: string | null;
  currentLiabilityAccountId?: string | null;
  interestAccountId?: string | null;
  depreciationAccountId?: string | null;
  rentExpenseAccountId?: string | null;
  paymentAccountId?: string | null;
  gainLossAccountId?: string | null;
  initialCostsAccountId?: string | null;
  restorationAccountId?: string | null;
  takeUpDate?: string | null;
  takeUpOffsetAccountId?: string | null;
  dims?: Dims;
  notes?: string | null;
};

const ACCOUNT_DEFAULTS: { field: keyof LeaseInput; role?: string; code: string }[] = [
  { field: "rouAccountId", code: "1600" },
  { field: "accumDepAccountId", code: "1605" },
  { field: "liabilityAccountId", code: "2520" },
  { field: "currentLiabilityAccountId", code: "2098" },
  { field: "interestAccountId", code: "7510" },
  { field: "depreciationAccountId", code: "6090" },
  { field: "rentExpenseAccountId", code: "6030" },
  { field: "paymentAccountId", role: "AP_CONTROL", code: "2010" },
  { field: "gainLossAccountId", code: "7040" },
  { field: "initialCostsAccountId", code: "1300" },
  { field: "takeUpOffsetAccountId", role: "RETAINED_EARNINGS", code: "3100" },
];

/** Suggested GL accounts from the PH chart of accounts (by role, else by code). */
export async function defaultLeaseAccounts(organizationId: string) {
  const accts = await prisma.account.findMany({ where: { organizationId, isPostable: true, isActive: true }, select: { id: true, code: true, systemRole: true } });
  const out: Record<string, string> = {};
  for (const d of ACCOUNT_DEFAULTS) {
    const a = (d.role && accts.find((x) => x.systemRole === d.role)) || accts.find((x) => x.code === d.code);
    if (a) out[d.field] = a.id;
  }
  return out;
}

const num = (v: string | number | null | undefined) => (v === null || v === undefined || String(v).trim() === "" ? null : Number(String(v).replace(/,/g, "")));
const money = (v: string | null | undefined, label: string, errors: string[]) => {
  try { const c = toCentavos(v ?? ""); if (c < 0n) errors.push(`${label} cannot be negative`); return c; } catch { errors.push(`${label}: enter an amount with up to 2 decimals`); return 0n; }
};

async function validateInput(tx: Tx, i: LeaseInput) {
  const errors: string[] = [];
  const org = await tx.organization.findUniqueOrThrow({ where: { id: i.organizationId } });
  const d = /^\d{4}-\d{2}-\d{2}$/;
  if (!d.test(i.commencementDate)) errors.push("Enter the lease start (commencement) date");
  if (!d.test(i.endDate)) errors.push("Enter the lease end date");
  if (!i.assetDescription?.trim()) errors.push("Describe the leased asset");
  if (!LEASE_TYPES[i.leaseType]) errors.push("Choose the lease type");
  if (!FREQUENCIES[i.paymentFrequency as Frequency]) errors.push("Choose how often payments are made");
  if (i.paymentTiming !== "ADVANCE" && i.paymentTiming !== "ARREARS") errors.push("Choose whether payments are in advance or in arrears");
  const exemption = i.exemption && EXEMPTIONS[i.exemption] ? i.exemption : "NONE";
  const amount = money(i.paymentAmount, "Payment amount", errors);
  if (amount === 0n) errors.push("Enter the payment amount per period");

  let lessorName = i.lessorName?.trim() || "";
  const vendorCode = i.lessorVendorCode?.trim() || null;
  if (vendorCode) {
    const v = await tx.vendor.findUnique({ where: { organizationId_code: { organizationId: i.organizationId, code: vendorCode } } });
    if (!v) errors.push(`Vendor ${vendorCode} is not in the vendor list`);
    else if (!lessorName) lessorName = v.name;
  }
  if (!lessorName) errors.push("Enter the lessor (or pick the lessor from the vendor list)");

  const ibr = num(i.incrementalBorrowingRate);
  const disc = num(i.discountRate) ?? ibr;
  if (exemption === "NONE") {
    if (ibr === null || Number.isNaN(ibr) || ibr < 0 || ibr > 100) errors.push("Enter the incremental borrowing rate (annual %), e.g. 7.5");
    if (disc === null || Number.isNaN(disc) || disc < 0 || disc > 100) errors.push("Discount rate must be an annual % between 0 and 100");
  }
  const esc = num(i.escalationPct) ?? 0;
  if (Number.isNaN(esc) || esc < 0 || esc > 100) errors.push("Escalation must be a % between 0 and 100");
  const escEvery = Math.trunc(num(i.escalationEveryMonths) ?? 12);
  if (escEvery < 1) errors.push("Escalation interval must be at least 1 month");

  const currencyCode = (i.currencyCode || org.baseCurrency).toUpperCase();
  let fxRate = "1";
  if (currencyCode !== org.baseCurrency) {
    const c = await tx.currency.findFirst({ where: { organizationId: i.organizationId, code: currencyCode, isActive: true } });
    if (!c) errors.push(`Add ${currencyCode} to the Currencies list first`);
    const r = parseRate(i.fxRate || c?.rateToBase.toString());
    if (r === null || r <= 0n) errors.push(`Enter the ${currencyCode} exchange rate at the start date`);
    else fxRate = (Number(r) / 1e6).toFixed(6);
  }

  const transfersOwnership = !!i.transfersOwnership;
  const usefulLife = num(i.usefulLifeMonths);
  if (!errors.length) {
    if (i.endDate <= i.commencementDate) errors.push("The lease end date must be after the start date");
    const months = termMonths(i.commencementDate, i.endDate);
    if (exemption === "SHORT_TERM" && (months > 12 || transfersOwnership)) errors.push("A short-term lease runs 12 months or less and has no purchase option; this one is longer, so it goes on the balance sheet");
    if (transfersOwnership && exemption === "NONE" && (!usefulLife || usefulLife < months)) errors.push("Enter the asset's useful life in months (at least the lease term) when ownership transfers or a purchase option is reasonably certain");
  }

  const idc = money(i.initialDirectCosts, "Initial direct costs", errors);
  const prepaid = money(i.prepaidLeasePayments, "Payments made before the start date", errors);
  const incentives = money(i.leaseIncentives, "Lease incentives", errors);
  const restoration = money(i.restorationCost, "Restoration cost", errors);

  const defaults = await defaultLeaseAccounts(i.organizationId);
  const pick = (k: keyof LeaseInput) => (i[k] as string | null | undefined) || defaults[k as string] || null;
  const acct = {
    rouAccountId: pick("rouAccountId"), accumDepAccountId: pick("accumDepAccountId"), liabilityAccountId: pick("liabilityAccountId"),
    currentLiabilityAccountId: i.currentLiabilityAccountId === "" ? null : pick("currentLiabilityAccountId"),
    interestAccountId: pick("interestAccountId"), depreciationAccountId: pick("depreciationAccountId"), rentExpenseAccountId: pick("rentExpenseAccountId"),
    paymentAccountId: pick("paymentAccountId"), gainLossAccountId: pick("gainLossAccountId"),
    initialCostsAccountId: prepaid + idc + incentives !== 0n ? pick("initialCostsAccountId") : i.initialCostsAccountId || null,
    restorationAccountId: i.restorationAccountId || null,
    takeUpOffsetAccountId: i.takeUpDate ? pick("takeUpOffsetAccountId") : null,
  };
  const need: [keyof typeof acct, string][] = exemption === "NONE"
    ? [["rouAccountId", "right-of-use asset"], ["accumDepAccountId", "accumulated depreciation"], ["liabilityAccountId", "lease liability"], ["interestAccountId", "interest expense"], ["depreciationAccountId", "depreciation expense"], ["paymentAccountId", "payments due (Accounts Payable)"], ["gainLossAccountId", "gain or loss"]]
    : [["rentExpenseAccountId", "rent expense"], ["liabilityAccountId", "accrued / prepaid rent"], ["paymentAccountId", "payments due (Accounts Payable)"], ["gainLossAccountId", "gain or loss"]];
  for (const [k, label] of need) if (!acct[k]) errors.push(`Choose the ${label} account`);
  if (exemption === "NONE" && prepaid + idc + incentives !== 0n && !acct.initialCostsAccountId) errors.push("Choose the account where the advance rent, initial direct costs or incentives are now recorded");
  if (exemption === "NONE" && restoration > 0n && !acct.restorationAccountId) errors.push("Choose the provision account for the restoration cost");
  const ids = [...new Set(Object.values(acct).filter(Boolean) as string[])];
  const found = await tx.account.findMany({ where: { id: { in: ids }, organizationId: i.organizationId } });
  for (const a of found) {
    if (!a.isPostable) errors.push(`${a.code} ${a.name} is a header account`);
    if (!a.isActive) errors.push(`${a.code} ${a.name} is inactive`);
  }
  if (found.length !== ids.length) errors.push("One or more accounts do not belong to this company");

  let takeUpDate: string | null = i.takeUpDate?.trim() || null;
  if (takeUpDate) {
    if (!d.test(takeUpDate) || !takeUpDate.endsWith("-01")) errors.push("The go-live (take-up) date must be the first day of a month");
    else if (takeUpDate <= i.commencementDate) takeUpDate = null; // started after go-live: a normal commencement
    else if (takeUpDate > i.endDate) errors.push("The lease ended before the go-live date; there is nothing to take up");
  }
  if (i.ewtTaxCodeId) {
    const t = await tx.taxCode.findFirst({ where: { id: i.ewtTaxCodeId, organizationId: i.organizationId, taxType: "EWT" } });
    if (!t) errors.push("Choose an expanded withholding tax code from the tax code list");
  }
  const dims = Object.fromEntries(DIM_KEYS.map((k) => [k, i.dims?.[k] || null]).filter(([, v]) => v));
  if (errors.length) throw new LedgerError(errors);

  return {
    org,
    data: {
      lessorName, lessorVendorCode: vendorCode, leaseType: i.leaseType, assetDescription: i.assetDescription.trim(), location: i.location?.trim() || null,
      commencementDate: new Date(i.commencementDate), endDate: new Date(i.endDate),
      paymentAmount: dec(amount), paymentFrequency: i.paymentFrequency, paymentTiming: i.paymentTiming,
      escalationPct: new Prisma.Decimal(esc), escalationEveryMonths: escEvery,
      incrementalBorrowingRate: new Prisma.Decimal(ibr ?? 0), discountRate: new Prisma.Decimal(disc ?? 0),
      currencyCode, fxRate: new Prisma.Decimal(fxRate), exemption, transfersOwnership, usefulLifeMonths: usefulLife ? Math.trunc(usefulLife) : null,
      initialDirectCosts: dec(idc), prepaidLeasePayments: dec(prepaid), leaseIncentives: dec(incentives), restorationCost: dec(restoration),
      vatable: !!i.vatable, ewtTaxCodeId: i.ewtTaxCodeId || null,
      rouAccountId: acct.rouAccountId ?? acct.liabilityAccountId!, accumDepAccountId: acct.accumDepAccountId ?? acct.liabilityAccountId!,
      liabilityAccountId: acct.liabilityAccountId!, currentLiabilityAccountId: acct.currentLiabilityAccountId === acct.liabilityAccountId ? null : acct.currentLiabilityAccountId,
      interestAccountId: acct.interestAccountId ?? acct.rentExpenseAccountId!, depreciationAccountId: acct.depreciationAccountId ?? acct.rentExpenseAccountId!,
      rentExpenseAccountId: acct.rentExpenseAccountId, paymentAccountId: acct.paymentAccountId!, gainLossAccountId: acct.gainLossAccountId!,
      initialCostsAccountId: acct.initialCostsAccountId, restorationAccountId: acct.restorationAccountId,
      takeUpDate: takeUpDate ? new Date(takeUpDate) : null, takeUpOffsetAccountId: takeUpDate ? acct.takeUpOffsetAccountId : null,
      dims: Object.keys(dims).length ? (dims as Prisma.InputJsonValue) : Prisma.JsonNull,
      notes: i.notes?.trim() || null,
    },
  };
}

function measure(data: { commencementDate: Date; endDate: Date; paymentAmount: Prisma.Decimal; paymentFrequency: string; paymentTiming: string; escalationPct: Prisma.Decimal; escalationEveryMonths: number;
  discountRate: Prisma.Decimal; exemption: string; transfersOwnership: boolean; usefulLifeMonths: number | null; initialDirectCosts: Prisma.Decimal; prepaidLeasePayments: Prisma.Decimal;
  leaseIncentives: Prisma.Decimal; restorationCost: Prisma.Decimal; fxRate: Prisma.Decimal }) {
  return measureLease({
    commencementDate: ymd(data.commencementDate), endDate: ymd(data.endDate), paymentAmount: cents(data.paymentAmount),
    frequency: data.paymentFrequency as Frequency, timing: data.paymentTiming as Timing,
    escalationPct: Number(data.escalationPct.toString()), escalationEveryMonths: data.escalationEveryMonths,
    discountRatePct: Number(data.discountRate.toString()), exempt: data.exemption !== "NONE",
    transfersOwnership: data.transfersOwnership, usefulLifeMonths: data.usefulLifeMonths,
    initialDirectCosts: cents(data.initialDirectCosts), prepaidPayments: cents(data.prepaidLeasePayments), incentives: cents(data.leaseIncentives),
    restorationCost: cents(data.restorationCost), fxRate: Number(data.fxRate.toString()),
  });
}

/** Create or update a draft lease; the schedule is recalculated every time. */
export async function saveLease(input: LeaseInput, id?: string) {
  return prisma.$transaction(async (tx) => {
    const { data } = await validateInput(tx, input);
    const m = measure(data);
    let before: LeaseRow | null = null;
    if (id) {
      before = await tx.lease.findFirst({ where: { id, organizationId: input.organizationId } });
      if (!before) throw new LedgerError(["Lease not found"]);
      if (before.status !== "DRAFT") throw new LedgerError(["Only a draft lease can be edited. Use Modify or Terminate for an active lease."]);
    }
    let number = input.number?.trim() || before?.number || "";
    if (!number) number = await nextNumber(tx, input.organizationId, "LSE", data.commencementDate.getUTCFullYear());
    const dup = await tx.lease.findUnique({ where: { organizationId_number: { organizationId: input.organizationId, number } } });
    if (dup && dup.id !== id) throw new LedgerError([`Lease number ${number} is already used`]);
    const full = { ...data, number, payments: paymentsJson(m.payments), initialLiability: dec(m.liability), initialRou: dec(m.rou) };
    const lease = id
      ? await tx.lease.update({ where: { id }, data: { ...full, updatedById: input.userId } })
      : await tx.lease.create({ data: { ...full, organizationId: input.organizationId, createdById: input.userId } });
    await tx.leaseScheduleLine.deleteMany({ where: { leaseId: lease.id } });
    await tx.leaseScheduleLine.createMany({ data: m.rows.map((r) => rowData(lease.id, input.organizationId, r)) });
    await audit(tx, input.organizationId, input.userId, id ? "lease.update" : "lease.create", lease.id, { number }, before ? JSON.parse(JSON.stringify(before)) : null, JSON.parse(JSON.stringify(lease)), "lease");
    return lease;
  });
}

export async function deleteLease(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const l = await tx.lease.findFirst({ where: { id, organizationId } });
    if (!l) throw new LedgerError(["Lease not found"]);
    if (l.status !== "DRAFT") throw new LedgerError(["Only a draft lease can be deleted"]);
    await tx.lease.delete({ where: { id } });
    await audit(tx, organizationId, userId, "lease.delete", id, { number: l.number }, JSON.parse(JSON.stringify(l)), null, "lease");
  });
}

// ---------- Journal building ----------

/** Collects lines in the lease currency (fx) or base currency and keeps the entry balanced in base. */
class Entry {
  lines: LineInput[] = [];
  private baseNet = 0n;
  private plug = -1;
  constructor(private base: string, private cur: string, private rate: string) {}
  private add(accountId: string, amt: bigint, description: string, currency: string, extra: Partial<LineInput>) {
    if (amt === 0n) return;
    const abs = amt < 0n ? -amt : amt;
    const isFx = currency !== this.base;
    const b = isFx ? convert(abs, parseRate(this.rate)!) : abs;
    this.baseNet += amt < 0n ? -b : b;
    this.lines.push({ accountId, description, ...(amt > 0n ? { debit: fromCentavos(abs) } : { credit: fromCentavos(abs) }), currencyCode: currency, fxRate: isFx ? this.rate : "1", ...extra });
  }
  /** + debit, - credit, in the lease currency at the posting rate. */
  fx(accountId: string, amt: bigint, description: string, extra: Partial<LineInput> = {}) { this.add(accountId, amt, description, this.cur, extra); }
  /** + debit, - credit, in base currency. `plug` marks the line that absorbs FX rounding. */
  baseLine(accountId: string, amt: bigint, description: string, extra: Partial<LineInput> = {}, plug = false) {
    this.add(accountId, amt, description, this.base, extra);
    if (plug && amt !== 0n) this.plug = this.lines.length - 1;
  }
  net() { return this.baseNet; }
  toBase(fx: bigint) { if (this.cur === this.base) return fx; const neg = fx < 0n; const b = convert(neg ? -fx : fx, parseRate(this.rate)!); return neg ? -b : b; }
  /** Settle any centavo difference from converting the foreign-currency lines. */
  finish(fallbackAccountId: string) {
    if (this.baseNet === 0n) return this.lines;
    const diff = -this.baseNet;
    const i = this.plug >= 0 ? this.plug : this.lines.findIndex((l) => l.currencyCode === this.base);
    if (i >= 0) {
      const l = this.lines[i];
      const signed = (l.debit ? toCentavos(l.debit) : -toCentavos(l.credit)) + diff;
      delete l.debit; delete l.credit;
      if (signed >= 0n) l.debit = fromCentavos(signed); else l.credit = fromCentavos(-signed);
    } else this.lines.push({ accountId: fallbackAccountId, description: "Foreign exchange rounding", ...(diff > 0n ? { debit: fromCentavos(diff) } : { credit: fromCentavos(-diff) }) });
    this.baseNet = 0n;
    return this.lines;
  }
}

async function postingRate(tx: Tx, l: LeaseRow, base: string) {
  if (l.currencyCode === base) return "1";
  const c = await tx.currency.findFirst({ where: { organizationId: l.organizationId, code: l.currencyCode } });
  return c?.rateToBase.toString() ?? l.fxRate.toString();
}

const dimsOf = (l: LeaseRow) => ({ dims: (l.dims ?? {}) as Dims });
const vendorParty = (l: LeaseRow) => (l.lessorVendorCode ? { partyType: "VENDOR", partyId: l.lessorVendorCode } : {});

/** Payment due lines: Dr liability (or accrued rent), Dr input VAT, Cr EWT payable, Cr Accounts Payable. */
async function paymentLines(tx: Tx, e: Entry, l: LeaseRow, debitAccountId: string, payment: bigint, label: string) {
  if (payment === 0n) return;
  let vat = 0n, ewt = 0n;
  e.fx(debitAccountId, payment, `${label} due`);
  if (l.vatable) {
    const a = await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId: l.organizationId, systemRole: "INPUT_VAT" } } });
    if (!a) throw new LedgerError(["Assign the INPUT_VAT role to your Input VAT account first"]);
    vat = pct(payment, VAT_RATE * 100n);
    e.fx(a.id, vat, `Input VAT 12% on ${label.toLowerCase()}`, vendorParty(l));
  }
  if (l.ewtTaxCodeId) {
    const t = await tx.taxCode.findUnique({ where: { id: l.ewtTaxCodeId } });
    const a = (t?.accountCode && await tx.account.findUnique({ where: { organizationId_code: { organizationId: l.organizationId, code: t.accountCode } } }))
      || await tx.account.findUnique({ where: { organizationId_systemRole: { organizationId: l.organizationId, systemRole: "EWT_PAYABLE" } } });
    if (!t || !a) throw new LedgerError(["Set up the expanded withholding tax payable account (role EWT_PAYABLE) first"]);
    ewt = pct(payment, BigInt(Math.round(Number(t.rate.toString()) * 100)));
    e.fx(a.id, -ewt, `EWT ${t.code}${t.atcCode ? ` (ATC ${t.atcCode})` : ""} ${t.rate.toString()}%`, vendorParty(l));
  }
  e.fx(l.paymentAccountId, -(payment + vat - ewt), `${label} payable to ${l.lessorName}`, vendorParty(l));
}

/** Posted GL balances of this lease's accounts (base and lease currency), signed debit-positive. */
async function glBalances(tx: Tx, l: LeaseRow) {
  const rows = await tx.journalLine.groupBy({
    by: ["accountId"],
    where: { organizationId: l.organizationId, journalEntry: { source: "LEASE", sourceId: l.id, status: "POSTED", reversedBy: { is: null } } },
    _sum: { debit: true, credit: true, fxDebit: true, fxCredit: true },
  });
  const get = (id: string | null) => {
    const r = rows.find((x) => x.accountId === id);
    return r ? { base: cents(r._sum.debit) - cents(r._sum.credit), fx: cents(r._sum.fxDebit) - cents(r._sum.fxCredit) } : { base: 0n, fx: 0n };
  };
  return get;
}

async function post(tx: Tx, l: LeaseRow, userId: string, date: string, memo: string, lines: LineInput[]) {
  return recordJournalTx(tx, { organizationId: l.organizationId, userId, date: new Date(date), memo, reference: l.number, source: "LEASE", sourceId: l.id, lines, action: "post" });
}

type EventAmounts = Partial<Record<"rouAddition" | "rouRemeasurement" | "rouDerecognized" | "depreciation" | "accumDepDerecognized" | "liabilityAddition" | "liabilityRemeasurement" | "interest" | "payment" | "liabilityDerecognized" | "gainLoss" | "rentExpense", bigint>>;
async function event(tx: Tx, l: LeaseRow, userId: string, type: string, date: string, journalEntryId: string | null, amounts: EventAmounts, details: object | null = null, scheduleLineId: string | null = null) {
  return tx.leaseEvent.create({
    data: {
      leaseId: l.id, organizationId: l.organizationId, type, date: new Date(date), journalEntryId, scheduleLineId, createdById: userId,
      ...Object.fromEntries(Object.entries(amounts).map(([k, v]) => [k, dec(v ?? 0n)])),
      details: details ? (JSON.parse(JSON.stringify(details, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Prisma.InputJsonValue) : undefined,
    },
  });
}

async function lockLease(tx: Tx, organizationId: string, id: string) {
  // Serialise postings on one lease.
  await tx.$executeRaw`SELECT 1 FROM "Lease" WHERE id = ${id} FOR UPDATE`;
  const l = await tx.lease.findFirst({ where: { id, organizationId } });
  if (!l) throw new LedgerError(["Lease not found"]);
  return l;
}

const curAcct = (l: LeaseRow) => l.currentLiabilityAccountId ?? l.liabilityAccountId;

// ---------- Commencement ----------

/** Approve the draft and recognise the ROU asset and lease liability (or take up balances at go-live). */
export async function commenceLease(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const l = await lockLease(tx, organizationId, id);
    if (l.status !== "DRAFT") throw new LedgerError(["This lease has already started"]);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (org.segregationOfDuties && [l.createdById, l.updatedById].includes(userId)) {
      throw new LedgerError(["Segregation of duties: someone other than the person who prepared the lease must approve it"]);
    }
    const rows = (await tx.leaseScheduleLine.findMany({ where: { leaseId: id }, orderBy: { periodStart: "asc" } })).map(rowOf);
    const exempt = isExempt(l);
    let entryId: string | null = null;
    let type = "COMMENCEMENT";
    let amounts: EventAmounts = {};
    const start = ymd(l.commencementDate);

    if (l.takeUpDate) {
      // Existing lease at go-live: months before go-live are already in the old books.
      type = "TAKE_UP";
      const g = ymd(l.takeUpDate);
      const before = rows.filter((r) => r.periodEnd < g);
      const last = before[before.length - 1];
      const rate = await postingRate(tx, l, org.baseCurrency);
      const e = new Entry(org.baseCurrency, l.currencyCode, rate);
      const label = `Lease ${l.number} balances taken up at go-live`;
      if (exempt) {
        const accrued = before.reduce((s, r) => s + r.depreciation - r.payment, 0n); // + = accrued rent payable
        e.fx(l.liabilityAccountId, -accrued, accrued >= 0n ? "Accrued rent" : "Prepaid rent");
        amounts = { rentExpense: 0n };
      } else {
        const cost = cents(l.initialRou);
        const acc = cost - last.rouClosing;
        e.baseLine(l.rouAccountId, cost, "Right-of-use asset (cost)");
        e.baseLine(l.accumDepAccountId, -acc, "Accumulated depreciation to go-live");
        const cur = l.currentLiabilityAccountId ? last.currentPortion : 0n;
        e.fx(curAcct(l), -cur, "Lease liability - current portion");
        e.fx(l.liabilityAccountId, -(last.closing - cur), "Lease liability - non-current");
        amounts = { rouAddition: cost, depreciation: acc, liabilityAddition: last.closing };
      }
      if (e.lines.length) {
        e.baseLine(l.takeUpOffsetAccountId!, -e.net(), "Opening balance offset", {}, true);
        const je = await post(tx, l, userId, g, label, e.finish(l.takeUpOffsetAccountId!));
        entryId = je.id;
      }
      await tx.leaseScheduleLine.updateMany({ where: { leaseId: id, periodEnd: { lt: l.takeUpDate } }, data: { postedAt: new Date() } });
    } else if (!exempt) {
      const m = measure(l);
      const e = new Entry(org.baseCurrency, l.currencyCode, l.fxRate.toString());
      const cur = l.currentLiabilityAccountId ? m.currentAtStart : 0n;
      e.fx(curAcct(l), -cur, "Lease liability - current portion");
      e.fx(l.liabilityAccountId, -(m.liability - cur), "Lease liability - non-current");
      const offset = cents(l.prepaidLeasePayments) + cents(l.initialDirectCosts) - cents(l.leaseIncentives);
      if (offset !== 0n) e.baseLine(l.initialCostsAccountId!, -offset, "Advance rent / initial direct costs, net of incentives");
      if (cents(l.restorationCost) > 0n) e.baseLine(l.restorationAccountId!, -cents(l.restorationCost), "Provision for restoration (PAS 37)");
      const rou = e.toBase(cur) + e.toBase(m.liability - cur) + offset + cents(l.restorationCost);
      e.baseLine(l.rouAccountId, rou, `Right-of-use asset: ${l.assetDescription}`, {}, true);
      const je = await post(tx, l, userId, start, `Lease commencement ${l.number}: ${l.assetDescription} (${l.lessorName})`, e.finish(l.rouAccountId));
      entryId = je.id;
      amounts = { rouAddition: rou, liabilityAddition: m.liability };
      if (rou !== cents(l.initialRou)) {
        // keep depreciation equal to the asset actually booked (FX rounding)
        const s = buildSchedule({ start, leaseEnd: ymd(l.endDate), depEnd: depreciationEnd({ commencementDate: start, endDate: ymd(l.endDate), transfersOwnership: l.transfersOwnership, usefulLifeMonths: l.usefulLifeMonths }), payments: paymentsOf(l), rate: rateOf(l), rou });
        await tx.leaseScheduleLine.deleteMany({ where: { leaseId: id } });
        await tx.leaseScheduleLine.createMany({ data: s.rows.map((r) => rowData(id, organizationId, r)) });
        await tx.lease.update({ where: { id }, data: { initialRou: dec(rou) } });
      }
    }
    await event(tx, l, userId, type, l.takeUpDate ? ymd(l.takeUpDate) : start, entryId, amounts);
    const updated = await tx.lease.update({ where: { id }, data: { status: "ACTIVE", approvedById: userId, approvedAt: new Date() } });
    await audit(tx, organizationId, userId, "lease.commence", id, { number: l.number, journal: entryId }, null, null, "lease");
    return updated;
  });
}

// ---------- Monthly postings ----------

async function postRow(tx: Tx, l: LeaseRow, userId: string, base: string, row: ReturnType<typeof rowOf>, isLast: boolean) {
  const rate = await postingRate(tx, l, base);
  const e = new Entry(base, l.currencyCode, rate);
  const month = row.periodEnd.slice(0, 7);
  const dims = dimsOf(l);
  let amounts: EventAmounts;
  if (isExempt(l)) {
    const exp = e.toBase(row.depreciation);
    e.baseLine(l.rentExpenseAccountId ?? l.depreciationAccountId, exp, `Rent expense (straight line) ${month}`, dims, true);
    e.fx(l.liabilityAccountId, -row.depreciation, "Accrued rent");
    await paymentLines(tx, e, l, l.liabilityAccountId, row.payment, "Rent");
    amounts = { rentExpense: exp, payment: row.payment };
  } else {
    const bal = await glBalances(tx, l);
    e.baseLine(l.interestAccountId, e.toBase(row.interest), `Interest on lease liability ${month}`, dims, true);
    e.fx(curAcct(l), -row.interest, "Interest added to lease liability");
    e.baseLine(l.depreciationAccountId, row.depreciation, `Depreciation of right-of-use asset ${month}`, dims);
    e.baseLine(l.accumDepAccountId, -row.depreciation, "Accumulated depreciation - ROU");
    await paymentLines(tx, e, l, curAcct(l), row.payment, "Lease payment");
    if (l.currentLiabilityAccountId) {
      const curAfter = -bal(l.currentLiabilityAccountId).fx + row.interest - row.payment; // credit balance
      const target = isLast ? 0n : row.currentPortion;
      const move = target - curAfter;
      if (move !== 0n) {
        e.fx(l.liabilityAccountId, move, move > 0n ? "Reclass: due within 12 months" : "Reclass to non-current");
        e.fx(l.currentLiabilityAccountId, -move, "Lease liability - current portion");
      }
    }
    amounts = { interest: row.interest, payment: row.payment, depreciation: row.depreciation };
    if (isLast) {
      // End of the lease: the fully depreciated ROU asset comes off the books.
      const cost = bal(l.rouAccountId).base, acc = -bal(l.accumDepAccountId).base + row.depreciation;
      if (cost !== 0n && cost === acc) {
        e.baseLine(l.accumDepAccountId, acc, "Derecognise fully depreciated ROU asset");
        e.baseLine(l.rouAccountId, -cost, "Derecognise ROU asset at end of lease");
        amounts.rouDerecognized = cost; amounts.accumDepDerecognized = acc;
      }
    }
  }
  const lines = e.finish(l.gainLossAccountId);
  let entryId: string | null = null;
  if (lines.length >= 2) entryId = (await post(tx, l, userId, row.periodEnd, `Lease ${l.number} ${month}: ${isExempt(l) ? "rent" : "interest, depreciation and payment"}`, lines)).id;
  await tx.leaseScheduleLine.update({ where: { id: row.id }, data: { journalEntryId: entryId, postedAt: new Date() } });
  await event(tx, l, userId, "PERIOD", row.periodEnd, entryId, amounts, null, row.id);
  if (isLast) await tx.lease.update({ where: { id: l.id }, data: { status: "ENDED" } });
}

/** Post every unposted month that ends on or before `through`, for one lease or all active leases. */
export async function postLeasePeriods(organizationId: string, userId: string, through: Date, leaseId?: string) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const leases = await prisma.lease.findMany({ where: { organizationId, status: "ACTIVE", ...(leaseId ? { id: leaseId } : {}) }, orderBy: { number: "asc" } });
  const result = { posted: 0, errors: [] as string[] };
  for (const lease of leases) {
    try {
      const n = await prisma.$transaction(async (tx) => {
        const l = await lockLease(tx, organizationId, lease.id);
        if (l.status !== "ACTIVE") return 0;
        const all = (await tx.leaseScheduleLine.findMany({ where: { leaseId: l.id }, orderBy: { periodStart: "asc" } })).map(rowOf);
        let count = 0;
        for (let i = 0; i < all.length; i++) {
          const r = all[i];
          if (r.postedAt || r.periodEnd > ymd(asDay(through))) continue;
          await postRow(tx, l, userId, org.baseCurrency, r, i === all.length - 1);
          count++;
        }
        if (count) await audit(tx, organizationId, userId, "lease.post_periods", l.id, { number: l.number, through: ymd(asDay(through)), months: count }, null, null, "lease");
        return count;
      }, { timeout: 60_000 });
      result.posted += n;
    } catch (e) {
      if (e instanceof LedgerError) result.errors.push(`${lease.number}: ${e.errors.join("; ")}`);
      else throw e;
    }
  }
  return result;
}

// ---------- Modification and termination ----------

/** The first unposted month and the part of it up to `date` (inclusive), for mid-month events. */
async function openRow(tx: Tx, l: LeaseRow, date: string, what: string) {
  const rows = (await tx.leaseScheduleLine.findMany({ where: { leaseId: l.id }, orderBy: { periodStart: "asc" } })).map(rowOf);
  const first = rows.find((r) => !r.postedAt);
  if (!first) throw new LedgerError(["Every month of this lease is already posted"]);
  if (date < first.periodStart) throw new LedgerError([`The ${what} date must be on or after ${first.periodStart}: months up to then are already posted. Undo those postings first if needed.`]);
  if (date > first.periodEnd) throw new LedgerError([`Post the lease entries through ${addDays(date.slice(0, 8) + "01", -1)} first (Leases → Post lease entries). A ${what} takes effect within the first unposted month (${first.periodStart} to ${first.periodEnd}).`]);
  return { rows, first, index: rows.indexOf(first) };
}

/** Liability, depreciation and payments of row r from its start to `to` (inclusive). */
function partial(l: LeaseRow, r: ReturnType<typeof rowOf>, to: string) {
  if (to < r.periodStart) return { interest: 0n, payment: 0n, closing: r.opening, depreciation: 0n };
  const days = BigInt(daysBetween(r.periodStart, addDays(to, 1))), all = BigInt(daysBetween(r.periodStart, addDays(r.periodEnd, 1)));
  const dep = (r.depreciation * days * 2n + all) / (2n * all);
  if (isExempt(l)) {
    const payment = paymentsOf(l).filter((p) => p.date >= r.periodStart && p.date <= to).reduce((s, p) => s + p.amount, 0n);
    return { interest: 0n, payment, closing: 0n, depreciation: dep };
  }
  const a = accrue(r.opening, r.periodStart, to, paymentsOf(l), rateOf(l), ymd(l.commencementDate));
  return { ...a, depreciation: dep };
}

function snapshotTerms(l: LeaseRow) {
  return { endDate: ymd(l.endDate), paymentAmount: l.paymentAmount.toString(), escalationPct: l.escalationPct.toString(), discountRate: l.discountRate.toString(), payments: l.payments, status: l.status };
}

export type ModificationInput = {
  effectiveDate: string;          // first day the new terms apply
  newEndDate: string;
  newPaymentAmount: string;       // per period from the effective date, before escalation
  newEscalationPct?: string | null;
  newDiscountRate?: string | null; // blank = keep the current rate (e.g. a change in an index)
  scopeReductionPct?: string | null; // decrease in scope (e.g. 50 = half the floor area given back)
  memo: string;
};

/** Lease modification not accounted for as a separate lease (PFRS 16.44-46). */
export async function modifyLease(organizationId: string, userId: string, id: string, m: ModificationInput) {
  return prisma.$transaction(async (tx) => {
    const l = await lockLease(tx, organizationId, id);
    if (l.status !== "ACTIVE") throw new LedgerError(["Only an active lease can be modified"]);
    if (isExempt(l)) throw new LedgerError(["A short-term or low-value lease is not remeasured. Terminate it and set up the new terms as a new lease."]);
    const errors: string[] = [];
    const D = m.effectiveDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(D)) errors.push("Enter the effective date");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.newEndDate) || m.newEndDate < D) errors.push("The new end date must be on or after the effective date");
    if (D <= ymd(l.commencementDate)) errors.push("The effective date must be after the lease start date");
    const newAmt = money(m.newPaymentAmount, "New payment amount", errors);
    const p = num(m.scopeReductionPct) ?? 0;
    if (Number.isNaN(p) || p < 0 || p >= 100) errors.push("Decrease in scope must be a % from 0 to less than 100 (use Terminate for 100%)");
    const newRatePct = num(m.newDiscountRate) ?? Number(l.discountRate.toString());
    if (Number.isNaN(newRatePct) || newRatePct < 0 || newRatePct > 100) errors.push("Discount rate must be an annual % between 0 and 100");
    const esc = num(m.newEscalationPct) ?? Number(l.escalationPct.toString());
    if (!m.memo?.trim()) errors.push("Describe the modification (e.g. renewed for 2 more years at P60,000 a month)");
    if (errors.length) throw new LedgerError(errors);

    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const { rows, first, index } = await openRow(tx, l, D, "modification");
    const pre = partial(l, first, addDays(D, -1));
    const rate = await postingRate(tx, l, org.baseCurrency);
    const e = new Entry(org.baseCurrency, l.currencyCode, rate);
    const dims = dimsOf(l);
    const bal = await glBalances(tx, l);

    // 1. The part of the month before the change, under the old terms.
    if (D > first.periodStart) {
      e.baseLine(l.interestAccountId, e.toBase(pre.interest), `Interest on lease liability ${first.periodStart} to ${addDays(D, -1)}`, dims, true);
      e.fx(curAcct(l), -pre.interest, "Interest added to lease liability");
      e.baseLine(l.depreciationAccountId, pre.depreciation, "Depreciation of right-of-use asset (part month)", dims);
      e.baseLine(l.accumDepAccountId, -pre.depreciation, "Accumulated depreciation - ROU");
      await paymentLines(tx, e, l, curAcct(l), pre.payment, "Lease payment");
    }
    const L0 = pre.closing;
    const cost = bal(l.rouAccountId).base;
    const acc = -bal(l.accumDepAccountId).base + pre.depreciation;

    // 2. Decrease in scope: derecognise the proportion given up; difference to profit or loss (16.46a).
    const pm = BigInt(Math.round(p * 10000)); // % with 4 dp -> x/1,000,000
    const part = (x: bigint) => (x * pm + 500000n) / 1000000n;
    const liabOut = part(L0), costOut = part(cost), accOut = part(acc);
    let gain = 0n;
    if (pm > 0n) {
      e.fx(l.liabilityAccountId, liabOut, `Decrease in scope ${p}%: lease liability`);
      e.baseLine(l.accumDepAccountId, accOut, `Decrease in scope ${p}%: accumulated depreciation`);
      e.baseLine(l.rouAccountId, -costOut, `Decrease in scope ${p}%: ROU asset`);
      gain += e.toBase(liabOut) - (costOut - accOut);
    }

    // 3. Remeasure the remaining liability at the revised payments and rate; adjust the ROU asset (16.45b-c).
    const keep = paymentsOf(l).filter((x) => x.date < D);
    const fresh = generatePayments({
      cadenceStart: ymd(l.commencementDate), from: D, end: m.newEndDate, amount: newAmt, frequency: l.paymentFrequency as Frequency, timing: l.paymentTiming as Timing,
      escalationPct: esc, escalationEveryMonths: l.escalationEveryMonths,
    });
    const rouNet = cost - acc - (costOut - accOut);
    const depEnd = l.transfersOwnership && l.usefulLifeMonths ? depreciationEnd({ commencementDate: ymd(l.commencementDate), endDate: m.newEndDate, transfersOwnership: true, usefulLifeMonths: l.usefulLifeMonths }) : m.newEndDate;
    const probe = buildSchedule({ start: D, leaseEnd: m.newEndDate, depEnd, payments: fresh, rate: newRatePct / 100, origin: ymd(l.commencementDate), rou: 0n });
    const remeasure = probe.liability - (L0 - liabOut);
    let rouAdj = e.toBase(remeasure);
    if (rouNet + rouAdj < 0n) { gain += -(rouNet + rouAdj); rouAdj = -rouNet; } // ROU cannot go below zero (16.39)
    e.fx(l.liabilityAccountId, -remeasure, "Remeasurement of lease liability");
    e.baseLine(l.rouAccountId, rouAdj, "Remeasurement adjustment to ROU asset");
    const sched = buildSchedule({ start: D, leaseEnd: m.newEndDate, depEnd: depEnd > m.newEndDate ? depEnd : m.newEndDate, payments: fresh, rate: newRatePct / 100, origin: ymd(l.commencementDate), rou: rouNet + rouAdj });

    // 4. Current / non-current split under the new terms.
    if (l.currentLiabilityAccountId) {
      const curAfter = -bal(l.currentLiabilityAccountId).fx + pre.interest - pre.payment;
      const move = sched.currentAtStart - curAfter;
      e.fx(l.liabilityAccountId, move, "Reclass: due within 12 months");
      e.fx(l.currentLiabilityAccountId, -move, "Lease liability - current portion");
    }
    if (gain !== 0n) e.baseLine(l.gainLossAccountId, -gain, gain > 0n ? "Gain on lease modification" : "Loss on lease modification", dims, true);
    const lines = e.finish(l.gainLossAccountId);
    if (lines.length < 2) throw new LedgerError(["These terms are the same as the current ones; nothing to change"]);
    const je = await post(tx, l, userId, D, `Lease modification ${l.number}: ${m.memo.trim()}`, lines);

    // 5. Replace the schedule from the effective date; keep what we replaced so the change can be undone.
    const replaced = rows.slice(index);
    await tx.leaseScheduleLine.deleteMany({ where: { leaseId: id, periodStart: { gte: new Date(first.periodStart) } } });
    if (D > first.periodStart) {
      await tx.leaseScheduleLine.create({ data: { ...rowData(id, organizationId, {
        ...first, periodEnd: addDays(D, -1), interest: pre.interest, payment: pre.payment, closing: pre.closing, depreciation: pre.depreciation,
        rouClosing: first.rouOpening - pre.depreciation, currentPortion: sched.currentAtStart,
      }), journalEntryId: je.id, postedAt: new Date() } });
    }
    await tx.leaseScheduleLine.createMany({ data: sched.rows.map((r) => rowData(id, organizationId, r)) });
    const updated = await tx.lease.update({ where: { id }, data: {
      endDate: new Date(m.newEndDate), paymentAmount: dec(newAmt), escalationPct: new Prisma.Decimal(esc), discountRate: new Prisma.Decimal(newRatePct),
      payments: paymentsJson([...keep, ...fresh]),
    } });
    await event(tx, l, userId, "MODIFICATION", D, je.id, {
      interest: pre.interest, payment: pre.payment, depreciation: pre.depreciation,
      rouRemeasurement: rouAdj, rouDerecognized: costOut, accumDepDerecognized: accOut,
      liabilityRemeasurement: remeasure, liabilityDerecognized: liabOut, gainLoss: gain,
    }, { input: m, newLiability: sched.liability, previous: snapshotTerms(l), replacedRows: replaced.map(({ id: _i, journalEntryId: _j, postedAt: _p, ...r }) => r) });
    await audit(tx, organizationId, userId, "lease.modify", id, { number: l.number, journal: je.number, reason: m.memo }, snapshotTerms(l) as Prisma.InputJsonValue, snapshotTerms(updated) as Prisma.InputJsonValue, "lease");
    return updated;
  });
}

/** Early termination: derecognise the ROU asset and liability; difference (and any penalty) to profit or loss. */
export async function terminateLease(organizationId: string, userId: string, id: string, t: { date: string; penalty?: string | null; reason: string }) {
  return prisma.$transaction(async (tx) => {
    const l = await lockLease(tx, organizationId, id);
    if (l.status !== "ACTIVE") throw new LedgerError(["Only an active lease can be terminated"]);
    const errors: string[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) errors.push("Enter the termination date (last day of the lease)");
    if (!t.reason?.trim()) errors.push("Enter the reason for the termination");
    const penalty = money(t.penalty, "Termination penalty", errors);
    if (errors.length) throw new LedgerError(errors);
    if (t.date >= ymd(l.endDate)) throw new LedgerError(["That is on or after the end of the lease; post the remaining months and it will close on its own"]);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const { rows, first, index } = await openRow(tx, l, t.date, "termination");
    const pre = partial(l, first, t.date);
    const rate = await postingRate(tx, l, org.baseCurrency);
    const e = new Entry(org.baseCurrency, l.currencyCode, rate);
    const dims = dimsOf(l);
    const bal = await glBalances(tx, l);
    let gain = 0n;
    const amounts: EventAmounts = { payment: pre.payment };
    if (isExempt(l)) {
      const exp = e.toBase(pre.depreciation);
      e.baseLine(l.rentExpenseAccountId ?? l.depreciationAccountId, exp, "Rent expense to termination date", dims, true);
      e.fx(l.liabilityAccountId, -pre.depreciation, "Accrued rent");
      await paymentLines(tx, e, l, l.liabilityAccountId, pre.payment, "Rent");
      const accrued = -bal(l.liabilityAccountId).fx + pre.depreciation - pre.payment; // + = still payable
      e.fx(l.liabilityAccountId, accrued, "Clear accrued / prepaid rent");
      gain += e.toBase(accrued);
      amounts.rentExpense = exp;
    } else {
      e.baseLine(l.interestAccountId, e.toBase(pre.interest), `Interest on lease liability to ${t.date}`, dims, true);
      e.fx(curAcct(l), -pre.interest, "Interest added to lease liability");
      e.baseLine(l.depreciationAccountId, pre.depreciation, "Depreciation of right-of-use asset to termination", dims);
      e.baseLine(l.accumDepAccountId, -pre.depreciation, "Accumulated depreciation - ROU");
      await paymentLines(tx, e, l, curAcct(l), pre.payment, "Lease payment");
      const cost = bal(l.rouAccountId).base;
      const acc = -bal(l.accumDepAccountId).base + pre.depreciation;
      const curLiab = l.currentLiabilityAccountId ? -bal(l.currentLiabilityAccountId).fx + pre.interest - pre.payment : 0n;
      const ncLiab = pre.closing - curLiab;
      if (l.currentLiabilityAccountId) e.fx(l.currentLiabilityAccountId, curLiab, "Derecognise lease liability - current");
      e.fx(l.liabilityAccountId, l.currentLiabilityAccountId ? ncLiab : pre.closing, "Derecognise lease liability");
      e.baseLine(l.accumDepAccountId, acc, "Derecognise accumulated depreciation");
      e.baseLine(l.rouAccountId, -cost, "Derecognise right-of-use asset");
      gain += e.toBase(pre.closing) - (cost - acc);
      Object.assign(amounts, { interest: pre.interest, depreciation: pre.depreciation, rouDerecognized: cost, accumDepDerecognized: acc, liabilityDerecognized: pre.closing });
    }
    if (penalty > 0n) { e.fx(l.paymentAccountId, -penalty, `Termination penalty payable to ${l.lessorName}`, vendorParty(l)); gain -= e.toBase(penalty); }
    e.baseLine(l.gainLossAccountId, -gain, gain >= 0n ? "Gain on lease termination" : "Loss on lease termination", dims, true);
    const je = await post(tx, l, userId, t.date, `Lease termination ${l.number}: ${t.reason.trim()}`, e.finish(l.gainLossAccountId));
    amounts.gainLoss = gain;

    const replaced = rows.slice(index);
    await tx.leaseScheduleLine.deleteMany({ where: { leaseId: id, periodStart: { gte: new Date(first.periodStart) } } });
    await tx.leaseScheduleLine.create({ data: { ...rowData(id, organizationId, {
      ...first, periodEnd: t.date, interest: pre.interest, payment: pre.payment, closing: 0n, depreciation: pre.depreciation, rouClosing: 0n, currentPortion: 0n,
    }), journalEntryId: je.id, postedAt: new Date() } });
    const updated = await tx.lease.update({ where: { id }, data: { status: "TERMINATED" } });
    await event(tx, l, userId, "TERMINATION", t.date, je.id, amounts, { input: t, previous: snapshotTerms(l), replacedRows: replaced.map(({ id: _i, journalEntryId: _j, postedAt: _p, ...r }) => r) });
    await audit(tx, organizationId, userId, "lease.terminate", id, { number: l.number, journal: je.number, reason: t.reason }, null, null, "lease");
    return updated;
  });
}

// ---------- Undo ----------

/** Undo the most recent posting on a lease (reverses its GL entry). */
export async function undoLastLeaseEvent(organizationId: string, userId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const l = await lockLease(tx, organizationId, id);
    const ev = await tx.leaseEvent.findFirst({ where: { leaseId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (!ev) throw new LedgerError(["Nothing to undo"]);
    if (ev.journalEntryId) await voidOrReverseTx(tx, organizationId, userId, ev.journalEntryId, undefined, true);
    if (ev.type === "PERIOD") {
      if (ev.scheduleLineId) await tx.leaseScheduleLine.update({ where: { id: ev.scheduleLineId }, data: { journalEntryId: null, postedAt: null } });
      if (l.status === "ENDED") await tx.lease.update({ where: { id }, data: { status: "ACTIVE" } });
    } else if (ev.type === "COMMENCEMENT" || ev.type === "TAKE_UP") {
      await tx.leaseScheduleLine.updateMany({ where: { leaseId: id }, data: { journalEntryId: null, postedAt: null } });
      await tx.lease.update({ where: { id }, data: { status: "DRAFT", approvedById: null, approvedAt: null } });
    } else {
      const d = ev.details as { previous: ReturnType<typeof snapshotTerms>; replacedRows: Record<string, string>[] };
      const from = d.replacedRows[0].periodStart;
      await tx.leaseScheduleLine.deleteMany({ where: { leaseId: id, periodStart: { gte: new Date(from) } } });
      await tx.leaseScheduleLine.createMany({ data: d.replacedRows.map((r) => rowData(id, organizationId, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k.startsWith("period") ? v : BigInt(v)])) as unknown as ScheduleRow)) });
      await tx.lease.update({ where: { id }, data: {
        endDate: new Date(d.previous.endDate), paymentAmount: new Prisma.Decimal(d.previous.paymentAmount), escalationPct: new Prisma.Decimal(d.previous.escalationPct),
        discountRate: new Prisma.Decimal(d.previous.discountRate), payments: d.previous.payments as Prisma.InputJsonValue, status: d.previous.status,
      } });
    }
    await tx.leaseEvent.delete({ where: { id: ev.id } });
    await audit(tx, organizationId, userId, "lease.undo", id, { number: l.number, undone: ev.type, date: ymd(ev.date) }, null, null, "lease");
    return ev;
  });
}

export { fmt as fmtLeaseAmount };
