// Suggests which bank statement lines clear which book (GL) cash lines. Pure logic, no database.
//
// Amounts are signed centavos from the bank's point of view of the company's money:
//   bank line  +  = deposit / credit memo,   -  = withdrawal / debit memo
//   book line  +  = debit to cash (receipt), -  = credit to cash (payment)
// so a match always has equal signed totals.

export type BankItem = { id: string; date: Date; amount: bigint; checkNo?: string | null; reference?: string | null; description?: string | null };
export type BookItem = { id: string; date: Date; amount: bigint; checkNo?: string | null; reference?: string | null; text?: string | null };

export type Confidence = "high" | "medium" | "low";
export type Suggestion = { bankIds: string[]; bookIds: string[]; amount: bigint; confidence: Confidence; reason: string };

const DAY = 86_400_000;
const days = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / DAY);

/** "000123", "Chk #123", "123" all mean check 123. */
export function normCheck(v?: string | null): string | null {
  const d = String(v ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return d || null;
}

function tokens(v?: string | null): string[] {
  return String(v ?? "").toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 4 && /\d/.test(t));
}

function score(bank: BankItem, book: BookItem): { score: number; reason: string } | null {
  if (bank.amount !== book.amount) return null;
  const lag = days(bank.date, book.date); // bank date minus book date
  const bankCheck = normCheck(bank.checkNo);
  const bookCheck = normCheck(book.checkNo);
  if (bankCheck && bookCheck) {
    if (bankCheck !== bookCheck) return null;
    if (lag < -7) return null; // a check cannot clear a week before it was written
    return { score: 1000 - Math.min(Math.abs(lag), 180), reason: `Check no. ${bankCheck} and amount match` };
  }
  // Withdrawals (checks, transfers) can take months to clear; deposits usually a few days.
  const maxLag = bank.amount < 0n ? 120 : 31;
  if (lag < -5 || lag > maxLag) return null;
  const bankTok = new Set([...tokens(bank.reference), ...tokens(bank.description)]);
  const refHit = [...tokens(book.reference), ...tokens(book.text)].some((t) => bankTok.has(t));
  const s = (refHit ? 300 : 0) + 100 - Math.min(Math.abs(lag), 100);
  const when = lag === 0 ? "same date" : `${Math.abs(lag)} day${Math.abs(lag) === 1 ? "" : "s"} apart`;
  return { score: s, reason: refHit ? `Amount and reference match, ${when}` : `Amount matches, ${when}` };
}

export function suggestMatches(bank: BankItem[], book: BookItem[]): Suggestion[] {
  const pairs: { b: BankItem; k: BookItem; score: number; reason: string }[] = [];
  for (const b of bank) for (const k of book) {
    const s = score(b, k);
    if (s) pairs.push({ b, k, ...s });
  }
  // Greedy: best-scoring pairs first, each line used once.
  pairs.sort((x, y) => y.score - x.score || x.b.date.getTime() - y.b.date.getTime());
  const usedBank = new Set<string>(), usedBook = new Set<string>();
  const out: Suggestion[] = [];
  for (const p of pairs) {
    if (usedBank.has(p.b.id) || usedBook.has(p.k.id)) continue;
    usedBank.add(p.b.id); usedBook.add(p.k.id);
    // Ambiguous when another unused line of the same amount could also fit.
    const rivals = pairs.filter((q) => q !== p && q.score === p.score && ((q.b.id === p.b.id && !usedBook.has(q.k.id)) || (q.k.id === p.k.id && !usedBank.has(q.b.id)))).length;
    const confidence: Confidence = p.score >= 1000 - 180 || p.score >= 300 + 97 ? "high" : p.score >= 300 || (p.score >= 93 && !rivals) ? "medium" : "low";
    out.push({ bankIds: [p.b.id], bookIds: [p.k.id], amount: p.b.amount, confidence, reason: p.reason + (rivals ? " (other lines have the same amount: check before clearing)" : "") });
  }

  // One bank deposit that covers several receipts recorded on the same day (a batched deposit).
  for (const b of bank) {
    if (usedBank.has(b.id) || b.amount <= 0n) continue;
    const byDay = new Map<string, BookItem[]>();
    for (const k of book) {
      if (usedBook.has(k.id) || k.amount <= 0n) continue;
      const lag = days(b.date, k.date);
      if (lag < 0 || lag > 5) continue;
      const key = k.date.toISOString().slice(0, 10);
      byDay.set(key, [...(byDay.get(key) ?? []), k]);
    }
    for (const [day, items] of byDay) {
      if (items.length < 2) continue;
      const total = items.reduce((s, k) => s + k.amount, 0n);
      if (total !== b.amount) continue;
      usedBank.add(b.id);
      items.forEach((k) => usedBook.add(k.id));
      out.push({ bankIds: [b.id], bookIds: items.map((k) => k.id), amount: b.amount, confidence: "medium", reason: `One deposit equals the ${items.length} receipts recorded on ${day}` });
      break;
    }
  }
  return out;
}

/** Best-guess GL account role for a bank-initiated item (bank charge, interest, tax withheld). */
export function guessAdjustment(description: string, amount: bigint): { role: string | null; code: string | null; label: string } {
  const d = description.toUpperCase();
  if (/(W\/?TAX|WHT|WITHHOLDING|FINAL TAX|TAX W)/.test(d)) return { role: null, code: "7540", label: "Final tax on interest" };
  if (/INTEREST|INT\.? ?(EARNED|CR|INCOME)/.test(d) && amount > 0n) return { role: null, code: "7010", label: "Interest income" };
  if (/(RETURNED|DAIF|DAUD|BOUNCED|RTN CHK|RETURN CHECK)/.test(d) && amount < 0n) return { role: "AR_CONTROL", code: null, label: "Returned check: charge back to the customer" };
  if (/(CHARGE|FEE|SVC|SERVICE C|COMMISSION|\bSC\b|PENALTY|DST|STAMP)/.test(d) && amount < 0n) return { role: "BANK_CHARGES", code: null, label: "Bank charges" };
  return { role: null, code: null, label: "" };
}
