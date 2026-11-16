import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { reconciliation } from "@/lib/bank/recon";
import { ActionForm } from "@/components/ActionForm";
import { finalizeRecon } from "../../../bank-actions";
import { PrintButton } from "@/components/PrintButton";

export default async function ReconReport({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const st = await prisma.bankStatement.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!st) notFound();
  const [r, org, others] = await Promise.all([
    reconciliation(ctx.org.id, id),
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.bankStatement.findMany({ where: { bankAccountId: st.bankAccountId }, orderBy: { periodTo: "desc" }, take: 24 }),
  ]);
  const by = st.reconciledById ? await prisma.user.findUnique({ where: { id: st.reconciledById } }) : null;
  const P = (c: bigint) => formatPeso(c);
  const ccy = r.bank.currencyCode;
  return (
    <>
      <div className="top">
        <h1>Bank Reconciliation · {r.bank.code} as of {fmtDate(r.asOf)} <span className={`badge ${st.status}`}>{st.status}</span></h1>
        <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}>
          <Link className="btn secondary" href={`/bank/reconcile?account=${r.bank.id}`}>Match and clear</Link>
        </div>
      </div>
      <p className="print-only"><strong>{org.name}</strong><br />{r.bank.name}{r.bank.accountNumber ? ` · Account ${r.bank.accountNumber}` : ""}</p>
      <p className="muted noprint">Other statements: {others.filter((o) => o.id !== st.id).slice(0, 12).map((o, i) => <span key={o.id}>{i ? " · " : ""}<Link href={`/bank/reconcile/${o.id}`}>{fmtDate(o.periodTo)}</Link></span>)}</p>
      {st.status === "RECONCILED" && <div className="notice">Finalized by {by?.name ?? "—"} on {st.reconciledAt?.toISOString().slice(0, 10)}. Its matches are locked.</div>}

      <div className="row" style={{ alignItems: "stretch" }}>
        <div className="card" style={{ minWidth: 340 }}>
          <table>
            <tbody>
              <tr className="header"><td>Balance per bank statement</td><td className="num">{ccy} {P(r.perBank)}</td></tr>
              <tr><td>Add: deposits in transit ({r.depositsInTransit.length})</td><td className="num">{P(r.totals.dit)}</td></tr>
              <tr><td>Less: outstanding checks and payments ({r.outstandingChecks.length})</td><td className="num">({P(r.totals.oc)})</td></tr>
              <tr className="total"><td>Adjusted bank balance</td><td className="num">{P(r.adjustedBank)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="card" style={{ minWidth: 340 }}>
          <table>
            <tbody>
              <tr className="header"><td>Balance per books (GL {r.bank.glAccount.code})</td><td className="num">{ccy} {P(r.perBooks)}</td></tr>
              <tr><td>Add: bank credits not yet in the books ({r.bankCredits.length})</td><td className="num">{P(r.totals.bankCredits)}</td></tr>
              <tr><td>Less: bank debits not yet in the books ({r.bankDebits.length})</td><td className="num">({P(r.totals.bankDebits)})</td></tr>
              {r.later.length > 0 && <tr><td>Add/less: bank items booked after {fmtDate(r.asOf)} ({r.later.length})</td><td className="num">{P(r.totals.later)}</td></tr>}
              <tr className="total"><td>Adjusted book balance</td><td className="num">{P(r.adjustedBooks)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className={r.difference === 0n ? "diff-ok" : "diff-bad"} style={{ fontSize: 16 }}>
        {r.difference === 0n ? "Reconciled: the adjusted bank and book balances agree ✓" : `Unreconciled difference: ${P(r.difference)}. Match the remaining lines, record bank items in the books, or check the statement balances.`}
      </p>
      {r.bankCredits.length + r.bankDebits.length > 0 && r.difference === 0n && <p className="muted">Bank items not yet in the books are reconciling items. Record them from Match and clear so the GL cash balance is right.</p>}

      <div className="row noprint" style={{ gap: 8 }}>
        {st.status === "OPEN" && can(ctx.role, "journal.post") && <ActionForm action={finalizeRecon}><input type="hidden" name="id" value={st.id} /><button disabled={r.difference !== 0n}>Finalize reconciliation</button></ActionForm>}
        {st.status === "RECONCILED" && can(ctx.role, "org.manage") && <ActionForm action={finalizeRecon} confirm="Reopen this reconciliation so its matches can be changed?"><input type="hidden" name="id" value={st.id} /><input type="hidden" name="op" value="reopen" /><button className="secondary">Reopen</button></ActionForm>}
        <PrintButton />
      </div>

      <Section title="Outstanding checks and payments" note="Recorded in the books, not yet cleared by the bank." rows={r.outstandingChecks.map((i) => ({ ...i, extra: i.checkNo ?? "" }))} extra="Check no." total={r.totals.oc} />
      <Section title="Deposits in transit" note="Recorded in the books, not yet credited by the bank." rows={r.depositsInTransit.map((i) => ({ ...i, extra: "" }))} total={r.totals.dit} />
      <h2>Bank items not yet in the books</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Description</th><th>Reference</th><th className="num">Credit (add)</th><th className="num">Debit (less)</th></tr></thead>
        <tbody>
          {[...r.bankCredits.map((x) => ({ ...x, cr: true })), ...r.bankDebits.map((x) => ({ ...x, cr: false }))].sort((a, b) => a.date.getTime() - b.date.getTime()).map((x) => (
            <tr key={x.id}><td>{fmtDate(x.date)}</td><td>{x.description}</td><td>{x.reference}</td><td className="num">{x.cr ? P(x.amount) : ""}</td><td className="num">{x.cr ? "" : P(x.amount)}</td></tr>
          ))}
          {r.bankCredits.length + r.bankDebits.length === 0 && <tr><td colSpan={5} className="muted">None.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}

function Section({ title, note, rows, total, extra }: { title: string; note: string; rows: { id: string; date: Date; number: string; memo: string; amount: bigint; daysOutstanding: number; extra: string }[]; total: bigint; extra?: string }) {
  return (
    <>
      <h2>{title}</h2>
      <p className="muted">{note}</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th>{extra && <th>{extra}</th>}<th>Particulars</th><th className="num">Days outstanding</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id}><td>{fmtDate(i.date)}</td><td>{i.number}</td>{extra && <td>{i.extra}</td>}<td>{i.memo}</td><td className={`num ${i.daysOutstanding > 180 ? "diff-bad" : ""}`}>{i.daysOutstanding}{i.daysOutstanding > 180 ? " (stale)" : ""}</td><td className="num">{formatPeso(i.amount)}</td></tr>
          ))}
          {rows.length === 0 ? <tr><td colSpan={extra ? 6 : 5} className="muted">None.</td></tr> : <tr className="total"><td colSpan={extra ? 5 : 4} className="num">Total</td><td className="num">{formatPeso(total)}</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
