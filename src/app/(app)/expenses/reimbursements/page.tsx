import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { today } from "@/lib/format";
import { outstandingReimbursements } from "@/lib/pettycash/service";
import { MODULES, type ModuleKey } from "@/lib/expense/catalog";
import { ActionForm } from "@/components/ActionForm";
import { peso } from "@/components/ExpenseUi";
import { payReimbursementAction } from "../../expense-actions";

export default async function Reimbursements() {
  const ctx = await requireCtx("reports.view");
  const [due, banks, inProcess] = await Promise.all([
    outstandingReimbursements(ctx.org.id),
    prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id, isActive: true, kind: { in: ["CURRENT", "SAVINGS", "EWALLET"] } }, orderBy: { code: "asc" } }),
    prisma.pettyCashVoucher.findMany({ where: { organizationId: ctx.org.id, paymentMethod: "EMPLOYEE", status: "CLEARED", reimbursementId: { not: null } }, select: { reimbursementId: true, totalPaid: true } }),
  ]);
  const txIds = [...new Set(inProcess.map((v) => v.reimbursementId!).filter((x) => !x.startsWith("PENDING:")))];
  const txs = await prisma.cashTransaction.findMany({ where: { id: { in: txIds } }, select: { id: true, number: true, status: true, payee: true, amount: true, date: true } });
  const finance = can(ctx.role, "expense.finance");
  return (
    <>
      <div className="top"><h1>Employee reimbursements</h1></div>
      <p className="muted">Claims the employee paid personally are posted Dr expense / Cr Employee Reimbursements Payable when finance clears them. Paying the employee back creates one disbursement voucher (Dr Employee Reimbursements Payable / Cr bank) that goes through the normal voucher approval in Cash and Bank.</p>
      {due.length === 0 && <div className="notice">Nothing to reimburse right now.</div>}
      {due.map((d) => (
        <div className="card" key={d.employee.id}>
          <h3 style={{ marginTop: 0 }}>{d.employee.name} <span className="muted">({d.employee.code})</span> · {peso(d.total)} <span className="muted" style={{ fontWeight: 400 }}>for {d.count} claim{d.count === 1 ? "" : "s"}</span></h3>
          <ActionForm action={payReimbursementAction}>
            <input type="hidden" name="employeeId" value={d.employee.id} />
            <div className="table-wrap"><table>
              <thead><tr><th style={{ width: 30 }}></th><th>Date</th><th>Claim</th><th>Module</th><th>Description</th><th className="num">Amount</th></tr></thead>
              <tbody>{d.vouchers.map((v) => <tr key={v.id}><td><input type="checkbox" name="voucherId" value={v.id} defaultChecked style={{ width: "auto" }} /></td><td>{v.receiptDate}</td><td><Link href={`/expenses/claims/${v.id}`}>{v.number}</Link></td><td>{MODULES[v.module as ModuleKey].label}</td><td>{v.description}</td><td className="num">{peso(v.totalPaid)}</td></tr>)}</tbody>
            </table></div>
            {finance && (
              <div className="row" style={{ marginTop: 10, alignItems: "end" }}>
                <div><label>Pay from</label><select name="bankAccountId" required>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></div>
                <div><label>Date</label><input type="date" name="date" defaultValue={today()} /></div>
                <div><label>Method</label><select name="method" defaultValue="BANK_TRANSFER"><option value="BANK_TRANSFER">Bank transfer</option><option value="CHECK">Check</option><option value="EWALLET">GCash / Maya</option><option value="CASH">Cash</option></select></div>
                <div><label>Check no.</label><input name="checkNo" /></div>
                <div style={{ flex: 0 }}><button>Create payment voucher</button></div>
              </div>
            )}
          </ActionForm>
        </div>
      ))}
      {txs.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Payments in process</h3>
          <table><thead><tr><th>Voucher</th><th>Payee</th><th>Date</th><th>Status</th><th className="num">Amount</th></tr></thead>
            <tbody>{txs.map((t) => <tr key={t.id}><td><Link href={`/cash/${t.id}`}>{t.number}</Link></td><td>{t.payee}</td><td>{t.date.toISOString().slice(0, 10)}</td><td><span className={`badge ${t.status}`}>{t.status.replace("_", " ")}</span></td><td className="num">{peso(t.amount.toString())}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </>
  );
}
