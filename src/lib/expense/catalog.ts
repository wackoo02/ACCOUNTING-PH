// Expense & Mobility catalog: the app's module tiles, providers, transaction types (GL mapping),
// payment methods and the pure rules shared by the server and the app. No database access.
import { toCentavos } from "../money";

export type ModuleKey = "PETTY_CASH" | "TRAVEL" | "TRANSPORT" | "DELIVERY";
export type PaymentKey = "PETTY_CASH_FUND" | "EMPLOYEE" | "GCASH" | "MAYA" | "CREDIT_CARD" | "DEBIT_CARD" | "CORPORATE_WALLET" | "COMPANY_ACCOUNT";

export const MODULES: Record<ModuleKey, { label: string; blurb: string }> = {
  PETTY_CASH: { label: "Petty Cash", blurb: "Receipts paid from a petty cash fund" },
  TRAVEL: { label: "Travel", blurb: "Local and international trips, hotels, flights" },
  TRANSPORT: { label: "Transport", blurb: "Grab, inDrive, JoyRide, Angkas, taxi" },
  DELIVERY: { label: "Sent Package", blurb: "Lalamove, Transportify, couriers" },
};

export type Provider = { key: string; name: string; corporate: string };
/** `corporate` says plainly how a company account with the provider can feed Veritus today. */
export const PROVIDERS: Record<ModuleKey, Provider[]> = {
  TRANSPORT: [
    { key: "GRAB", name: "Grab", corporate: "Grab for Business: rides charged to the company; trip report export can be imported" },
    { key: "INDRIVE", name: "inDrive", corporate: "No corporate API; capture the in-app receipt" },
    { key: "JOYRIDE", name: "JoyRide", corporate: "JoyRide corporate accounts by arrangement; capture the receipt" },
    { key: "ANGKAS", name: "Angkas", corporate: "No corporate API; capture the in-app receipt" },
    { key: "MOVEIT", name: "Move It", corporate: "No corporate API; capture the in-app receipt" },
    { key: "TAXI", name: "Taxi", corporate: "Paper or e-receipt" },
    { key: "OTHER", name: "Other", corporate: "" },
  ],
  DELIVERY: [
    { key: "LALAMOVE", name: "Lalamove", corporate: "Lalamove Business: orders paid from the company wallet; order export can be imported; public API for orders" },
    { key: "TRANSPORTIFY", name: "Transportify", corporate: "Business account billed to the company; order export can be imported" },
    { key: "GRAB_EXPRESS", name: "GrabExpress", corporate: "Grab for Business deliveries; trip report export can be imported" },
    { key: "BORZO", name: "Borzo", corporate: "Business account; capture the receipt" },
    { key: "LBC", name: "LBC", corporate: "Corporate account; capture the receipt" },
    { key: "JNT", name: "J&T Express", corporate: "Capture the receipt" },
    { key: "OTHER", name: "Other", corporate: "" },
  ],
  TRAVEL: [
    { key: "AIRLINE", name: "Airline", corporate: "" },
    { key: "HOTEL", name: "Hotel", corporate: "" },
    { key: "BUS", name: "Bus / van", corporate: "" },
    { key: "FERRY", name: "Ferry", corporate: "" },
    { key: "TRAIN", name: "Train / LRT / MRT", corporate: "" },
    { key: "MEALS", name: "Meals on travel", corporate: "" },
    { key: "OTHER", name: "Other", corporate: "" },
  ],
  PETTY_CASH: [],
};

export type TxType = { key: string; label: string; module: ModuleKey; codes: string[]; role?: string };
/** Automatic GL mapping (debit side). Companies can re-point each type in Mobility Settings. */
export const TRANSACTION_TYPES: TxType[] = [
  { key: "RIDE", label: "Business ride", module: "TRANSPORT", codes: ["6050"] },
  { key: "CLIENT_VISIT", label: "Client visit fare", module: "TRANSPORT", codes: ["6051", "6050"] },
  { key: "STAFF_SHUTTLE", label: "Staff shuttle", module: "TRANSPORT", codes: ["6053", "6050"] },
  { key: "DELIVERY", label: "Delivery / courier", module: "DELIVERY", codes: ["6052"], role: "DELIVERY_EXPENSE" },
  { key: "INVENTORY_DELIVERY", label: "Inventory delivery (freight-in)", module: "DELIVERY", codes: ["1205"], role: "INVENTORY_IN_TRANSIT" },
  { key: "TRAVEL_LOCAL", label: "Local travel", module: "TRAVEL", codes: ["6050"] },
  { key: "TRAVEL_INTERNATIONAL", label: "International travel", module: "TRAVEL", codes: ["6056", "6050"] },
];
export const txType = (key?: string | null) => TRANSACTION_TYPES.find((t) => t.key === key);
export const defaultTxType = (m: ModuleKey) => (m === "TRANSPORT" ? "RIDE" : m === "DELIVERY" ? "DELIVERY" : m === "TRAVEL" ? "TRAVEL_LOCAL" : null);

