import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/lib/format";
import { RUN_KIND_LABEL, RUN_STATUS_LABEL } from "@/lib/payroll/service";
import { manilaToday } from "@/lib/payroll/attendance";
import { newRunAction } from "../payroll-actions";

const peso = (n: unknown) => Number(n ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function PayrollRuns() {
  const ctx = await requireCtx("payroll.process");
  const runs = await prisma.payrollRun.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ payDate: "desc" }, { number: "desc" }], take: 100 });
  const totals = await prisma.payslip.groupBy({ by: ["runId"], where: { runId: { in: runs.map((r) => r.id) } }, _sum: { gross: true, netPay: true }, _count: true });
  const t = new Map(totals.map((x) => [x.runId, x]));
  const today = manilaToday();
  const [y, m, d] = today.split("-").map(Number);
  const first = Number(d) <= 15;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ps = `${today.slice(0, 8)}${first ? "01" : "16"}`, pe = `${today.slice(0, 8)}${first ? "15" : String(last)}`;
  return (
    <>
      <div className="top"><h1>Payroll Runs</h1>
        <div className="row noprint" style={{ flex: 0, flexWrap: "nowrap", gap: 8 }}>
          <Link className="btn secondary" href="/payroll/reports">Reports (PDF)</Link>
          <Link className="btn secondary" href="/payroll/2316">BIR 2316</Link>
        </div>
      </div>
      <div className="card noprint">
        <h2 style={{ marginTop: 0 }}>New payroll</h2>
        <ActionForm action={newRunAction}>
          <div className="row">
            <div><label>Type</label><select name="kind" defaultValue="REGULAR">{Object.entries(RUN_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div><label>Frequency</label><select name="frequency" defaultValue="SEMI_MONTHLY"><option value="SEMI_MONTHLY">Semi-monthly (15th and end of month)</option><option value="MONTHLY">Monthly</option></select></div>
            <div><label>Period from</label><input type="date" name="periodStart" defaultValue={ps} required /></div>
            <div><label>Period to</label><input type="date" name="periodEnd" defaultValue={pe} required /></div>
            <div><label>Pay date</label><input type="date" name="payDate" defaultValue={pe} required /></div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div><label>SSS, PhilHealth and Pag-IBIG</label><select name="deductContributions" defaultValue="auto">
                <option value="auto">Automatic: deduct when the period ends at month-end</option><option value="true">Deduct in this run</option><option value="false">Don't deduct in this run</option></select>
              <div className="muted" style={{ fontSize: 12 }}>Contributions are computed on the whole month's pay in the second cutoff. Monthly runs always deduct.</div></div>
            <div><label><input type="checkbox" name="yearEndAdjustment" style={{ width: "auto" }} /> Year-end tax adjustment (annualize withholding tax)</label>
              <div className="muted" style={{ fontSize: 12 }}>Use in the last payroll of the year or the final pay of a separated employee.</div></div>
            <div><label>Notes</label><input name="memo" /></div>
            <div style={{ flex: 0 }}><button>Create</button></div>
          </div>
        </ActionForm>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>No.</th><th>Type</th><th>Period</th><th>Pay date</th><th>Status</th><th className="num">Employees</th><th className="num">Gross</th><th className="num">Net pay</th><th>Payslips</th><th>Paid</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td><Link href={`/payroll/${r.id}`}>{r.number}</Link></td><td>{RUN_KIND_LABEL[r.kind]}</td>
              <td>{fmtDate(r.periodStart)} to {fmtDate(r.periodEnd)}</td><td>{fmtDate(r.payDate)}</td>
              <td><span className={`badge ${r.status}`}>{RUN_STATUS_LABEL[r.status]}</span></td>
              <td className="num">{t.get(r.id)?._count ?? 0}</td><td className="num">{peso(t.get(r.id)?._sum.gross)}</td><td className="num">{peso(t.get(r.id)?._sum.netPay)}</td>
              <td>{r.releasedAt ? "Released" : ""}</td><td>{r.paidAt ? fmtDate(r.paidAt) : ""}</td>
            </tr>
          ))}
          {runs.length === 0 && <tr><td colSpan={10} className="muted">No payroll yet. Set up employees (rate, schedule, manager) under <Link href="/payroll/employees">Employees and Pay</Link>, then create the first payroll above.</td></tr>}
        </tbody>
      </table></div>
      {can(ctx.role, "payroll.approve") && <p className="muted">Workflow: compute → submit for review → reviewer ticks each payslip → finalize (posts to the GL) → release payslips to employees → record the salary payment.</p>}
    </>
  );
}
