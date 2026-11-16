import Link from "next/link";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { suggestedAccountId, workbench } from "@/lib/bank/recon";
import { ActionForm } from "@/components/ActionForm";
import { undoMatch } from "../../bank-actions";
import { Manual, Suggestions, type WBank, type WBook } from "./Workbench";

const s = (c: bigint) => (Number(c) / 100).toFixed(2);
const METHOD: Record<string, string> = { SUGGESTED: "Suggested", MANUAL: "Manual", ADJUSTMENT: "Booked from statement", NO_STATEMENT: "No statement line" };

export default async function Reconcile({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const banks = await prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id, kind: { in: ["CURRENT", "SAVINGS", "EWALLET"] } }, orderBy: { code: "asc" } });
  if (!banks.length) return <><h1>Match and Clear</h1><div className="notice">Add a bank account first under <Link href="/masters/banks">Master Lists → Bank and Cash Accounts</Link>.</div></>;
  if (!sp.account || !banks.some((b) => b.id === sp.account)) redirect(`/bank/reconcile?account=${banks[0].id}`);
  const w = await workbench(ctx.org.id, sp.account);
  const accounts = await prisma.account.findMany({ where: { organizationId: ctx.org.id, isPostable: true, isActive: true, id: { not: w.bank.glAccountId } }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } });
  const sugIds = new Map<string, string | null>();
  for (const b of w.bankRows) sugIds.set(b.id, await suggestedAccountId(ctx.org.id, b.suggestion));
  const bank: WBank[] = w.bankRows.map((b) => ({ id: b.id, date: fmtDate(b.date), description: b.description, reference: b.reference ?? null, checkNo: b.checkNo ?? null, amount: s(b.amount), suggestedAccountId: sugIds.get(b.id) ?? null, suggestedLabel: b.suggestion.label }));
  const book: WBook[] = w.bookRows.map((b) => ({ id: b.id, date: fmtDate(b.date), number: b.number, memo: b.memo, payee: b.payee, checkNo: b.checkNo ?? null, amount: s(b.amount), entryId: b.entryId }));
  const latest = await prisma.bankStatement.findFirst({ where: { bankAccountId: w.bank.id }, orderBy: { periodTo: "desc" } });
  return (
    <>
      <div className="top"><h1>Match and Clear · {w.bank.code}</h1>
        <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}>
          <form className="row" style={{ gap: 6, flexWrap: "nowrap", minWidth: 320 }}><select name="account" defaultValue={w.bank.id}>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select><button className="secondary">Open</button></form>
          <Link className="btn secondary" href={`/bank/statements?account=${w.bank.id}`}>Upload statement</Link>
          {latest && <Link className="btn" href={`/bank/reconcile/${latest.id}`}>Reconciliation report</Link>}
        </div>
      </div>
      <h2>Recommended matches ({w.suggestions.length})</h2>
      <Suggestions bankAccountId={w.bank.id} bank={bank} book={book} suggestions={w.suggestions.map((g, i) => ({ key: String(i), bankIds: g.bankIds, bookIds: g.bookIds, confidence: g.confidence, reason: g.reason }))} />
      <h2>Match manually</h2>
      <p className="muted">For anything the recommendations missed. Select bank and book lines with the same total (for example one deposit that covers several receipts) and match them.</p>
      <Manual bankAccountId={w.bank.id} bank={bank} book={book} accounts={accounts} canPost={can(ctx.role, "journal.post")} />
      <h2>Recently cleared</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>When</th><th>How</th><th>Bank lines</th><th>Book entries</th><th className="num">Amount</th><th /></tr></thead>
        <tbody>
          {w.recent.map((m) => {
            const amt = m.book.reduce((t, l) => t + (BigInt(Math.round(Number(l.fxDebit) * 100)) - BigInt(Math.round(Number(l.fxCredit) * 100))), 0n);
            return (
              <tr key={m.id}>
                <td>{m.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{METHOD[m.method] ?? m.method}{m.note ? <div className="muted">{m.note}</div> : null}</td>
                <td>{m.statementLines.map((l) => <div key={l.id}>{fmtDate(l.date)} · {l.description}</div>)}</td>
                <td>{m.book.map((l) => <div key={l.id}><Link href={`/journals/${l.journalEntryId}`}>{l.journalEntry.number}</Link> {l.journalEntry.memo}</div>)}</td>
                <td className="num">{formatPeso(amt)}</td>
                <td>{!m.note?.startsWith("Voided") && <ActionForm action={undoMatch}><input type="hidden" name="id" value={m.id} /><input type="hidden" name="method" value={m.method} /><button className="link">{m.method === "ADJUSTMENT" ? "Undo (reverses the entry)" : "Undo"}</button></ActionForm>}</td>
              </tr>
            );
          })}
          {w.recent.length === 0 && <tr><td colSpan={6} className="muted">Nothing cleared yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
