import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { firstOfYear, fmtDate, parseDateParam, today } from "@/lib/format";
import { BOOKS, book, isBook } from "@/lib/tax/books";
import { PrintButton } from "@/components/PrintButton";
import { TaxTabs } from "../ui";

export default async function Books({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const kind = sp.book && isBook(sp.book) ? sp.book : "general-journal";
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const rows = await book(ctx.org.id, kind, new Date(from), new Date(to));
  const dr = rows.reduce((s, e) => s + e.lines.reduce((t, l) => t + l.debit, 0n), 0n);
  const cr = rows.reduce((s, e) => s + e.lines.reduce((t, l) => t + l.credit, 0n), 0n);
  return (
    <>
      <div className="top"><h1>{BOOKS[kind]}</h1><div className="noprint" style={{ display: "flex", gap: 8 }}>
        <a className="btn secondary" href={`/api/tax/download?type=book&book=${kind}&from=${from}&to=${to}`}>CSV</a><PrintButton /></div></div>
      <TaxTabs active="/tax/books" />
      <form className="card row noprint">
        <div style={{ maxWidth: 260 }}><label>Book</label><select name="book" defaultValue={kind}>{Object.entries(BOOKS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <p className="muted noprint">
        {ctx.org.name} · {from} to {to}. For loose-leaf books, print each book, number the pages and have them bound; submit the bound books to your RDO within 15 days after the end of the year (RR 9-2009).
        The general ledger is under <Link href={`/reports/gl-listing?from=${from}&to=${to}`}>General Ledger Listing</Link>. Computerized books (CAS) need BIR registration before use.
      </p>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Entry no.</th><th>Reference</th><th>Particulars</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
        <tbody>
          {rows.flatMap((e) => e.lines.map((l, i) => (
            <tr key={`${e.id}-${i}`}>
              <td>{i === 0 ? fmtDate(e.date) : ""}</td>
              <td>{i === 0 ? <Link href={`/journals/${e.id}`}>{e.number}</Link> : ""}</td>
              <td>{i === 0 ? e.reference : ""}</td>
              <td>{i === 0 ? e.memo : <span className="muted">{l.description && l.description !== e.memo ? l.description : ""}</span>}</td>
              <td>{l.accountCode} · {l.accountName}</td>
              <td className="num">{formatPeso(l.debit, { blankZero: true })}</td><td className="num">{formatPeso(l.credit, { blankZero: true })}</td>
            </tr>
          )))}
          {rows.length === 0 && <tr><td colSpan={7} className="muted">No posted entries in this book for the period.</td></tr>}
          <tr className="total"><td colSpan={5}>Total ({rows.length} entries)</td><td className="num">{formatPeso(dr)}</td><td className="num">{formatPeso(cr)}</td></tr>
        </tbody>
      </table></div>
    </>
  );
}
