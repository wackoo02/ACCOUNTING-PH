// Bank reconciliation: statement template and upload, suggested matches, clearing, book
// adjustments for bank-initiated items, and the reconciliation report.
import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { LedgerError, asDay, audit, recordJournalTx, voidOrReverseTx } from "../ledger/service";
import { guessAdjustment, normCheck, suggestMatches, type BankItem, type BookItem, type Suggestion } from "./match";

type Tx = Prisma.TransactionClient;
const cents = (d: Prisma.Decimal | string | null | undefined) => toCentavos(d?.toString() ?? "0");
const dec = (c: bigint) => new Prisma.Decimal(fromCentavos(c));
const fmt = (c: bigint) => (Number(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 });
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ---------- Excel template ----------

const COLS = [
  { key: "date", header: "Date", required: true, width: 14, help: "Transaction date. YYYY-MM-DD or MM/DD/YYYY, or an Excel date.", example: "2026-11-03" },
  { key: "description", header: "Description", required: true, width: 40, help: "As printed on the statement, e.g. CHECK ENCASHMENT, DEPOSIT, SERVICE CHARGE.", example: "CHECK NO. 000123" },
  { key: "reference", header: "Reference", width: 18, help: "Bank reference / transaction code, if any.", example: "TRX88213" },
  { key: "checkNo", header: "Check No.", width: 12, help: "For cleared checks. Used to match against your check vouchers.", example: "000123" },
  { key: "withdrawal", header: "Withdrawal (Debit)", width: 18, help: "Money out of the account. Positive number.", example: "64200.00" },
  { key: "deposit", header: "Deposit (Credit)", width: 18, help: "Money into the account. Positive number.", example: "" },
  { key: "balance", header: "Running Balance", width: 18, help: "Optional. If given, every row is checked against it.", example: "1265800.00" },
] as const;

export async function statementTemplate(bankName?: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "PH Accounting";
  const ws = wb.addWorksheet("Statement", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLS.map((c) => ({ header: "required" in c && c.required ? `${c.header} *` : c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F2540" } };
  ws.getColumn(1).numFmt = "yyyy-mm-dd";
  for (const k of [5, 6, 7]) ws.getColumn(k).numFmt = "#,##0.00";
  const info = wb.addWorksheet("Instructions");
  info.columns = [{ header: "Column", key: "c", width: 22 }, { header: "Required", key: "r", width: 10 }, { header: "What to enter", key: "h", width: 70 }, { header: "Example", key: "e", width: 22 }];
  info.getRow(1).font = { bold: true };
  for (const c of COLS) info.addRow({ c: c.header, r: "required" in c && c.required ? "Yes" : "", h: c.help, e: c.example });
  info.addRow({});
  for (const t of [
    `How to use${bankName ? ` (${bankName})` : ""}: copy the lines from your bank statement or online banking export into the Statement sheet, one row per transaction, oldest first.`,
    "Put each amount in Withdrawal or Deposit, not both. Bank charges and debit memos are withdrawals; interest and credit memos are deposits.",
    "When uploading, enter the statement's beginning and ending balance. The upload is rejected if beginning balance + deposits - withdrawals does not equal the ending balance.",
    "Lines already uploaded before (same date, amount, description and reference) are skipped, so overlapping statements are safe.",
  ]) info.addRow({ c: t });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

type ParsedLine = { date: Date; description: string; reference: string | null; checkNo: string | null; amount: bigint; balance: bigint | null; row: number };

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) return (v as { result: unknown }).result;
    if ("richText" in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
    if ("text" in v) return (v as { text: string }).text;
  }
  return v;
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : asDay(v);
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000);
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // MM/DD/YYYY, the usual PH bank format
  if (m) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ,]+(\d{4})$/);
  if (m) {
    const mo = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase());
    if (mo >= 0) return valid(+m[3], mo + 1, +m[1]);
  }
  return null;
}
function valid(y: number, mo: number, d: number) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
}