export const PAYMENTS: Record<PaymentKey, { label: string; kinds: string[]; corporate: boolean }> = {
  PETTY_CASH_FUND: { label: "Petty cash fund", kinds: [], corporate: true },
  EMPLOYEE: { label: "I paid (reimburse me)", kinds: [], corporate: false },
  GCASH: { label: "Corporate GCash", kinds: ["EWALLET"], corporate: true },
  MAYA: { label: "Corporate Maya", kinds: ["EWALLET"], corporate: true },
  CREDIT_CARD: { label: "Corporate credit card", kinds: ["CREDIT_CARD"], corporate: true },
  DEBIT_CARD: { label: "Corporate debit card", kinds: ["CURRENT", "SAVINGS"], corporate: true },
  CORPORATE_WALLET: { label: "Other corporate wallet", kinds: ["EWALLET"], corporate: true },
  COMPANY_ACCOUNT: { label: "Billed to company account", kinds: [], corporate: true },
};
/** Payment methods that need a corporate bank / wallet / card account. */
export const needsPaymentAccount = (p: PaymentKey) => PAYMENTS[p].kinds.length > 0;

/** Best guess of which wallet account is GCash or Maya, by name. */
export function walletMatches(p: PaymentKey, name: string) {
  if (p === "GCASH") return /g\s?cash/i.test(name);
  if (p === "MAYA") return /maya|paymaya/i.test(name);
  if (p === "CORPORATE_WALLET") return !/g\s?cash|maya/i.test(name);
  return true;
}

// ---------- Trip / delivery / travel details ----------

export type DetailField = { key: string; label: string; required?: boolean; type?: "text" | "number" | "datetime" | "select"; options?: string[] };
export const DETAIL_FIELDS: Record<ModuleKey, DetailField[]> = {
  TRANSPORT: [
    { key: "pickup", label: "Pickup location", required: true },
    { key: "dropoff", label: "Drop-off location", required: true },
    { key: "distanceKm", label: "Distance (km)", type: "number" },
    { key: "passenger", label: "Passenger" },
    { key: "clientVisited", label: "Client visited" },
  ],
  DELIVERY: [
    { key: "sender", label: "Sender" },
    { key: "receiver", label: "Receiver", required: true },
    { key: "pickupAddress", label: "Pickup address" },
    { key: "deliveryAddress", label: "Delivery address", required: true },
    { key: "packageType", label: "Package type", type: "select", options: ["Documents", "Small parcel", "Box", "Inventory / goods", "Equipment", "Food", "Other"] },
    { key: "weightKg", label: "Weight (kg)", type: "number" },
  ],
  TRAVEL: [
    { key: "travelType", label: "Trip", type: "select", options: ["LOCAL", "INTERNATIONAL"], required: true },
    { key: "destination", label: "Destination (city / country)", required: true },
    { key: "startDate", label: "From" },
    { key: "endDate", label: "To" },
    { key: "clientVisited", label: "Client / event" },
  ],
  PETTY_CASH: [],
};

/** Amount fields the app shows per module; each non-zero one becomes a voucher line. */
export const AMOUNT_FIELDS: Record<ModuleKey, { key: string; label: string }[]> = {
  TRANSPORT: [{ key: "fare", label: "Fare" }, { key: "tolls", label: "Tolls" }, { key: "parking", label: "Parking" }],
  DELIVERY: [{ key: "deliveryFee", label: "Delivery fee" }, { key: "additionalCharges", label: "Additional charges" }],
  TRAVEL: [], // travel uses receipt items
  PETTY_CASH: [],
};

