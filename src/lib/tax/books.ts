// Books of accounts in the layout BIR expects for loose-leaf / computerized books (RR 9-2009, RMO 29-2002):
// General Journal, Cash Receipts Book, Cash Disbursements Book, Sales Journal and Purchase Journal.
// (The General Ledger is Reports -> General Ledger Listing.) Each row is one journal line, so the books
// add up to the trial balance.
import "server-only";
import { prisma } from "@/lib/db";
import { toCentavos } from "@/lib/money";

export const BOOKS = {
  "general-journal": "General Journal",
  "cash-receipts": "Cash Receipts Book",
  "cash-disbursements": "Cash Disbursements Book",
  "sales": "Sales Journal",
  "purchases": "Purchase Journal",
} as const;
export type BookKind = keyof typeof BOOKS;
export const isBook = (k: string): k is BookKind => k in BOOKS;

export type BookEntry = {
  id: string; number: string; date: Date; reference: string | null; memo: string; source: string; party: string | null;
  lines: { accountCode: string; accountName: string; description: string | null; debit: bigint; credit: bigint }[];
};

const CASH_ROLES = ["CASH_ON_HAND", "PETTY_CASH_FUND", "GCASH_WALLET", "MAYA_WALLET"];

export async function book(organizationId: string, kind: BookKind, from: Date, to: Date): Promise<BookEntry[]> {
  const entries = await prisma.journalEntry.findMany({
    where: { organizationId, status: "POSTED", book: "STATUTORY", date: { gte: from, lte: to } },
    include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } } },
    orderBy: [{ date: "asc" }, { number: "asc" }],
  });
  const cash = new Set([
    ...(await prisma.bankAccount.findMany({ where: { organizationId }, select: { glAccountId: true } })).map((b) => b.glAccountId),
    ...(await prisma.account.findMany({ where: { organizationId, OR: [{ systemRole: { in: CASH_ROLES } }, { ifrsGroup: "Cash and cash equivalents", isPostable: true }] }, select: { id: true } })).map((a) => a.id),
  ]);
  const roles = (r: string) => (l: { account: { systemRole: string | null } }) => l.account.systemRole === r;
  const keep = entries.filter((e) => {
    switch (kind) {
      case "general-journal": return true;
      case "cash-receipts": return e.lines.some((l) => cash.has(l.accountId) && toCentavos(l.debit.toString()) > 0n);
      case "cash-disbursements": return e.lines.some((l) => cash.has(l.accountId) && toCentavos(l.credit.toString()) > 0n);
      case "sales": return e.source === "SALES" || e.lines.some(roles("OUTPUT_VAT")) || e.lines.some((l) => roles("AR_CONTROL")(l) && toCentavos(l.debit.toString()) > 0n);
      case "purchases": return e.source === "PURCHASES" || e.source === "PETTY_CASH" || e.lines.some(roles("INPUT_VAT")) || e.lines.some((l) => roles("AP_CONTROL")(l) && toCentavos(l.credit.toString()) > 0n);
    }
  });
  return keep.map((e) => ({
    id: e.id, number: e.number, date: e.date, reference: e.reference, memo: e.memo, source: e.source,
    party: e.lines.find((l) => l.partyId)?.partyId ?? null,
    lines: e.lines.map((l) => ({ accountCode: l.account.code, accountName: l.account.name, description: l.description, debit: toCentavos(l.debit.toString()), credit: toCentavos(l.credit.toString()) })),
  }));
}
