import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { accountLedger } from "@/lib/ledger/reports";
import { formatPeso } from "@/lib/money";
import { firstOfYear, fmtDate, parseDateParam, today } from "@/lib/format";
import { DimFilter, dimsFrom } from "@/components/DimFilter";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

type SP = Promise<Record<string, string | undefined>>;

export default async function Ledger({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear());
  const to = parseDateParam(sp.to, today());
  const accounts = await prisma.account.findMany({ where: { organizationId: ctx.org.id, isPostable: true }, orderBy: { code: "asc" } });
  const accountId = sp.account ?? "";
  const data = accountId ? await accountLedger(ctx.org.id, accountId, new Date(from), new Date(to), { dims: dimsFrom(sp) }) : null;
  const fx = data?.lines.some((l) => l.currencyCode !== "PHP");
  return (
    <>
      <div className="top"><h1>Account Ledger</h1><Link className="noprint" href="/reports/gl-listing">Full general ledger listing →</Link></div>
      <form className="card row noprint">
        <div style={{ flex: 3 }}><label>Account</label>
          <MasterPicker name="account" ariaLabel="Account" defaultValue={accountId} required options={idOpts(accounts)} placeholder="Type account code or name…" /></div>
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <DimFilter organizationId={ctx.org.id} sp={sp} />
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      {data && (
        <>
          <h2>{data.account.code} · {data.account.name} <span className="muted">({from} to {to}, normal balance: {data.account.normalBalance.toLowerCase()})</span></h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Posting date</th><th>Txn date</th><th>Entry</th><th>Ref.</th><th>Description</th>
              {fx && <><th>Ccy</th><th className="num">Forex amount</th><th className="num">Rate</th></>}
              <th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
            <tbody>
              <tr className="header"><td colSpan={fx ? 10 : 7}>Opening balance</td><td className="num">{formatPeso(data.opening)}</td></tr>
              {data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{fmtDate(l.date)}</td><td>{fmtDate(l.transactionDate)}</td><td><Link href={`/journals/${l.entryId}`}>{l.number}</Link></td><td>{l.reference}</td>
                  <td>{l.memo}{l.description && l.description !== l.memo ? <span className="muted"> — {l.description}</span> : null}</td>
                  {fx && <><td>{l.currencyCode}</td><td className="num">{formatPeso(l.fxDebit - l.fxCredit)}</td><td className="num">{l.fxRate}</td></>}
                  <td className="num">{formatPeso(l.debit, { blankZero: true })}</td>
                  <td className="num">{formatPeso(l.credit, { blankZero: true })}</td>
                  <td className="num">{formatPeso(l.balance)}</td>
                </tr>
              ))}
              {data.lines.length === 0 && <tr><td colSpan={fx ? 11 : 8} className="muted">No posted transactions in this period.</td></tr>}
              <tr className="total"><td colSpan={fx ? 8 : 5}>Totals / closing balance</td>
                <td className="num">{formatPeso(data.totalDebit)}</td><td className="num">{formatPeso(data.totalCredit)}</td><td className="num">{formatPeso(data.closing)}</td></tr>
            </tbody>
          </table></div>
        </>
      )}
    </>
  );
}
