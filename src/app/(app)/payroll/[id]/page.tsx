import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/lib/format";
import { RUN_KIND_LABEL, RUN_STATUS_LABEL } from "@/lib/payroll/service";
import { ITEM_CATEGORIES, type Line } from "@/lib/payroll/compute";
import { DE_MINIMIS } from "@/lib/payroll/rates";
import { employeeName } from "@/lib/hr/service";
import { runAction } from "../../payroll-actions";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts, empOpts } from "@/lib/lookup";

const peso = (n: unknown) => Number(n ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Op({ id, op, label, cls, confirm, children }: { id: string; op: string; label: string; cls?: string; confirm?: string; children?: React.ReactNode }) {
  return (
    <ActionForm action={runAction} confirm={confirm} style={{ display: "inline-block" }}>
      <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={op} />
      <div className="row" style={{ gap: 6 }}>{children}<div style={{ flex: 0 }}><button className={cls}>{label}</button></div></div>
    </ActionForm>
  );
}

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx("payroll.process");
  const run = await prisma.payrollRun.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!run) notFound();
  const [slips, adjustments, emps, banks, je, pay] = await Promise.all([
    prisma.payslip.findMany({ where: { runId: id }, orderBy: [{ department: "asc" }, { employeeCode: "asc" }] }),
    prisma.employeePayItem.findMany({ where: { runId: id }, include: { employee: true }, orderBy: { createdAt: "asc" } }),
    prisma.employee.findMany({ where: { organizationId: ctx.org.id, isActive: true, isPartner: false }, orderBy: { code: "asc" } }),
    prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id, isActive: true, currencyCode: "PHP" }, orderBy: { code: "asc" } }),
    run.journalEntryId ? prisma.journalEntry.findUnique({ where: { id: run.journalEntryId } }) : null,
    run.paymentEntryId ? prisma.journalEntry.findUnique({ where: { id: run.paymentEntryId } }) : null,
  ]);
  const approve = can(ctx.role, "payroll.approve");
  const draft = run.status === "DRAFT";
  const sum = (k: keyof (typeof slips)[number]) => slips.reduce((n, s) => n + Number(s[k] ?? 0), 0);
  const reviewed = slips.filter((s) => s.reviewed).length;
  const warnings = slips.flatMap((s) => ((s.warnings as string[] | null) ?? []).map((w) => `${s.employeeCode} ${s.employeeName}: ${w}`));
  const categories = [
    ...Object.entries(ITEM_CATEGORIES.EARNING).map(([k, v]) => [`EARNING:${k}`, `Earning - ${v}`]),
    ...Object.entries(ITEM_CATEGORIES.DEDUCTION).map(([k, v]) => [`DEDUCTION:${k}`, `Deduction - ${v}`]),
  ];
  return (
    <>
      <div className="top">
        <div><h1>Payroll {run.number} <span className={`badge ${run.status}`}>{RUN_STATUS_LABEL[run.status]}</span></h1>
          <div className="muted">{RUN_KIND_LABEL[run.kind]} · {run.frequency === "MONTHLY" ? "monthly" : "semi-monthly"} · {fmtDate(run.periodStart)} to {fmtDate(run.periodEnd)} · pay date {fmtDate(run.payDate)}
            {run.deductContributions ? " · deducts SSS / PhilHealth / Pag-IBIG" : ""}{run.yearEndAdjustment ? " · year-end tax adjustment" : ""}</div></div>
        <div className="row noprint" style={{ flex: 0, flexWrap: "nowrap", gap: 8 }}>
          <a className="btn secondary" href={`/api/payroll/pdf?doc=register&run=${run.id}`} target="_blank">Payroll register (PDF)</a>
          <a className="btn secondary" href={`/api/payroll/pdf?doc=payslip&run=${run.id}`} target="_blank">All payslips (PDF)</a>
        </div>
      </div>
      {run.returnReason && run.status !== "FINALIZED" && <div className="errors">{run.status === "VOID" ? "Voided" : "Returned"}: {run.returnReason}</div>}
      {warnings.length > 0 && <div className="errors"><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}

      <div className="grid" style={{ marginBottom: 16 }}>
        {[["Employees", String(slips.length)], ["Gross pay", peso(sum("gross"))], ["Withholding tax", peso(sum("withholdingTax"))], ["Net pay", peso(sum("netPay"))], ["Employer cost", peso(sum("employerCost"))], ["Reviewed", `${reviewed} of ${slips.length}`]].map(([l, n]) => (
          <div className="card stat" key={l} style={{ marginBottom: 0 }}><div className="n">{n}</div><div className="l">{l}</div></div>
        ))}
      </div>

      <div className="card noprint">
        <div className="row" style={{ gap: 8 }}>
          {draft && <Op id={run.id} op="compute" label={run.computedAt ? "Recompute" : "Compute payroll"} />}
          {draft && run.computedAt && <Op id={run.id} op="submit" label="Submit for review" cls="secondary" />}
          {run.status === "FOR_REVIEW" && approve && <>
            <Op id={run.id} op="review" label="Mark all reviewed" cls="secondary"><input type="hidden" name="all" value="1" /></Op>
            <Op id={run.id} op="finalize" label="Finalize and post to GL" confirm="Finalize this payroll? It posts the payroll accrual to the general ledger and locks the payslips." />
            <Op id={run.id} op="return" label="Return to preparer" cls="secondary"><div><input name="reason" placeholder="Reason" required /></div></Op>
          </>}
          {run.status === "FINALIZED" && approve && !run.releasedAt && <Op id={run.id} op="release" label="Release payslips to employees" confirm="Employees will see their payslips in the portal. Continue?" />}
          {run.status === "FINALIZED" && approve && !run.paymentEntryId && (
            <Op id={run.id} op="pay" label="Record salary payment" cls="secondary">
              <div><MasterPicker name="bankAccountId" ariaLabel="Paid from" defaultValue="" required options={idOpts(banks)} add={{ kind: "banks" }} placeholder="Paid from…" /></div>
              <div><input type="date" name="date" defaultValue={fmtDate(run.payDate)} /></div>
            </Op>
          )}
          {run.status !== "VOID" && approve && !run.releasedAt && (
            <Op id={run.id} op="void" label="Void" cls="danger" confirm="Void this payroll? Posted GL entries are reversed."><div><input name="reason" placeholder="Reason for voiding" required /></div></Op>
          )}
        </div>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {je && <>GL accrual: <Link href={`/journals/${je.id}`}>{je.number}</Link>. </>}
          {pay && <>Salary payment: <Link href={`/journals/${pay.id}`}>{pay.number}</Link>. </>}
          {run.releasedAt && <>Payslips released {fmtDate(run.releasedAt)}. </>}
          {draft && "Time data comes from approved time logs, overtime, leave and schedule changes. Recompute after any change."}
        </div>
      </div>

      {draft && (
        <div className="card noprint">
          <h2 style={{ marginTop: 0 }}>Adjustments for this payroll</h2>
          <p className="muted" style={{ marginTop: 0 }}>One-time bonuses, commissions, incentives or deductions. Recurring allowances and loans are set per employee.</p>
          <ActionForm action={runAction}>
            <input type="hidden" name="id" value={run.id} /><input type="hidden" name="op" value="adjust" />
            <div className="row">
              <div><label>Employee</label><MasterPicker name="employeeId" ariaLabel="Employee" required options={empOpts(emps)} defaultValue={emps[0]?.id} /></div>
              <div><label>Type</label><select name="type">{categories.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
              <div><label>De minimis kind</label><select name="deMinimisCode" defaultValue=""><option value="">(n/a)</option>{Object.entries(DE_MINIMIS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
              <div><label>Description</label><input name="name" required placeholder="e.g. Sales commission - May" /></div>
              <div><label>Amount</label><input name="amount" className="num" required /></div>
              <div style={{ flex: 0 }}><button>Add</button></div>
            </div>
          </ActionForm>
          {adjustments.length > 0 && <table style={{ marginTop: 10 }}><tbody>{adjustments.map((a) => (
            <tr key={a.id}><td>{a.employee.code} {employeeName(a.employee)}</td><td>{a.kind.toLowerCase()} · {a.name}</td><td className="num">{peso(a.amount)}</td>
              <td style={{ width: 80 }}><ActionForm action={runAction}><input type="hidden" name="id" value={run.id} /><input type="hidden" name="op" value="unadjust" /><input type="hidden" name="itemId" value={a.id} /><button className="link">Remove</button></ActionForm></td></tr>
          ))}</tbody></table>}
        </div>
      )}

      <div className="table-wrap"><table>
        <thead><tr><th>Employee</th><th>Department</th><th className="num">Basic</th><th className="num">Gross</th><th className="num">SSS</th><th className="num">PhilHealth</th><th className="num">Pag-IBIG</th><th className="num">Tax</th><th className="num">Other ded.</th><th className="num">Net pay</th><th>Reviewed</th><th></th></tr></thead>
        <tbody>
          {slips.map((s) => (
            <tr key={s.id}>
              <td>
                <details><summary>{s.employeeCode} {s.employeeName}</summary>
                  <div style={{ fontSize: 12, padding: "6px 0" }}>
                    <div className="muted">Daily {peso(s.dailyRate)} · hourly {peso(s.hourlyRate)}{s.minimumWageEarner ? " · minimum wage earner" : ""}</div>
                    <b>Earnings</b>{(s.earnings as unknown as Line[]).map((l, i) => <div key={i}>{l.label}{l.qty !== undefined ? ` (${l.qty} ${l.unit})` : ""}: {peso(l.amount)}{l.taxable === false ? " non-taxable" : ""}</div>)}
                    <b>Deductions</b>{(s.deductions as unknown as Line[]).map((l, i) => <div key={i}>{l.label}: {peso(l.amount)}</div>)}
                    <b>Employer</b>{(s.employer as unknown as Line[]).map((l, i) => <div key={i}>{l.label}: {peso(l.amount)}</div>)}
                    <div>Taxable compensation: {peso(s.taxableIncome)}</div>
                  </div>
                </details>
              </td>
              <td>{s.department}</td><td className="num">{peso(s.basicPay)}</td><td className="num">{peso(s.gross)}</td>
              <td className="num">{peso(Number(s.sssEE) + Number(s.mpfEE))}</td><td className="num">{peso(s.phicEE)}</td><td className="num">{peso(s.hdmfEE)}</td>
              <td className="num">{peso(s.withholdingTax)}</td><td className="num">{peso(s.otherDeductions)}</td><td className="num"><b>{peso(s.netPay)}</b></td>
              <td>{run.status === "FOR_REVIEW" && approve
                ? <ActionForm action={runAction}><input type="hidden" name="id" value={run.id} /><input type="hidden" name="op" value={s.reviewed ? "unreview" : "review"} /><input type="hidden" name="slip" value={s.id} /><button className="link">{s.reviewed ? "✓ Reviewed" : "Mark reviewed"}</button></ActionForm>
                : s.reviewed ? "✓" : ""}</td>
              <td><a href={`/api/payroll/pdf?doc=payslip&run=${run.id}&employee=${s.employeeId}`} target="_blank">Payslip</a></td>
            </tr>
          ))}
          {slips.length > 0 && <tr className="total"><td>Total</td><td></td><td className="num">{peso(sum("basicPay"))}</td><td className="num">{peso(sum("gross"))}</td><td className="num">{peso(sum("sssEE") + sum("mpfEE"))}</td><td className="num">{peso(sum("phicEE"))}</td><td className="num">{peso(sum("hdmfEE"))}</td><td className="num">{peso(sum("withholdingTax"))}</td><td className="num">{peso(sum("otherDeductions"))}</td><td className="num">{peso(sum("netPay"))}</td><td></td><td></td></tr>}
          {slips.length === 0 && <tr><td colSpan={12} className="muted">Not computed yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
