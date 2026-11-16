import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { KIND_LABELS, bookBalance, isBank } from "@/lib/bank/cash";

export default async function BankHome() {
  const ctx = await requireCtx("reports.view");
  const banks = await prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id }, include: { glAccount: true }, orderBy: { code: "asc" } });
  const rows = await Promise.all(banks.map(async (b) => {
    const [bal, last, rec, openBank, openBook] = await Promise.all([
      bookBalance(ctx.org.id, b.glAccountId),
      prisma.bankStatement.findFirst({ where: { bankAccountId: b.id }, orderBy: { periodTo: "desc" } }),
      prisma.bankStatement.findFirst({ where: { bankAccountId: b.id, status: "RECONCILED" }, orderBy: { periodTo: "desc" } }),
      prisma.bankStatementLine.count({ where: { bankAccountId: b.id, matchId: null } }),
      prisma.journalLine.count({ where: { organizationId: ctx.org.id, accountId: b.glAccountId, clearedAt: null, journalEntry: { status: "POSTED", book: "STATUTORY" }, OR: [{ fxDebit: { not: 0 } }, { fxCredit: { not: 0 } }] } }),
    ]);
    return { b, bal, last, rec, openBank, openBook };
  }));
  const pending = await prisma.cashTransaction.count({ where: { organizationId: ctx.org.id, status: "PENDING_APPROVAL" } });
  return (
    <>
      <div className="top"><h1>Cash and Bank</h1>
        <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}>
          <Link className="btn secondary" href="/bank/statements">Upload bank statement</Link>
          <Link className="btn secondary" href="/masters/banks">Manage accounts</Link>
        </div>
      </div>
      {pending > 0 && <div className="notice"><Link href="/cash?status=PENDING_APPROVAL">{pending} cash voucher(s) waiting for approval</Link></div>}
      {banks.length === 0 && <div className="notice">No bank or cash accounts yet. Add them under <Link href="/masters/banks">Master Lists → Bank and Cash Accounts</Link> (each one points to a cash account in the chart of accounts, e.g. 1020 Cash in Bank).</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>Account</th><th>Kind</th><th>GL account</th><th className="num">Book balance</th><th>Last statement</th><th>Reconciled up to</th><th className="num">Bank lines to clear</th><th className="num">Book lines not cleared</th><th /></tr></thead>
        <tbody>
          {rows.map(({ b, bal, last, rec, openBank, openBook }) => (
            <tr key={b.id}>
              <td><strong>{b.code}</strong> · {b.name}<div className="muted">{[b.bankName, b.accountNumber].filter(Boolean).join(" · ")}</div></td>
              <td>{KIND_LABELS[b.kind] ?? b.kind}</td><td>{b.glAccount.code}</td>
              <td className="num">{b.currencyCode} {formatPeso(bal)}</td>
              <td>{last ? <>{fmtDate(last.periodTo)}<div className="muted">bank bal. {formatPeso(toCentavos(last.closingBalance.toString()))}</div></> : "—"}</td>
              <td>{rec ? fmtDate(rec.periodTo) : "—"}</td>
              <td className="num">{isBank(b.kind) ? openBank : ""}</td><td className="num">{isBank(b.kind) ? openBook : ""}</td>
              <td style={{ minWidth: 120 }}>
                <Link href={`/cash?bank=${b.id}`}>Transactions</Link>
                {isBank(b.kind) && <><br /><Link href={`/bank/reconcile?account=${b.id}`}>Match and clear</Link></>}
                {last && <><br /><Link href={`/bank/reconcile/${last.id}`}>Reconciliation</Link></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <h2>How bank reconciliation works here</h2>
      <ol className="muted">
        <li>Download the Excel template on <Link href="/bank/statements">Bank Statements</Link>, paste your statement lines into it and upload it.</li>
        <li>On <b>Match and clear</b>, the system recommends which statement lines match your recorded receipts, checks and transfers (by check number, amount, reference and date). Tick the ones that are right and clear them.</li>
        <li>Bank charges, interest and other items only the bank knows about can be recorded in the books from the same screen.</li>
        <li>The <b>Reconciliation</b> report then shows outstanding checks and deposits in transit. When the difference is zero, finalize it.</li>
      </ol>
    </>
  );
}