function parseAmount(v: unknown): bigint | null {
  if (v === null || v === undefined || String(v).trim() === "") return 0n;
  if (typeof v === "number") return BigInt(Math.round(v * 100));
  let s = String(v).trim().replace(/[₱$,\s]|PHP|USD/gi, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith("-")) { neg = true; s = s.slice(0, -1); }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Math.round(Number(s) * 100);
    return BigInt(neg ? -n : n);
  }
  return null;
}

export async function parseStatement(buf: ArrayBuffer): Promise<{ lines: ParsedLine[]; errors: string[] }> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch { return { lines: [], errors: ["The file could not be read. Please upload the .xlsx template."] }; }
  const ws = wb.getWorksheet("Statement") ?? wb.worksheets[0];
  if (!ws) return { lines: [], errors: ["The workbook has no sheets"] };
  const norm = (s: string) => s.replace(/\*/g, "").trim().toLowerCase();
  const col: Record<string, number> = {};
  const aliases: Record<string, string[]> = {
    date: ["date", "transaction date", "value date", "posting date"], description: ["description", "particulars", "details", "narrative", "transaction"],
    reference: ["reference", "ref", "ref no.", "reference no."], checkNo: ["check no.", "check no", "check number", "cheque no.", "chk no."],
    withdrawal: ["withdrawal (debit)", "withdrawal", "withdrawals", "debit", "debits"], deposit: ["deposit (credit)", "deposit", "deposits", "credit", "credits"],
    balance: ["running balance", "balance"], amount: ["amount"],
  };
  ws.getRow(1).eachCell((cell, n) => {
    const h = norm(String(cellValue(cell.value) ?? ""));
    for (const [k, names] of Object.entries(aliases)) if (names.includes(h) && !(k in col)) col[k] = n;
  });
  const missing = [!col.date && "Date", !col.description && "Description", !(col.withdrawal || col.deposit || col.amount) && "Withdrawal / Deposit"].filter(Boolean);
  if (missing.length) return { lines: [], errors: [`Missing column(s): ${missing.join(", ")}. Please use the downloaded template.`] };

  const lines: ParsedLine[] = [];
  const errors: string[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = (k: string) => (col[k] ? cellValue(row.getCell(col[k]).value) : null);
    const raw = ["date", "description", "withdrawal", "deposit", "amount"].map(get);
    if (raw.every((v) => v === null || v === undefined || String(v).trim() === "")) return;
    const e: string[] = [];
    const date = parseDate(get("date"));
    if (!date) e.push("enter a valid date (YYYY-MM-DD or MM/DD/YYYY)");
    const description = String(get("description") ?? "").trim();
    if (!description) e.push("enter the description");
    const w = parseAmount(get("withdrawal")), dpt = parseAmount(get("deposit")), amt = parseAmount(get("amount"));
    if (w === null || dpt === null || amt === null) e.push("amounts must be numbers");
    let amount = 0n;
    if (w !== null && dpt !== null && amt !== null) {
      if (w < 0n || dpt < 0n) e.push("enter withdrawals and deposits as positive numbers");
      if (w > 0n && dpt > 0n) e.push("enter either a withdrawal or a deposit, not both");
      amount = dpt - w + (w === 0n && dpt === 0n ? amt : 0n);
      if (amount === 0n) e.push("enter an amount");
    }
    const bal = col.balance ? parseAmount(get("balance")) : null;
    const balRaw = get("balance");
    if (col.balance && bal === null) e.push("running balance must be a number");
    if (e.length) errors.push(`Row ${n}: ${e.join("; ")}`);
    else lines.push({
      date: date!, description, amount, row: n,
      reference: String(get("reference") ?? "").trim() || null, checkNo: String(get("checkNo") ?? "").trim() || null,
      balance: balRaw === null || balRaw === undefined || String(balRaw).trim() === "" ? null : bal,
    });
  });
  if (!lines.length && !errors.length) errors.push("No transactions found in the Statement sheet");
  return { lines, errors };
}

/**
 * Upload a statement. Checks opening + lines = closing (and each running balance if given),
 * skips lines already uploaded, then stores the new lines for matching.
 */
