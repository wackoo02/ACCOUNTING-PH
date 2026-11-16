// How sub-ledgers and users put tax data into the engine.
//
//   await recordTaxEntries(tx, { organizationId, userId, journalEntryId: entry.id, source: "SALES", sourceId: invoice.id, entries: [...] })
//
// Call it in the same transaction that posts the GL entry. Re-calling it for the same source document
// replaces its rows, so an edited-and-reposted document never double counts. Rows follow their journal
// entry: when the entry is reversed they drop out of the returns automatically.
import { Prisma, type JournalSource } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit, LedgerError } from "@/lib/ledger/service";
import { toCentavos } from "@/lib/money";
import { PURCHASE_CLASSES, SALES_CLASSES, TAX_KINDS, type TaxEntryInput, type TaxKind } from "./types";

type Tx = Prisma.TransactionClient;

export { normTin } from "./tin";

/** Look up a customer / vendor / employee by id or code and return the BIR party details. */
export async function partyDetails(tx: Tx, organizationId: string, type: string | null | undefined, idOrCode: string | null | undefined) {
  if (!type || !idOrCode) return null;
  const where = { organizationId, OR: [{ id: idOrCode }, { code: idOrCode }] };
  if (type === "VENDOR") {
    const v = await tx.vendor.findFirst({ where });
    return v && { id: v.id, tin: v.tin, name: v.name, address: v.address, lastName: null, firstName: null, middleName: null };
  }
  if (type === "CUSTOMER") {
    const c = await tx.customer.findFirst({ where });
    return c && { id: c.id, tin: c.tin, name: c.name, address: c.address, lastName: null, firstName: null, middleName: null };
  }
  if (type === "EMPLOYEE" || type === "PARTNER") {
    const e = await tx.employee.findFirst({ where });
    return e && { id: e.id, tin: e.tin, name: `${e.lastName}, ${e.firstName}${e.middleName ? ` ${e.middleName}` : ""}`, address: null, lastName: e.lastName, firstName: e.firstName, middleName: e.middleName };
  }
  return null;
}

function check(e: TaxEntryInput, i: number) {
  const errs: string[] = [];
  const at = `Tax line ${i + 1}`;
  if (!TAX_KINDS.includes(e.kind)) errs.push(`${at}: unknown tax kind ${e.kind}`);
  if (e.vatClass) {
    const sales = e.kind === "OUTPUT_VAT";
    const ok = (sales ? SALES_CLASSES : PURCHASE_CLASSES) as readonly string[];
    if (!ok.includes(e.vatClass)) errs.push(`${at}: ${e.vatClass} is not a valid ${sales ? "sales" : "purchase"} classification`);
  } else if (e.kind === "OUTPUT_VAT" || e.kind === "INPUT_VAT") errs.push(`${at}: choose the VAT classification`);
  if ((e.kind === "EWT" || e.kind === "FWT" || e.kind === "CWT") && !e.atcCode) errs.push(`${at}: enter the ATC (e.g. WC158)`);
  try { toCentavos(e.taxBase); toCentavos(e.taxAmount); } catch (x) { errs.push(`${at}: ${(x as Error).message}`); }
  return errs;
}

