// The tax ledger: every taxable amount in a period, from
//   1. TaxEntry rows written by sub-ledgers (AR, AP, payroll...) and by manual classification, and
//   2. built-in adapters for modules that already hold their tax data
//      (cash vouchers: EWT withheld / CWT received; petty cash vouchers: input VAT and EWT).
// Only amounts whose journal entry is posted and not reversed count.
// tieOut() compares the ledger with the GL tax accounts and lists GL lines nobody explained.
import "server-only";
import { prisma } from "@/lib/db";
import { toCentavos } from "@/lib/money";
import type { Party, TaxKind, TaxLine } from "./types";

const c = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");
const blankParty = (): Party => ({ type: null, id: null, tin: null, name: null, lastName: null, firstName: null, middleName: null, address: null });

type EntryState = { id: string; number: string; status: string; reversed: boolean };
async function entryStates(ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  const rows = list.length ? await prisma.journalEntry.findMany({ where: { id: { in: list } }, select: { id: true, number: true, status: true, reversedBy: { select: { id: true } } } }) : [];
  return new Map<string, EntryState>(rows.map((r) => [r.id, { id: r.id, number: r.number, status: r.status, reversed: !!r.reversedBy }]));
}
const live = (s?: EntryState) => !!s && s.status === "POSTED" && !s.reversed;

async function partyMap(organizationId: string) {
  const [v, cu, e] = await Promise.all([
    prisma.vendor.findMany({ where: { organizationId } }),
    prisma.customer.findMany({ where: { organizationId } }),
    prisma.employee.findMany({ where: { organizationId } }),
  ]);
  const m = new Map<string, Party>();
  for (const x of v) { const p = { type: "VENDOR", id: x.id, tin: x.tin, name: x.name, lastName: null, firstName: null, middleName: null, address: x.address }; m.set(`VENDOR:${x.id}`, p); m.set(`VENDOR:${x.code}`, p); }
  for (const x of cu) { const p = { type: "CUSTOMER", id: x.id, tin: x.tin, name: x.name, lastName: null, firstName: null, middleName: null, address: x.address }; m.set(`CUSTOMER:${x.id}`, p); m.set(`CUSTOMER:${x.code}`, p); }
  for (const x of e) {
    for (const t of ["EMPLOYEE", "PARTNER"]) {
      const p = { type: t, id: x.id, tin: x.tin, name: `${x.lastName}, ${x.firstName}${x.middleName ? ` ${x.middleName}` : ""}`, lastName: x.lastName, firstName: x.firstName, middleName: x.middleName, address: null };
      m.set(`${t}:${x.id}`, p); m.set(`${t}:${x.code}`, p);
    }
  }
  return m;
}

export type LedgerFilter = { kinds?: TaxKind[] };