export async function importStatement(input: { organizationId: string; userId: string; bankAccountId: string; buf: ArrayBuffer; fileName?: string; openingBalance?: string | null; closingBalance?: string | null }) {
  const bank = await prisma.bankAccount.findFirst({ where: { id: input.bankAccountId, organizationId: input.organizationId } });
  if (!bank) throw new LedgerError(["Choose the bank account this statement is for"]);
  const { lines, errors } = await parseStatement(input.buf);
  if (errors.length) throw new LedgerError(errors);
  const sorted = [...lines].sort((a, b) => a.date.getTime() - b.date.getTime() || a.row - b.row);
  const total = lines.reduce((s, l) => s + l.amount, 0n);

  const prev = await prisma.bankStatement.findFirst({ where: { organizationId: input.organizationId, bankAccountId: bank.id }, orderBy: { periodTo: "desc" } });
  const parse = (v: string | null | undefined, label: string) => {
    if (!v?.trim()) return null;
    try { return toCentavos(v.replace(/,/g, "")); } catch { throw new LedgerError([`${label} must be a number`]); }
  };
  const first = lines[0]; // file order: the first row's running balance tells us the opening balance
  let opening = parse(input.openingBalance, "Beginning balance");
  let closing = parse(input.closingBalance, "Ending balance");
  if (opening === null && first.balance !== null) opening = first.balance - first.amount;
  if (opening === null && prev) opening = cents(prev.closingBalance);
  if (closing === null && lines[lines.length - 1].balance !== null) closing = lines[lines.length - 1].balance;
  if (opening === null) throw new LedgerError(["Enter the statement's beginning balance"]);
  if (closing === null) closing = opening + total;
  if (opening + total !== closing) {
    throw new LedgerError([`The statement does not add up: beginning ${fmt(opening)} + deposits/withdrawals ${fmt(total)} = ${fmt(opening + total)}, but the ending balance is ${fmt(closing)}. Check for missing or duplicated rows.`]);
  }
  let run = opening;
  const balErrs: string[] = [];
  for (const l of lines) {
    run += l.amount;
    if (l.balance !== null && l.balance !== run) balErrs.push(`Row ${l.row}: running balance should be ${fmt(run)} but the file says ${fmt(l.balance)}`);
  }
  if (balErrs.length) throw new LedgerError(balErrs.slice(0, 20));
  if (prev && cents(prev.closingBalance) !== opening && sorted[0].date > prev.periodTo) {
    throw new LedgerError([`The beginning balance ${fmt(opening)} does not equal the ending balance of the previous statement (${fmt(cents(prev.closingBalance))} on ${ymd(prev.periodTo)}). Is a statement missing?`]);
  }

  // Same date + amount + description + reference + check no. (+ occurrence number) = same line.
  const seen = new Map<string, number>();
  const withFp = sorted.map((l) => {
    const key = [ymd(l.date), l.amount.toString(), l.description.toUpperCase().replace(/\s+/g, " "), l.reference ?? "", normCheck(l.checkNo) ?? ""].join("|");
    const k = (seen.get(key) ?? 0) + 1;
    seen.set(key, k);
    return { ...l, fingerprint: `${key}|${k}` };
  });
  const existing = new Set((await prisma.bankStatementLine.findMany({ where: { bankAccountId: bank.id, fingerprint: { in: withFp.map((l) => l.fingerprint) } }, select: { fingerprint: true } })).map((x) => x.fingerprint));
  const fresh = withFp.filter((l) => !existing.has(l.fingerprint));
  if (!fresh.length) throw new LedgerError(["Every line in this file was already uploaded"]);

  return prisma.$transaction(async (tx) => {
    const st = await tx.bankStatement.create({ data: {
      organizationId: input.organizationId, bankAccountId: bank.id, periodFrom: sorted[0].date, periodTo: sorted[sorted.length - 1].date,
      openingBalance: dec(opening!), closingBalance: dec(closing!), fileName: input.fileName ?? null, uploadedById: input.userId,
      lines: { create: fresh.map((l, i) => ({
        organizationId: input.organizationId, bankAccountId: bank.id, lineNo: i + 1, date: l.date, description: l.description, reference: l.reference,
        checkNo: l.checkNo, amount: dec(l.amount), runningBalance: l.balance === null ? null : dec(l.balance), fingerprint: l.fingerprint,
      })) },
    } });
    await audit(tx, input.organizationId, input.userId, "bank.statement_upload", st.id, { bank: bank.code, lines: fresh.length, skipped: lines.length - fresh.length, closing: fromCentavos(closing!) }, null, null, "bank");
    return { statement: st, imported: fresh.length, skipped: lines.length - fresh.length };
  }, { timeout: 60_000 });
}

