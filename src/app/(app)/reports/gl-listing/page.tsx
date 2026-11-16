import { CustomizeLink } from "@/components/reporting/CustomizeLink";
import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { accountActivity, accountLedger } from "@/lib/ledger/reports";
import { formatPeso } from "@/lib/money";
import { firstOfYear, fmtDate, parseDateParam, today } from "@/lib/format";
import { DimFilter, dimsFrom } from "@/components/DimFilter";

type SP = Promise<Record<string, string | undefined>>;

export default async function GLListing({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const f = { dims: dimsFrom(sp) };
  const act = await accountActivity(ctx.org.id, new Date(from), new Date(to), f);
  const ledgers = [];
  for (const r of act.rows) {
    if (r.periodDebit === 0n && r.periodCredit === 0n && !sp.all) continue;
    ledgers.push(await accountLedger(ctx.org.id, r.account.id, new Date(from), new Date(to), f));
  }
  return (
    <>
      <div className="top"><h1>General Ledger Listing</h1><CustomizeLink template="gl_listing" from={from} to={to} /><span className="muted">{ctx.org.name} · {from} to {to}</span></div>
      <form className="card row noprint">
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <DimFilter organizationId={ctx.org.id} sp={sp} />
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      {ledgers.map((d) => d && (
        <div key={d.account.id} style={{ marginBottom: 18 }}>
          <h2>{d.account.code} · {d.account.name}</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Posting date</th><th>Entry</th><th>Ref.</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
            <tbody>
              <tr className="header"><td colSpan={6}>Opening balance</td><td className="num">{formatPeso(d.opening)}</td></tr>
              {d.lines.map((l) => (
                <tr key={l.id}><td>{fmtDate(l.date)}</td><td><Link href={`/journals/${l.entryId}`}>{l.number}</Link></td><td>{l.reference}</td>
                  <td>{l.memo}{l.description && l.description !== l.memo ? <span className="muted"> — {l.description}</span> : null}</td>
                  <td className="num">{formatPeso(l.debit, { blankZero: true })}</td><td className="num">{formatPeso(l.credit, { blankZero: true })}</td><td className="num">{formatPeso(l.balance)}</td></tr>
              ))}
              <tr className="total"><td colSpan={4}>Closing balance</td><td className="num">{formatPeso(d.totalDebit)}</td><td className="num">{formatPeso(d.totalCredit)}</td><td className="num">{formatPeso(d.closing)}</td></tr>
            </tbody>
          </table></div>
        </div>
      ))}
      {ledgers.length === 0 && <p className="muted">No posted transactions in this period.</p>}
    </>
  );
}