export async function taxLines(organizationId: string, from: Date, to: Date, f: LedgerFilter = {}): Promise<TaxLine[]> {
  const want = (k: TaxKind) => !f.kinds || f.kinds.includes(k);
  const out: TaxLine[] = [];

  // 1. Rows fed by modules and by manual classification.
  const rows = await prisma.taxEntry.findMany({
    where: { organizationId, date: { gte: from, lte: to }, kind: f.kinds ? { in: f.kinds } : { not: "EXCLUDED" } },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
  const fed = new Set(rows.map((r) => `${r.source}:${r.sourceId}`));
  const states = await entryStates(rows.map((r) => r.journalEntryId));
  for (const r of rows) {
    const st = r.journalEntryId ? states.get(r.journalEntryId) : undefined;
    if (r.journalEntryId && !live(st)) continue;
    out.push({
      key: r.id, kind: r.kind as TaxKind, vatClass: r.vatClass, atcCode: r.atcCode, rate: Number(r.rate), base: c(r.taxBase), tax: c(r.taxAmount),
      date: r.date, source: r.source, sourceId: r.sourceId, journalEntryId: r.journalEntryId, journalNumber: st?.number ?? null, journalLineId: r.journalLineId,
      docType: r.docType, docNumber: r.docNumber, description: r.description,
      party: { type: r.partyType, id: r.partyId, tin: r.partyTin, name: r.partyName, lastName: r.partyLastName, firstName: r.partyFirstName, middleName: r.partyMiddleName, address: r.partyAddress },
    });
  }

  const parties = await partyMap(organizationId);
  const taxCodes = new Map((await prisma.taxCode.findMany({ where: { organizationId } })).map((t) => [t.id, t]));

  // 2a. Cash receipts and disbursements with withholding tax.
  if (want("EWT") || want("CWT") || want("FWT")) {
    const cash = await prisma.cashTransaction.findMany({
      where: { organizationId, status: "POSTED", date: { gte: from, lte: to }, withholdingAmount: { gt: 0 }, type: { in: ["RECEIPT", "DISBURSEMENT"] } },
      orderBy: { date: "asc" },
    });
    const cst = await entryStates(cash.map((t) => t.journalEntryId));
    const vatAccts = new Set((await prisma.account.findMany({ where: { organizationId, systemRole: { in: ["INPUT_VAT", "OUTPUT_VAT"] } }, select: { id: true } })).map((a) => a.id));
    for (const t of cash) {
      if (fed.has(`BANK:${t.id}`)) continue;
      const st = t.journalEntryId ? cst.get(t.journalEntryId) : undefined;
      if (!live(st)) continue;
      const tc = t.withholdingTaxCodeId ? taxCodes.get(t.withholdingTaxCodeId) : undefined;
      const kind: TaxKind = t.type === "RECEIPT" ? "CWT" : tc?.taxType === "FWT" ? "FWT" : "EWT";
      if (!want(kind)) continue;
      const lines = (t.lines as { accountId: string; amount: string }[]) ?? [];
      const base = lines.filter((l) => !vatAccts.has(l.accountId)).reduce((s, l) => s + toCentavos(l.amount), 0n);
      const p = t.partyType && t.partyId ? parties.get(`${t.partyType}:${t.partyId}`) : undefined;
      out.push({
        key: `BANK:${t.id}`, kind, vatClass: null, atcCode: tc?.atcCode ?? tc?.code ?? null, rate: tc ? Number(tc.rate) : 0,
        base, tax: c(t.withholdingAmount), date: t.date, source: "BANK", sourceId: t.id, journalEntryId: t.journalEntryId, journalNumber: st?.number ?? null,
        journalLineId: null, docType: t.number.split("-")[0], docNumber: t.reference || t.number, description: t.memo,
        party: p ?? { ...blankParty(), type: t.partyType, name: t.payee },
      });
    }
  }

  // 2a'. Receivables: sales invoices and credit memos (output VAT, or percentage tax for non-VAT sellers)
  //      and collections with tax the customer withheld (BIR 2307 received).
  const toBase = (amt: { mul(x: unknown): { toFixed(n: number): string } }, rate: unknown) => toCentavos(amt.mul(rate).toFixed(2));
  if (want("OUTPUT_VAT") || want("PERCENTAGE")) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { vatRegistered: true } });
    const invs = await prisma.salesInvoice.findMany({
      where: { organizationId, status: "POSTED", date: { gte: from, lte: to } }, include: { lines: true }, orderBy: [{ date: "asc" }, { number: "asc" }],
    });
    const ist = await entryStates(invs.map((i) => i.journalEntryId));
    for (const inv of invs) {
      if (fed.has(`SALES:${inv.id}`)) continue;
      const st = inv.journalEntryId ? ist.get(inv.journalEntryId) : undefined;
      if (!live(st)) continue;
      const sign = inv.kind === "CREDIT_MEMO" ? -1n : 1n;
      const cust = parties.get(`CUSTOMER:${inv.customerId}`);
      const party: Party = { ...blankParty(), type: "CUSTOMER", id: inv.customerId, tin: inv.customerTin ?? cust?.tin ?? null, name: inv.customerName, address: inv.customerAddress ?? cust?.address ?? null };
      const common = { source: "SALES", sourceId: inv.id, journalEntryId: st!.id, journalNumber: st!.number, journalLineId: null, docType: inv.kind === "CREDIT_MEMO" ? "CM" : "SI", docNumber: inv.number, description: inv.memo, date: inv.date, party, atcCode: null };
      const byType = new Map<string, { base: bigint; tax: bigint }>();
      for (const l of inv.lines) {
        const t = byType.get(l.vatType) ?? { base: 0n, tax: 0n };
        t.base += toBase(l.netAmount, inv.fxRate); t.tax += toBase(l.vatAmount, inv.fxRate);
        byType.set(l.vatType, t);
      }
      for (const [vt, t] of byType) {
        if (org.vatRegistered) {
          if (!want("OUTPUT_VAT")) continue;
          out.push({ ...common, key: `SI:${inv.id}:${vt}`, kind: "OUTPUT_VAT", vatClass: vt === "ZERO_RATED" || vt === "EXEMPT" ? vt : "VATABLE", rate: vt === "VATABLE" ? 12 : 0, base: sign * t.base, tax: sign * t.tax });
        } else if (want("PERCENTAGE")) {
          // Non-VAT seller: 3% percentage tax on gross sales (NIRC Sec. 116).
          const base = t.base + t.tax;
          out.push({ ...common, key: `SI:${inv.id}:${vt}`, kind: "PERCENTAGE", vatClass: null, atcCode: "PT010", rate: 3, base: sign * base, tax: sign * ((base * 3n + 50n) / 100n) });
        }
      }
    }
  }
  if (want("CWT") || want("VAT_WITHHELD") || want("PT_WITHHELD")) {
    const recs = await prisma.arReceipt.findMany({ where: { organizationId, status: "POSTED", date: { gte: from, lte: to }, withholdingAmount: { gt: 0 } }, orderBy: { date: "asc" } });
    const rst = await entryStates(recs.map((r) => r.journalEntryId));
    for (const r of recs) {
      if (fed.has(`SALES:${r.id}`)) continue;
      const st = r.journalEntryId ? rst.get(r.journalEntryId) : undefined;
      if (!live(st)) continue;
      const tc = r.withholdingTaxCodeId ? taxCodes.get(r.withholdingTaxCodeId) : undefined;
      const atc = (tc?.atcCode ?? tc?.code ?? "").toUpperCase();
      // VAT withheld by government agencies uses WV ATCs; percentage tax withheld uses PT ATCs.
      const kind: TaxKind = atc.startsWith("WV") ? "VAT_WITHHELD" : atc.startsWith("PT") ? "PT_WITHHELD" : "CWT";
      if (!want(kind)) continue;
      const tax = toBase(r.withholdingAmount, r.fxRate);
      const rate = tc ? Number(tc.rate) : 0;
      const cust = parties.get(`CUSTOMER:${r.customerId}`);
      out.push({
        key: `OR:${r.id}`, kind, vatClass: null, atcCode: atc || null, rate, base: rate > 0 ? (tax * 20000n + BigInt(Math.round(rate * 100))) / (2n * BigInt(Math.round(rate * 100))) : 0n, tax,
        date: r.date, source: "SALES", sourceId: r.id, journalEntryId: st!.id, journalNumber: st!.number, journalLineId: null, docType: "OR", docNumber: r.number, description: r.memo,
        party: cust ?? { ...blankParty(), type: "CUSTOMER", id: r.customerId, name: r.customerName },
      });
    }
  }

  // 2a''. Payables: supplier bills (input VAT by purchase class; EWT recognized when the bill is booked).
  if (want("INPUT_VAT") || want("EWT") || want("FWT")) {
    const bills = await prisma.apBill.findMany({ where: { organizationId, status: "POSTED", date: { gte: from, lte: to } }, include: { lines: true }, orderBy: [{ date: "asc" }, { number: "asc" }] });
    const bst = await entryStates(bills.map((b) => b.journalEntryId));
    const GOODS_ATC = /^W[CI](158|640)$/; // purchases of goods (incl. top withholding agents)
    for (const b of bills) {
      if (fed.has(`PURCHASES:${b.id}`)) continue;
      const st = b.journalEntryId ? bst.get(b.journalEntryId) : undefined;
      if (!live(st)) continue;
      const v = parties.get(`VENDOR:${b.vendorId}`);
      const party: Party = v ?? { ...blankParty(), type: "VENDOR", id: b.vendorId };
      const common = { source: "PURCHASES", sourceId: b.id, journalEntryId: st!.id, journalNumber: st!.number, journalLineId: null, docType: "BILL", docNumber: b.supplierInvoiceNo, description: b.memo, date: b.date, party };
      const vat = new Map<string, { base: bigint; tax: bigint }>();
      const ewt = new Map<string, { base: bigint; tax: bigint; tc: NonNullable<ReturnType<typeof taxCodes.get>> }>();
      for (const l of b.lines) {
        const tc = l.ewtTaxCodeId ? taxCodes.get(l.ewtTaxCodeId) : undefined;
        const atc = (tc?.atcCode ?? "").toUpperCase();
        const cls = l.vatType === "ZERO_RATED" || l.vatType === "EXEMPT" ? l.vatType
          : l.category === "FIXED_ASSET" ? "CAPITAL_GOODS"
          : l.category === "INVENTORY" || GOODS_ATC.test(atc) || !tc ? "GOODS" : "SERVICES";
        const net = toBase(l.netAmount, b.fxRate);
        // No VAT on the line (non-VAT supplier or exempt item) goes to the exempt column.
        const k = c(l.vatAmount) === 0n && cls !== "ZERO_RATED" ? "EXEMPT" : cls;
        const t = vat.get(k) ?? { base: 0n, tax: 0n };
        t.base += net; t.tax += toBase(l.vatAmount, b.fxRate);
        vat.set(k, t);
        if (tc && c(l.ewtAmount) > 0n) {
          const e = ewt.get(tc.id) ?? { base: 0n, tax: 0n, tc };
          e.base += net; e.tax += toBase(l.ewtAmount, b.fxRate);
          ewt.set(tc.id, e);
        }
      }
      if (want("INPUT_VAT")) for (const [cls, t] of vat) out.push({ ...common, key: `APV:${b.id}:${cls}`, kind: "INPUT_VAT", vatClass: cls, atcCode: null, rate: t.tax > 0n ? 12 : 0, base: t.base, tax: t.tax });
      for (const [id, e] of ewt) {
        const kind: TaxKind = e.tc.taxType === "FWT" ? "FWT" : "EWT";
        if (want(kind)) out.push({ ...common, key: `APV:${b.id}:${id}`, kind, vatClass: null, atcCode: e.tc.atcCode ?? e.tc.code, rate: Number(e.tc.rate), base: e.base, tax: e.tax });
      }
    }
  }

  // 2b. Petty cash vouchers (mobile app) once their replenishment batch is posted.
  if (want("INPUT_VAT") || want("EWT")) {
    const v = await prisma.pettyCashVoucher.findMany({
      where: { organizationId, receiptDate: { gte: from, lte: to }, batch: { journalEntryId: { not: null } } },
      include: { batch: true, lines: true }, orderBy: { receiptDate: "asc" },
    });
    const vst = await entryStates(v.map((x) => x.batch?.journalEntryId));
    for (const x of v) {
      if (fed.has(`PETTY_CASH:${x.id}`)) continue;
      const st = vst.get(x.batch!.journalEntryId!);
      if (!live(st)) continue;
      const vendor = x.vendorId ? parties.get(`VENDOR:${x.vendorId}`) : undefined;
      const party: Party = { ...blankParty(), type: "VENDOR", id: x.vendorId, tin: x.vendorTin ?? vendor?.tin ?? null, name: x.vendorName, address: x.vendorAddress ?? vendor?.address ?? null };
      const gross = c(x.grossAmount), vat = c(x.vatAmount), exempt = c(x.vatExemptAmount), zero = c(x.zeroRatedAmount);
      const common = { source: "PETTY_CASH", sourceId: x.id, journalEntryId: st!.id, journalNumber: st!.number, journalLineId: null, docType: x.docType, docNumber: x.docNumber, description: x.description, date: x.receiptDate, party };
      if (want("INPUT_VAT")) {
        const cls = x.lines.some((l) => l.isFixedAsset) ? "CAPITAL_GOODS" : "GOODS";
        if (x.vendorVatRegistered && vat > 0n) out.push({ ...common, key: `PCV:${x.id}:vat`, kind: "INPUT_VAT", vatClass: cls, atcCode: null, rate: 12, base: gross - exempt - zero - vat, tax: vat });
        const exemptBase = x.vendorVatRegistered ? exempt : gross;
        if (exemptBase > 0n) out.push({ ...common, key: `PCV:${x.id}:ex`, kind: "INPUT_VAT", vatClass: "EXEMPT", atcCode: null, rate: 0, base: exemptBase, tax: 0n });
        if (x.vendorVatRegistered && zero > 0n) out.push({ ...common, key: `PCV:${x.id}:zr`, kind: "INPUT_VAT", vatClass: "ZERO_RATED", atcCode: null, rate: 0, base: zero, tax: 0n });
      }
      if (want("EWT") && c(x.ewtAmount) > 0n) {
        const tc = x.ewtTaxCodeId ? taxCodes.get(x.ewtTaxCodeId) : undefined;
        out.push({ ...common, key: `PCV:${x.id}:ewt`, kind: "EWT", vatClass: null, atcCode: tc?.atcCode ?? tc?.code ?? null, rate: tc ? Number(tc.rate) : 0, base: gross - vat, tax: c(x.ewtAmount) });
      }
    }
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// ---------- Tie-out with the general ledger ----------

/** GL accounts that hold each kind of tax, and which side of the account a new tax amount goes to. */
const KIND_ROLES: Record<TaxKind, { roles: string[]; taxTypes: string[]; side: "debit" | "credit" }> = {
  OUTPUT_VAT: { roles: ["OUTPUT_VAT"], taxTypes: ["VAT_OUTPUT"], side: "credit" },
  INPUT_VAT: { roles: ["INPUT_VAT"], taxTypes: ["VAT_INPUT"], side: "debit" },
  EWT: { roles: ["EWT_PAYABLE"], taxTypes: ["EWT"], side: "credit" },
  FWT: { roles: ["FWT_PAYABLE"], taxTypes: [], side: "credit" },
  CWT: { roles: ["CWT_RECEIVABLE"], taxTypes: [], side: "debit" },
  VAT_WITHHELD: { roles: ["CVAT_WITHHELD"], taxTypes: [], side: "debit" },
  PERCENTAGE: { roles: ["PERCENTAGE_TAX_PAYABLE"], taxTypes: ["PERCENTAGE"], side: "credit" },
  PT_WITHHELD: { roles: [], taxTypes: [], side: "debit" },
};
// Entries that move tax balances without being a taxable transaction: filings, closings, reversals.
const NON_TAXABLE_SOURCES = ["TAX", "CLOSING", "REVERSAL", "CONSOLIDATION", "FX_REVALUATION"] as const;

export async function taxAccounts(organizationId: string) {
  const accts = await prisma.account.findMany({ where: { organizationId } });
  const byCode = new Map(accts.map((a) => [a.code, a]));
  const codes = await prisma.taxCode.findMany({ where: { organizationId } });
  const map = new Map<string, { kind: TaxKind; side: "debit" | "credit"; code: string; name: string }>();
  for (const [kind, r] of Object.entries(KIND_ROLES) as [TaxKind, (typeof KIND_ROLES)[TaxKind]][]) {
    for (const a of accts) if (a.systemRole && r.roles.includes(a.systemRole)) map.set(a.id, { kind, side: r.side, code: a.code, name: a.name });
    for (const t of codes) {
      if (!r.taxTypes.includes(t.taxType) || !t.accountCode) continue;
      const a = byCode.get(t.accountCode);
      // Only balance-sheet tax accounts (an expense like final tax on our bank interest is not ours to file).
      if (a && (a.type === "ASSET" || a.type === "LIABILITY") && !map.has(a.id)) map.set(a.id, { kind, side: r.side, code: a.code, name: a.name });
    }
  }
  for (const t of codes) if (t.taxType === "FWT" && t.accountCode) {
    const a = byCode.get(t.accountCode);
    if (a?.type === "LIABILITY" && !map.has(a.id)) map.set(a.id, { kind: "FWT", side: "credit", code: a.code, name: a.name });
  }
  return map;
}

export type UnexplainedLine = {
  lineId: string; entryId: string; number: string; date: Date; memo: string; reference: string | null; source: string;
  accountCode: string; accountName: string; kind: TaxKind; amount: bigint; partyType: string | null; partyId: string | null;
  /** Suggested tax base: the entry's other lines that are not tax lines, on the opposite side of the payment. */
  suggestedBase: bigint;
};

export async function tieOut(organizationId: string, from: Date, to: Date) {
  const accts = await taxAccounts(organizationId);
  const lines = await taxLines(organizationId, from, to);
  const glLines = await prisma.journalLine.findMany({
    where: {
      organizationId, accountId: { in: [...accts.keys()] },
      journalEntry: { status: "POSTED", book: "STATUTORY", date: { gte: from, lte: to }, source: { notIn: [...NON_TAXABLE_SOURCES] }, reversedBy: { is: null } },
    },
    include: { journalEntry: { include: { lines: true } } },
    orderBy: { journalEntry: { date: "asc" } },
  });
  const explainedEntries = new Map<string, Set<TaxKind>>();
  const explainedLines = new Set<string>();
  for (const l of lines) {
    if (l.journalLineId) explainedLines.add(l.journalLineId);
    else if (l.journalEntryId) { const s = explainedEntries.get(l.journalEntryId) ?? new Set(); s.add(l.kind); explainedEntries.set(l.journalEntryId, s); }
  }
  const excluded = new Set((await prisma.taxEntry.findMany({ where: { organizationId, kind: "EXCLUDED", journalLineId: { in: glLines.map((l) => l.id) } }, select: { journalLineId: true } })).map((x) => x.journalLineId!));

  const kinds = new Map<TaxKind, { gl: bigint; ledger: bigint }>();
  const bump = (k: TaxKind, f: "gl" | "ledger", v: bigint) => { const r = kinds.get(k) ?? { gl: 0n, ledger: 0n }; r[f] += v; kinds.set(k, r); };
  for (const l of lines) bump(l.kind, "ledger", l.tax);
  const unexplained: UnexplainedLine[] = [];
  for (const gl of glLines) {
    const a = accts.get(gl.accountId)!;
    const amt = a.side === "debit" ? c(gl.debit) - c(gl.credit) : c(gl.credit) - c(gl.debit);
    if (excluded.has(gl.id)) continue;
    const explained = explainedLines.has(gl.id) || !!explainedEntries.get(gl.journalEntryId)?.has(a.kind);
    // The other direction is a payment, application or refund, unless a document with tax details
    // made it (e.g. a credit memo reducing output VAT, which the tax ledger carries as a negative).
    if (amt <= 0n) { if (explained) bump(a.kind, "gl", amt); continue; }
    bump(a.kind, "gl", amt);
    if (explained) continue;
    const others = gl.journalEntry.lines.filter((x) => x.id !== gl.id && !accts.has(x.accountId));
    // VAT sits on the same side as the sale/purchase it belongs to; withholding sits opposite the expense/income.
    const vat = a.kind === "OUTPUT_VAT" || a.kind === "INPUT_VAT" || a.kind === "PERCENTAGE";
    const sameSide = vat ? a.side : a.side === "debit" ? "credit" : "debit";
    const base = others.reduce((s, x) => s + (sameSide === "debit" ? c(x.debit) : c(x.credit)), 0n);
    unexplained.push({
      lineId: gl.id, entryId: gl.journalEntryId, number: gl.journalEntry.number, date: gl.journalEntry.date, memo: gl.journalEntry.memo,
      reference: gl.journalEntry.reference, source: gl.journalEntry.source, accountCode: a.code, accountName: a.name, kind: a.kind, amount: amt,
      partyType: gl.partyType, partyId: gl.partyId, suggestedBase: base,
    });
  }
  return { kinds: [...kinds.entries()].map(([kind, v]) => ({ kind, ...v, difference: v.gl - v.ledger })), unexplained };
}