export async function deleteStatement(organizationId: string, userId: string, statementId: string) {
  return prisma.$transaction(async (tx) => {
    const st = await tx.bankStatement.findFirst({ where: { id: statementId, organizationId }, include: { lines: true } });
    if (!st) throw new LedgerError(["Statement not found"]);
    if (st.status === "RECONCILED") throw new LedgerError(["A finalized reconciliation cannot be deleted"]);
    if (st.lines.some((l) => l.matchId)) throw new LedgerError(["Undo the matches on this statement's lines first"]);
    await tx.bankStatement.delete({ where: { id: st.id } });
    await audit(tx, organizationId, userId, "bank.statement_delete", st.id, { lines: st.lines.length }, null, null, "bank");
  });
}

// ---------- Matching ----------

async function bankAcct(tx: Tx | typeof prisma, organizationId: string, id: string) {
  const b = await tx.bankAccount.findFirst({ where: { id, organizationId }, include: { glAccount: true } });
  if (!b) throw new LedgerError(["Bank account not found"]);
  return b;
}

const postedCash = (organizationId: string, glAccountId: string) => ({
  organizationId, accountId: glAccountId, journalEntry: { status: "POSTED" as const, book: "STATUTORY" as const },
  OR: [{ fxDebit: { not: 0 } }, { fxCredit: { not: 0 } }],
});

export type BookRow = BookItem & { entryId: string; number: string; memo: string; source: string; payee: string | null };
export type BankRow = BankItem & { statementId: string; description: string; suggestion: ReturnType<typeof guessAdjustment> };

/** Everything the matching screen needs: open bank lines, uncleared book lines and suggestions. */
export async function workbench(organizationId: string, bankAccountId: string) {
  const bank = await bankAcct(prisma, organizationId, bankAccountId);
  const [sl, gl] = await Promise.all([
    prisma.bankStatementLine.findMany({ where: { organizationId, bankAccountId, matchId: null }, orderBy: [{ date: "asc" }, { lineNo: "asc" }] }),
    prisma.journalLine.findMany({ where: { ...postedCash(organizationId, bank.glAccountId), clearedAt: null }, include: { journalEntry: true }, orderBy: { journalEntry: { date: "asc" } } }),
  ]);
  const cashIds = gl.filter((l) => l.journalEntry.source === "BANK" && l.journalEntry.sourceId).map((l) => l.journalEntry.sourceId!);
  const vouchers = new Map((await prisma.cashTransaction.findMany({ where: { id: { in: cashIds } } })).map((v) => [v.id, v]));
  const bankRows: BankRow[] = sl.map((l) => ({
    id: l.id, statementId: l.statementId, date: l.date, amount: cents(l.amount), checkNo: l.checkNo, reference: l.reference, description: l.description,
    suggestion: guessAdjustment(l.description, cents(l.amount)),
  }));
  const bookRows: BookRow[] = gl.map((l) => {
    const v = l.journalEntry.sourceId ? vouchers.get(l.journalEntry.sourceId) : undefined;
    return {
      id: l.id, entryId: l.journalEntryId, date: l.journalEntry.date, amount: cents(l.fxDebit) - cents(l.fxCredit),
      checkNo: v?.method === "CHECK" ? v.checkNo : null, reference: [l.journalEntry.reference, v?.number].filter(Boolean).join(" "),
      text: `${l.journalEntry.number} ${l.journalEntry.memo} ${l.description ?? ""}`, number: v?.number ?? l.journalEntry.number,
      memo: v ? v.memo : l.description && l.description !== l.journalEntry.memo ? `${l.journalEntry.memo} · ${l.description}` : l.journalEntry.memo,
      source: l.journalEntry.source, payee: v?.payee ?? null,
    };
  });
  const suggestions: Suggestion[] = suggestMatches(bankRows, bookRows);
  const recent = await prisma.bankMatch.findMany({ where: { organizationId, bankAccountId }, orderBy: { createdAt: "desc" }, take: 30, include: { statementLines: true } });
  const recentBook = await prisma.journalLine.findMany({ where: { clearingRef: { in: recent.map((m) => m.id) } }, include: { journalEntry: true } });
  return { bank, bankRows, bookRows, suggestions, recent: recent.map((m) => ({ ...m, book: recentBook.filter((b) => b.clearingRef === m.id) })) };
}