export function detailErrors(m: ModuleKey, details: Record<string, unknown> | null | undefined, purpose: string | null | undefined): string[] {
  if (m === "PETTY_CASH") return [];
  const errs: string[] = [];
  if (!purpose?.trim()) errs.push("Enter the business purpose");
  for (const f of DETAIL_FIELDS[m]) {
    const v = details?.[f.key];
    if (f.required && (v === undefined || v === null || String(v).trim() === "")) errs.push(`Enter the ${f.label.toLowerCase()}`);
    if (f.type === "number" && v !== undefined && v !== null && String(v).trim() !== "" && !(Number(v) >= 0)) errs.push(`${f.label} must be a number`);
    if (f.type === "select" && v && f.options && !f.options.includes(String(v))) errs.push(`${f.label}: choose one of ${f.options.join(", ")}`);
  }
  return errs;
}

export type AmountLine = { description: string; unitPrice: string; accountId: string };
/** Fare / tolls / parking (or delivery fee / charges) become one line each on the mapped account. */
export function amountLines(m: ModuleKey, amounts: Record<string, string | number | null | undefined> | null | undefined, accountId: string, provider?: string | null): AmountLine[] {
  const name = provider ? PROVIDERS[m].find((p) => p.key === provider)?.name ?? provider : MODULES[m].label;
  const out: AmountLine[] = [];
  for (const f of AMOUNT_FIELDS[m]) {
    const v = amounts?.[f.key];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    let c = 0n;
    try { c = toCentavos(v); } catch { c = -1n; }
    if (c === 0n) continue;
    out.push({ description: `${name} ${f.label.toLowerCase()}`, unitPrice: String(v), accountId });
  }
  return out;
}

// ---------- Tax rule ----------

const TIN_DIGITS = (t?: string | null) => (t ?? "").replace(/\D/g, "");
/**
 * Philippine input VAT needs the supplier's VAT registration TIN on the receipt.
 * No TIN, no receipt, or a foreign receipt means the expense is treated as non-VAT automatically.
 */
export function vatTreatment(input: { tin?: string | null; vatRegistered?: boolean | null; noReceipt?: boolean; currencyCode?: string | null; baseCurrency?: string }): { vatRegistered: boolean; reason: string | null } {
  const base = input.baseCurrency ?? "PHP";
  if (input.noReceipt) return { vatRegistered: false, reason: "No receipt: recorded as non-VAT (no input VAT claimed)" };
  if (input.currencyCode && input.currencyCode !== base) return { vatRegistered: false, reason: "Foreign receipt: no Philippine input VAT" };
  if (TIN_DIGITS(input.tin).length < 9) {
    return { vatRegistered: false, reason: input.vatRegistered ? "No VAT registration TIN on the receipt, so it is recorded as non-VAT" : null };
  }
  return { vatRegistered: input.vatRegistered ?? true, reason: null };
}

// ---------- Duplicate detection ----------

export type DupCandidate = { id: string; number: string; provider: string | null; bookingNumber: string | null; employeeId: string | null; receiptDate: string; total: bigint; docNumber: string | null; vendorTin: string | null; imageId: string | null };
const norm = (s?: string | null) => (s ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();

/** Same booking number, same photo, same OR number from the same supplier, or same person + day + amount. */
export function findDuplicates(me: Omit<DupCandidate, "id" | "number">, others: DupCandidate[]): { number: string; id: string; reason: string; strong: boolean }[] {
  const out: { number: string; id: string; reason: string; strong: boolean }[] = [];
  for (const o of others) {
    if (me.bookingNumber && norm(o.bookingNumber) === norm(me.bookingNumber) && (!me.provider || !o.provider || o.provider === me.provider)) out.push({ id: o.id, number: o.number, reason: `same booking number ${me.bookingNumber}`, strong: true });
    else if (me.imageId && o.imageId === me.imageId) out.push({ id: o.id, number: o.number, reason: "same receipt photo", strong: true });
    else if (me.docNumber && norm(o.docNumber) === norm(me.docNumber) && TIN_DIGITS(o.vendorTin).slice(0, 9) === TIN_DIGITS(me.vendorTin).slice(0, 9) && TIN_DIGITS(me.vendorTin)) out.push({ id: o.id, number: o.number, reason: `same receipt no. ${me.docNumber} from the same supplier`, strong: true });
    else if (me.employeeId && o.employeeId === me.employeeId && o.receiptDate === me.receiptDate && o.total === me.total) out.push({ id: o.id, number: o.number, reason: "same person, date and amount", strong: false });
  }
  return out;
}

// ---------- Checks shown to approvers ----------

export type Check = { key: string; label: string; ok: boolean; level: "info" | "warn" | "block"; note: string };
export const checksBlock = (cs: Check[]) => cs.some((c) => !c.ok && c.level === "block");