export async function recordTaxEntries(tx: Tx, input: {
  organizationId: string; userId?: string | null; journalEntryId?: string | null; source: JournalSource; sourceId: string; entries: TaxEntryInput[];
}) {
  const errs = input.entries.flatMap(check);
  if (errs.length) throw new LedgerError(errs);
  const refs = new Set<string>();
  for (const e of input.entries) {
    if (refs.has(e.ref)) throw new LedgerError([`Tax line key ${e.ref} is used twice`]);
    refs.add(e.ref);
  }
  await tx.taxEntry.deleteMany({ where: { organizationId: input.organizationId, source: input.source, sourceId: input.sourceId } });
  if (!input.entries.length) return 0;
  const rows: Prisma.TaxEntryCreateManyInput[] = [];
  for (const e of input.entries) {
    const looked = e.party ? await partyDetails(tx, input.organizationId, e.party.type, e.party.id) : null;
    rows.push({
      organizationId: input.organizationId, journalEntryId: input.journalEntryId ?? null, journalLineId: e.journalLineId ?? null,
      source: input.source, sourceId: input.sourceId, sourceRef: e.ref, kind: e.kind, vatClass: e.vatClass ?? null,
      taxCodeId: e.taxCodeId ?? null, atcCode: e.atcCode?.toUpperCase() ?? null, rate: new Prisma.Decimal(String(e.rate ?? 0)),
      taxBase: new Prisma.Decimal(String(e.taxBase).replace(/,/g, "")), taxAmount: new Prisma.Decimal(String(e.taxAmount).replace(/,/g, "")),
      date: e.date, docType: e.docType ?? null, docNumber: e.docNumber ?? null, description: e.description ?? null,
      partyType: e.party?.type ?? null, partyId: looked?.id ?? e.party?.id ?? null,
      partyTin: e.party?.tin ?? looked?.tin ?? null, partyName: e.party?.name ?? looked?.name ?? null,
      partyLastName: e.party?.lastName ?? looked?.lastName ?? null, partyFirstName: e.party?.firstName ?? looked?.firstName ?? null,
      partyMiddleName: e.party?.middleName ?? looked?.middleName ?? null, partyAddress: e.party?.address ?? looked?.address ?? null,
      createdById: input.userId ?? null,
    });
  }
  await tx.taxEntry.createMany({ data: rows });
  return rows.length;
}

/** Remove a document's tax rows (e.g. a draft invoice was deleted). Posted documents are reversed instead. */
export async function clearTaxEntries(tx: Tx, organizationId: string, source: JournalSource, sourceId: string) {
  await tx.taxEntry.deleteMany({ where: { organizationId, source, sourceId } });
}

/**
 * Classify a GL line on a tax account that no module explained (manual journals, opening balances,
 * cash vouchers with an Input VAT line). kind "EXCLUDED" marks it as not a tax transaction.
 */
export async function classifyJournalLine(organizationId: string, userId: string, journalLineId: string, input: Omit<TaxEntryInput, "ref" | "journalLineId" | "date"> | { kind: "EXCLUDED"; description?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const line = await tx.journalLine.findFirst({ where: { id: journalLineId, organizationId }, include: { journalEntry: true } });
    if (!line) throw new LedgerError(["Journal line not found"]);
    if (line.journalEntry.status !== "POSTED") throw new LedgerError(["Only posted entries can be classified"]);
    await tx.taxEntry.deleteMany({ where: { organizationId, journalLineId } });
    const e = line.journalEntry;
    if (input.kind === "EXCLUDED") {
      await tx.taxEntry.create({ data: {
        organizationId, journalEntryId: e.id, journalLineId, source: "MANUAL", sourceId: e.id, sourceRef: journalLineId, kind: "EXCLUDED",
        taxBase: 0, taxAmount: 0, date: e.date, description: input.description ?? null, createdById: userId,
      } });
    } else {
      await recordTaxEntries(tx, { organizationId, userId, journalEntryId: e.id, source: "MANUAL", sourceId: `line:${journalLineId}`, entries: [{
        ...input, ref: journalLineId, journalLineId, date: e.transactionDate ?? e.date,
        docNumber: input.docNumber ?? e.reference ?? e.number, docType: input.docType ?? "JV",
      }] });
    }
    await audit(tx, organizationId, userId, "tax.classify", journalLineId, { entry: e.number, kind: input.kind } as Prisma.InputJsonValue, null, null, "tax");
  });
}

export async function unclassifyJournalLine(organizationId: string, userId: string, journalLineId: string) {
  return prisma.$transaction(async (tx) => {
    const n = await tx.taxEntry.deleteMany({ where: { organizationId, journalLineId, source: "MANUAL" } });
    if (n.count) await audit(tx, organizationId, userId, "tax.unclassify", journalLineId, null, null, null, "tax");
  });
}

export const isTaxKind = (k: string): k is TaxKind => (TAX_KINDS as readonly string[]).includes(k);