async function assertEditable(tx: Tx, statementIds: string[]) {
  const locked = await tx.bankStatement.findFirst({ where: { id: { in: statementIds }, status: "RECONCILED" } });
  if (locked) throw new LedgerError([`The statement ending ${ymd(locked.periodTo)} is already finalized. Reopen it first.`]);
}

/** Clear groups of bank lines against book lines. Each group must have equal totals. */
export async function confirmMatches(organizationId: string, userId: string, bankAccountId: string, groups: { bankIds: string[]; bookIds: string[] }[], method: "SUGGESTED" | "MANUAL") {
  return prisma.$transaction(async (tx) => {
    const bank = await bankAcct(tx, organizationId, bankAccountId);
    let n = 0;
    for (const g of groups) {
      if (!g.bankIds.length || !g.bookIds.length) throw new LedgerError(["Select at least one bank line and one book line"]);
      const sl = await tx.bankStatementLine.findMany({ where: { id: { in: g.bankIds }, organizationId, bankAccountId, matchId: null } });
      const gl = await tx.journalLine.findMany({ where: { id: { in: g.bookIds }, ...postedCash(organizationId, bank.glAccountId), clearedAt: null } });
      if (sl.length !== g.bankIds.length || gl.length !== g.bookIds.length) throw new LedgerError(["Some lines were already cleared or changed. Refresh and try again."]);
      const bankSum = sl.reduce((s, l) => s + cents(l.amount), 0n);
      const bookSum = gl.reduce((s, l) => s + cents(l.fxDebit) - cents(l.fxCredit), 0n);
      if (bankSum !== bookSum) throw new LedgerError([`The selected bank lines total ${fmt(bankSum)} but the book lines total ${fmt(bookSum)}. They must be equal to clear.`]);
      await assertEditable(tx, [...new Set(sl.map((l) => l.statementId))]);
      const m = await tx.bankMatch.create({ data: { organizationId, bankAccountId, method, createdById: userId } });
      const clearedAt = sl.reduce((d, l) => (l.date > d ? l.date : d), sl[0].date);
      await tx.bankStatementLine.updateMany({ where: { id: { in: g.bankIds } }, data: { matchId: m.id } });
      await tx.journalLine.updateMany({ where: { id: { in: g.bookIds } }, data: { clearedAt, clearingRef: m.id } });
      await audit(tx, organizationId, userId, "bank.match", m.id, { method, bank: g.bankIds.length, book: g.bookIds.length, amount: fromCentavos(bankSum) }, null, null, "bank");
      n++;
    }
    return n;
  });
}

/** Clear book lines that will never appear on a statement (opening balance, items cleared before go-live). */
export async function clearWithoutStatement(organizationId: string, userId: string, bankAccountId: string, bookIds: string[], note: string) {
  if (!note.trim()) throw new LedgerError(["Give a reason, e.g. \"Opening balance\" or \"Cleared in the October reconciliation before go-live\""]);
  return prisma.$transaction(async (tx) => {
    const bank = await bankAcct(tx, organizationId, bankAccountId);
    const gl = await tx.journalLine.findMany({ where: { id: { in: bookIds }, ...postedCash(organizationId, bank.glAccountId), clearedAt: null }, include: { journalEntry: true } });
    if (!gl.length || gl.length !== bookIds.length) throw new LedgerError(["Select book lines that are not yet cleared"]);
    const m = await tx.bankMatch.create({ data: { organizationId, bankAccountId, method: "NO_STATEMENT", note: note.trim(), createdById: userId } });
    for (const l of gl) await tx.journalLine.update({ where: { id: l.id }, data: { clearedAt: l.journalEntry.date, clearingRef: m.id } });
    await audit(tx, organizationId, userId, "bank.clear_no_statement", m.id, { lines: gl.length, note: note.trim() }, null, null, "bank");
  });
}

