import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { reconciliationStatus } from "@/lib/expense/service";
import { ActionForm } from "@/components/ActionForm";
import { peso } from "@/components/ExpenseUi";
import { autoReconcileAction, exceptionToClaimAction } from "../../expense-actions";

const KIND: Record<string, string> = { EWALLET: "E-wallet", CREDIT_CARD: "Credit card", CURRENT: "Bank (debit card)", SAVINGS: "Bank (debit card)" };

export default async function Reconcile() {
  const ctx = await requireCtx("reports.view");
  const [accts, emps] = await Promise.all([
    reconciliationStatus(ctx.org.id),
    prisma.employee.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { code: "asc" } }),
  ]);
  const finance = can(ctx.role, "expense.finance");
  return (
    <>
      <div className="top"><h1>Wallet and card reconciliation</h1></div>
      <p className="muted">
        Import the GCash, Maya or credit card statement in <Link href="/bank/statements">Bank Statements</Link> (CSV export from the provider&apos;s business portal).
        Auto-match then clears each posted claim against its charge by amount and booking number. A charge with no claim is an exception: send it to the employee as a claim to complete.
      </p>
      {accts.length === 0 && <div className="notice">No corporate wallets or cards yet. Add GCash / Maya (kind EWALLET) or a corporate card (kind CREDIT_CARD, on a liability account) in <Link href="/masters/banks">Bank and Cash Accounts</Link>.</div>}
      {accts.map((a) => (
        <div className="card" key={a.account.id}>
          <div className="top" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>{a.account.code} · {a.account.name} <span className="muted" style={{ fontWeight: 400 }}>{KIND[a.account.kind] ?? a.account.kind}</span></h3>
            {finance && <ActionForm action={autoReconcileAction}><input type="hidden" name="bankAccountId" value={a.account.id} /><button>Auto-match claims</button></ActionForm>}
          </div>
          <div className="grid">
            <div className="stat"><div className="n">{a.reconciled}</div><div className="l">Claims matched to the statement</div></div>
            <div className="stat"><div className="n">{a.unreconciled}</div><div className="l">Posted claims not on a statement yet</div></div>
            <div className="stat"><div className="n">{a.exceptions.length}</div><div className="l">Charges with no claim (exceptions)</div></div>
            <div className="stat"><div className="n">{a.statementLinesOpen}</div><div className="l">Open statement lines (money out)</div></div>
          </div>
          {a.exceptions.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10 }}><table>
              <thead><tr><th>Date</th><th>Statement description</th><th>Reference</th><th className="num">Amount</th>{finance && <th>Send to employee as a claim</th>}</tr></thead>
              <tbody>{a.exceptions.map((x) => (
                <tr key={x.id}>
                  <td>{x.date}</td><td>{x.description}</td><td>{x.reference}</td><td className="num">{peso(x.amount)}</td>
                  {finance && <td>
                    <ActionForm action={exceptionToClaimAction} className="row">
                      <input type="hidden" name="statementLineId" value={x.id} />
                      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                        <select name="employeeId" required defaultValue=""><option value="" disabled>Employee…</option>{emps.map((e) => <option key={e.id} value={e.id}>{e.code} {e.firstName} {e.lastName}</option>)}</select>
                        <select name="module" defaultValue={/lalamove|transportify|borzo|lbc|express|courier/i.test(x.description) ? "DELIVERY" : /air|hotel|agoda|booking/i.test(x.description) ? "TRAVEL" : "TRANSPORT"}><option value="TRANSPORT">Transport</option><option value="DELIVERY">Sent Package</option><option value="TRAVEL">Travel</option></select>
                        <button className="secondary">Send</button>
                      </div>
                    </ActionForm>
                  </td>}
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {a.claims.filter((c) => !c.reconciled).length > 0 && (
            <details style={{ marginTop: 10 }}><summary>Posted claims not yet on a statement ({a.unreconciled})</summary>
              <table><thead><tr><th>Date</th><th>Claim</th><th>Booking no.</th><th>Description</th><th className="num">Amount</th></tr></thead>
                <tbody>{a.claims.filter((c) => !c.reconciled).map((c) => <tr key={c.id}><td>{c.date}</td><td><Link href={`/expenses/claims/${c.id}`}>{c.number}</Link></td><td>{c.bookingNumber}</td><td>{c.description}</td><td className="num">{peso(c.amount)}</td></tr>)}</tbody>
              </table>
            </details>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>Anything auto-match leaves can be matched by hand in <Link href={`/bank/reconcile`}>Bank Reconciliation</Link>.</p>
        </div>
      ))}
    </>
  );
}
