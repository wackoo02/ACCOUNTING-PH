"use client";
import { useActionState, useMemo, useState } from "react";
import { acceptSuggestions, manualMatch } from "../../bank-actions";
import { Errors } from "@/components/Errors";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

export type WBank = { id: string; date: string; description: string; reference: string | null; checkNo: string | null; amount: string; suggestedAccountId: string | null; suggestedLabel: string };
export type WBook = { id: string; date: string; number: string; memo: string; payee: string | null; checkNo: string | null; amount: string; entryId: string };
export type WSugg = { key: string; bankIds: string[]; bookIds: string[]; confidence: string; reason: string };
type Acct = { id: string; code: string; name: string };

const c = (s: string) => Math.round(Number(s) * 100);
const money = (n: number) => (n < 0 ? `(${(-n / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 })})` : (n / 100).toLocaleString("en-PH", { minimumFractionDigits: 2 }));

export function Suggestions({ bankAccountId, suggestions, bank, book }: { bankAccountId: string; suggestions: WSugg[]; bank: WBank[]; book: WBook[] }) {
  const [s, a, p] = useActionState(acceptSuggestions, undefined);
  const bk = new Map(bank.map((b) => [b.id, b])), bo = new Map(book.map((b) => [b.id, b]));
  if (!suggestions.length) return <>{s?.message && <div className="notice">{s.message}</div>}<p className="muted">No suggested matches. Match manually below, or upload a newer statement.</p></>;
  return (
    <form action={a}>
      <Errors errors={s?.errors} />{s?.message && <div className="notice">{s.message}</div>}
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <div className="table-wrap"><table>
        <thead><tr><th className="check" /><th>Bank statement</th><th className="num">Bank amount</th><th>Your books</th><th className="num">Book amount</th><th>Why</th></tr></thead>
        <tbody>
          {suggestions.map((g) => (
            <tr key={g.key}>
              <td className="check"><input type="checkbox" name="s" value={`${g.bankIds.join(",")}|${g.bookIds.join(",")}`} defaultChecked={g.confidence !== "low"} aria-label="Clear this match" /></td>
              <td>{g.bankIds.map((id) => { const b = bk.get(id)!; return <div key={id}>{b.date} · {b.description}{b.checkNo ? ` · chk ${b.checkNo}` : ""}{b.reference ? ` · ${b.reference}` : ""}</div>; })}</td>
              <td className="num">{g.bankIds.map((id) => <div key={id}>{money(c(bk.get(id)!.amount))}</div>)}</td>
              <td>{g.bookIds.map((id) => { const b = bo.get(id)!; return <div key={id}>{b.date} · <a href={`/journals/${b.entryId}`}>{b.number}</a> {b.payee ? `${b.payee}: ` : ""}{b.memo}{b.checkNo ? ` · chk ${b.checkNo}` : ""}</div>; })}</td>
              <td className="num">{g.bookIds.map((id) => <div key={id}>{money(c(bo.get(id)!.amount))}</div>)}</td>
              <td><span className={`badge ${g.confidence}`}>{g.confidence}</span> <span className="muted">{g.reason}</span></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <p style={{ marginTop: 8 }}><button disabled={p}>Clear ticked matches</button> <span className="muted">High and medium matches are ticked for you. Untick anything that is not right.</span></p>
    </form>
  );
}

export function Manual({ bankAccountId, bank, book, accounts, canPost }: { bankAccountId: string; bank: WBank[]; book: WBook[]; accounts: Acct[]; canPost: boolean }) {
  const [s, a, p] = useActionState(manualMatch, undefined);
  const [selBank, setSelBank] = useState<Set<string>>(new Set());
  const accountOpts = useMemo(() => idOpts(accounts), [accounts]);
  const [selBook, setSelBook] = useState<Set<string>>(new Set());
  const toggle = (set: Set<string>, id: string, f: (x: Set<string>) => void) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); f(n); };
  const tb = useMemo(() => bank.filter((b) => selBank.has(b.id)).reduce((t, b) => t + c(b.amount), 0), [bank, selBank]);
  const tk = useMemo(() => book.filter((b) => selBook.has(b.id)).reduce((t, b) => t + c(b.amount), 0), [book, selBook]);
  const [note, setNote] = useState("");
  return (
    <form action={a}>
      <Errors errors={s?.errors} />{s?.message && <div className="notice">{s.message}</div>}
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <div className="card" style={{ position: "sticky", top: 0, zIndex: 2 }}>
        <div className="row">
          <div className="stat"><div className="l">Selected bank lines</div><div className="n">{money(tb)}</div></div>
          <div className="stat"><div className="l">Selected book lines</div><div className="n">{money(tk)}</div></div>
          <div className="stat"><div className="l">Difference</div><div className={`n ${tb === tk ? "diff-ok" : "diff-bad"}`}>{money(tb - tk)}</div></div>
          <div style={{ flex: 0 }}><button name="op" value="match" disabled={p || !selBank.size || !selBook.size || tb !== tk}>Match and clear selected</button></div>
        </div>
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 380 }}>
          <h2>On the bank statement, not in your books yet ({bank.length})</h2>
          <div className="table-wrap"><table>
            <thead><tr><th className="check" /><th>Date</th><th>Description</th><th className="num">Amount</th>{canPost && <th>Record in books to</th>}</tr></thead>
            <tbody>
              {bank.map((b) => (
                <tr key={b.id}>
                  <td className="check"><input type="checkbox" name="bank" value={b.id} checked={selBank.has(b.id)} onChange={() => toggle(selBank, b.id, setSelBank)} aria-label="Select bank line" />
                    {selBank.has(b.id) && <input type="hidden" name="adj" value={b.id} />}</td>
                  <td>{b.date}</td><td>{b.description}{b.checkNo ? <div className="muted">chk {b.checkNo}</div> : null}{b.reference ? <div className="muted">{b.reference}</div> : null}</td>
                  <td className="num">{money(c(b.amount))}</td>
                  {canPost && <td><MasterPicker name={`acct_${b.id}`} ariaLabel={`Account for ${b.description}`} placeholder="Type account…" defaultValue={b.suggestedAccountId ?? ""} options={accountOpts} add={{ kind: "accounts" }} style={{ minWidth: 180 }} /></td>}
                </tr>
              ))}
              {bank.length === 0 && <tr><td colSpan={5} className="muted">Everything on the statements is cleared.</td></tr>}
            </tbody>
          </table></div>
          {canPost && <p><button name="op" value="adjust" className="secondary" disabled={p || !selBank.size || selBook.size > 0}>Record selected bank lines in the books</button><br /><span className="muted">For bank charges, interest, tax withheld, returned checks and other items only the bank knows about. Each posts a bank entry and clears it.</span></p>}
        </div>
        <div style={{ minWidth: 380 }}>
          <h2>In your books, not yet on a statement ({book.length})</h2>
          <div className="table-wrap"><table>
            <thead><tr><th className="check" /><th>Date</th><th>Entry</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {book.map((b) => (
                <tr key={b.id}>
                  <td className="check"><input type="checkbox" name="book" value={b.id} checked={selBook.has(b.id)} onChange={() => toggle(selBook, b.id, setSelBook)} aria-label="Select book line" /></td>
                  <td>{b.date}</td><td><a href={`/journals/${b.entryId}`}>{b.number}</a> {b.payee ? `${b.payee}: ` : ""}{b.memo}{b.checkNo ? <div className="muted">chk {b.checkNo}</div> : null}</td>
                  <td className="num">{money(c(b.amount))}</td>
                </tr>
              ))}
              {book.length === 0 && <tr><td colSpan={4} className="muted">Every book entry is cleared.</td></tr>}
            </tbody>
          </table></div>
          {canPost && <div className="row" style={{ marginTop: 8 }}>
            <div style={{ flex: 2 }}><label>Clear selected book lines without a statement line (reason)</label><input name="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Opening balance, or cleared before go-live" /></div>
            <div style={{ flex: 0 }}><button name="op" value="nostatement" className="secondary" disabled={p || !selBook.size || selBank.size > 0 || !note.trim()}>Clear without statement</button></div>
          </div>}
        </div>
      </div>
    </form>
  );
}