/** Undo a match. A bank adjustment entry created from the match is reversed too. */
export async function unmatch(organizationId: string, userId: string, matchId: string) {
  return prisma.$transaction(async (tx) => {
    const m = await tx.bankMatch.findFirst({ where: { id: matchId, organizationId }, include: { statementLines: true } });
    if (!m) throw new LedgerError(["Match not found"]);
    await assertEditable(tx, [...new Set(m.statementLines.map((l) => l.statementId))]);
    if (m.note?.startsWith("Voided")) throw new LedgerError(["This clears a voided voucher against its reversal and cannot be undone"]);
    const gl = await tx.journalLine.findMany({ where: { clearingRef: m.id }, include: { journalEntry: true } });
    await tx.bankStatementLine.updateMany({ where: { matchId: m.id }, data: { matchId: null } });
    await tx.journalLine.updateMany({ where: { clearingRef: m.id }, data: { clearedAt: null, clearingRef: null } });
    if (m.method === "ADJUSTMENT") {
      for (const e of new Map(gl.map((l) => [l.journalEntryId, l.journalEntry])).values()) {
        if (e.source === "BANK" && e.status === "POSTED") await voidOrReverseTx(tx, organizationId, userId, e.id, e.date, true);
      }
      // The reversal's cash line and the original's offset each other.
      const revLines = await tx.journalLine.findMany({ where: { accountId: gl[0]?.accountId, journalEntry: { reversalOfId: { in: gl.map((l) => l.journalEntryId) } } }, include: { journalEntry: true } });
      if (revLines.length) {
        const off = await tx.bankMatch.create({ data: { organizationId, bankAccountId: m.bankAccountId, method: "NO_STATEMENT", note: "Voided bank adjustment: reversal offsets the original", createdById: userId } });
        for (const l of [...gl, ...revLines]) await tx.journalLine.update({ where: { id: l.id }, data: { clearedAt: l.journalEntry.date, clearingRef: off.id } });
      }
    }
    await tx.bankMatch.delete({ where: { id: m.id } });
    await audit(tx, organizationId, userId, "bank.unmatch", m.id, { method: m.method }, null, null, "bank");
  });
}

/**
 * Record bank-initiated items (bank charges, interest, tax withheld, returned checks) in the books.
 * Each statement line gets its own posted BANK entry, which is cleared against that line at once.
 */
export async function postAdjustments(organizationId: string, userId: string, bankAccountId: string, items: { bankLineId: string; accountId: string; memo?: string }[]) {
  return prisma.$transaction(async (tx) => {
    const bank = await bankAcct(tx, organizationId, bankAccountId);
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const rate = bank.currencyCode === org.baseCurrency ? "1" : (await tx.currency.findFirst({ where: { organizationId, code: bank.currencyCode } }))?.rateToBase.toString();
    if (!rate) throw new LedgerError([`Add ${bank.currencyCode} to the Currencies list first`]);
    const out = [];
    for (const it of items) {
      const sl = await tx.bankStatementLine.findFirst({ where: { id: it.bankLineId, organizationId, bankAccountId, matchId: null } });
      if (!sl) throw new LedgerError(["A selected bank line was already cleared. Refresh and try again."]);
      await assertEditable(tx, [sl.statementId]);
      if (!it.accountId) throw new LedgerError([`Choose the account for "${sl.description}"`]);
      const amt = cents(sl.amount);
      const abs = fromCentavos(amt < 0n ? -amt : amt);
      const cur = { currencyCode: bank.currencyCode, fxRate: rate };
      const memo = it.memo?.trim() || `${sl.description}${sl.reference ? ` (${sl.reference})` : ""} per bank statement ${ymd(sl.date)}`;
      const e = await recordJournalTx(tx, {
        organizationId, userId, date: sl.date, memo, reference: sl.reference ?? `Bank ${ymd(sl.date)}`, source: "BANK", sourceId: sl.id, action: "post",
        lines: amt > 0n
          ? [{ accountId: bank.glAccountId, debit: abs, ...cur }, { accountId: it.accountId, credit: abs, ...cur }]
          : [{ accountId: it.accountId, debit: abs, ...cur }, { accountId: bank.glAccountId, credit: abs, ...cur }],
      });
      const cashLine = await tx.journalLine.findFirstOrThrow({ where: { journalEntryId: e.id, accountId: bank.glAccountId } });
      const m = await tx.bankMatch.create({ data: { organizationId, bankAccountId, method: "ADJUSTMENT", createdById: userId } });
      await tx.bankStatementLine.update({ where: { id: sl.id }, data: { matchId: m.id } });
      await tx.journalLine.update({ where: { id: cashLine.id }, data: { clearedAt: sl.date, clearingRef: m.id } });
      out.push(e);
    }
    return out;
  });
}

/** Account suggested for a bank-initiated item, from its description. */
export async function suggestedAccountId(organizationId: string, s: ReturnType<typeof guessAdjustment>) {
  if (s.role) return (await prisma.account.findUnique({ where: { organizationId_systemRole: { organizationId, systemRole: s.role } } }))?.id ?? null;
  if (s.code) return (await prisma.account.findUnique({ where: { organizationId_code: { organizationId, code: s.code } } }))?.id ?? null;
  return null;
}

// ---------- Reconciliation report ----------

export type ReconItem = { id: string; date: Date; number: string; memo: string; checkNo: string | null; amount: bigint; daysOutstanding: number };

/**
 * Bank reconciliation as of the statement's end date (amounts in the bank account's currency):
 *   Balance per bank + deposits in transit - outstanding checks = adjusted bank balance
 *   Balance per books + bank credits not yet booked - bank debits not yet booked = adjusted book balance
 */
export async function reconciliation(organizationId: string, statementId: string) {
  const st = await prisma.bankStatement.findFirst({ where: { id: statementId, organizationId } });
  if (!st) throw new LedgerError(["Statement not found"]);
  const bank = await bankAcct(prisma, organizationId, st.bankAccountId);
  const asOf = st.periodTo;
  const base = postedCash(organizationId, bank.glAccountId);
  const [agg, open, laterBooked, bankOpen] = await Promise.all([
    prisma.journalLine.aggregate({ where: { ...base, journalEntry: { ...base.journalEntry, date: { lte: asOf } } }, _sum: { fxDebit: true, fxCredit: true } }),
    prisma.journalLine.findMany({ where: { ...base, journalEntry: { ...base.journalEntry, date: { lte: asOf } }, OR: [{ clearedAt: null }, { clearedAt: { gt: asOf } }] }, include: { journalEntry: true }, orderBy: { journalEntry: { date: "asc" } } }),
    // Booked after the statement date for bank items already on or before it (e.g. a bank charge recorded later).
    prisma.journalLine.findMany({ where: { ...base, journalEntry: { ...base.journalEntry, date: { gt: asOf } }, clearedAt: { lte: asOf } }, include: { journalEntry: true } }),
    prisma.bankStatementLine.findMany({ where: { organizationId, bankAccountId: bank.id, date: { lte: asOf }, matchId: null }, orderBy: { date: "asc" } }),
  ]);
  const vouchers = new Map((await prisma.cashTransaction.findMany({ where: { id: { in: open.map((l) => l.journalEntry.sourceId).filter(Boolean) as string[] } } })).map((v) => [v.id, v]));
  const age = (d: Date) => Math.round((asOf.getTime() - d.getTime()) / 86_400_000);
  const toItem = (l: (typeof open)[number]): ReconItem => {
    const v = l.journalEntry.sourceId ? vouchers.get(l.journalEntry.sourceId) : undefined;
    return { id: l.id, date: l.journalEntry.date, number: v?.number ?? l.journalEntry.number, memo: v ? (v.payee ? `${v.payee}: ${v.memo}` : v.memo) : l.journalEntry.memo,
      checkNo: v?.method === "CHECK" ? v.checkNo : null, amount: cents(l.fxDebit) - cents(l.fxCredit), daysOutstanding: age(l.journalEntry.date) };
  };
  const items = open.map(toItem);
  const depositsInTransit = items.filter((i) => i.amount > 0n);
  const outstandingChecks = items.filter((i) => i.amount < 0n).map((i) => ({ ...i, amount: -i.amount }));
  const bankItems = bankOpen.map((l) => ({ id: l.id, date: l.date, description: l.description, reference: l.reference, amount: cents(l.amount) }));
  const later = laterBooked.map((l) => ({ id: l.id, date: l.journalEntry.date, number: l.journalEntry.number, memo: l.journalEntry.memo, amount: cents(l.fxDebit) - cents(l.fxCredit) }));

  const sum = (xs: { amount: bigint }[]) => xs.reduce((s, x) => s + x.amount, 0n);
  const perBank = cents(st.closingBalance);
  const perBooks = cents(agg._sum.fxDebit) - cents(agg._sum.fxCredit);
  const dit = sum(depositsInTransit), oc = sum(outstandingChecks);
  const bankCredits = bankItems.filter((i) => i.amount > 0n), bankDebits = bankItems.filter((i) => i.amount < 0n).map((i) => ({ ...i, amount: -i.amount }));
  const adjustedBank = perBank + dit - oc;
  const adjustedBooks = perBooks + sum(bankCredits) - sum(bankDebits) + sum(later);
  return {
    statement: st, bank, asOf, perBank, perBooks, depositsInTransit, outstandingChecks, bankCredits, bankDebits, later,
    totals: { dit, oc, bankCredits: sum(bankCredits), bankDebits: sum(bankDebits), later: sum(later) },
    adjustedBank, adjustedBooks, difference: adjustedBank - adjustedBooks,
  };
}

/** Lock a reconciliation once it balances. Its matches can no longer be undone. */
export async function finalizeStatement(organizationId: string, userId: string, statementId: string) {
  const r = await reconciliation(organizationId, statementId);
  if (r.difference !== 0n) throw new LedgerError([`The reconciliation is off by ${fmt(r.difference < 0n ? -r.difference : r.difference)}. It can be finalized only when the difference is zero.`]);
  if (r.statement.status === "RECONCILED") throw new LedgerError(["Already finalized"]);
  await prisma.$transaction(async (tx) => {
    await tx.bankStatement.update({ where: { id: statementId }, data: { status: "RECONCILED", reconciledById: userId, reconciledAt: new Date() } });
    await audit(tx, organizationId, userId, "bank.reconcile", statementId, {
      bank: r.bank.code, asOf: ymd(r.asOf), perBank: fromCentavos(r.perBank), perBooks: fromCentavos(r.perBooks),
      depositsInTransit: fromCentavos(r.totals.dit), outstandingChecks: fromCentavos(r.totals.oc), unbookedCredits: fromCentavos(r.totals.bankCredits), unbookedDebits: fromCentavos(r.totals.bankDebits),
    }, null, null, "bank");
  });
}

/** Owner/admin: reopen a finalized reconciliation (e.g. to correct a wrong match). */
export async function reopenStatement(organizationId: string, userId: string, statementId: string) {
  return prisma.$transaction(async (tx) => {
    const st = await tx.bankStatement.findFirst({ where: { id: statementId, organizationId } });
    if (!st || st.status !== "RECONCILED") throw new LedgerError(["This reconciliation is not finalized"]);
    const later = await tx.bankStatement.findFirst({ where: { organizationId, bankAccountId: st.bankAccountId, status: "RECONCILED", periodTo: { gt: st.periodTo } } });
    if (later) throw new LedgerError([`Reopen the later reconciliation ending ${ymd(later.periodTo)} first`]);
    await tx.bankStatement.update({ where: { id: st.id }, data: { status: "OPEN", reconciledById: null, reconciledAt: null } });
    await audit(tx, organizationId, userId, "bank.reopen", st.id, null, null, null, "bank");
  });
}
