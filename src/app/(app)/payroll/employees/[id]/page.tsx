import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/lib/format";
import { employeeName, leaveBalances } from "@/lib/hr/service";
import { ITEM_CATEGORIES, ratesFor } from "@/lib/payroll/compute";
import { DE_MINIMIS } from "@/lib/payroll/rates";
import { manilaToday } from "@/lib/payroll/attendance";
import { hrSetupAction, payItemAction } from "../../../payroll-actions";
import { MasterPicker } from "@/components/MasterPicker";

const peso = (n: unknown) => Number(n ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function EmployeePay({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx("payroll.process");
  const e = await prisma.employee.findFirst({ where: { id, organizationId: ctx.org.id }, include: { payItems: { where: { runId: null }, orderBy: { createdAt: "asc" } } } });
  if (!e) notFound();
  const hr = can(ctx.role, "hr.manage");
  const year = Number(manilaToday().slice(0, 4));
  const [shifts, others, balances, slips, login] = await Promise.all([
    prisma.shift.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { code: "asc" } }),
    prisma.employee.findMany({ where: { organizationId: ctx.org.id, isActive: true, NOT: { id } }, orderBy: { lastName: "asc" } }),
    leaveBalances(ctx.org.id, id, year),
    prisma.payslip.findMany({ where: { employeeId: id }, include: { run: true }, orderBy: { run: { payDate: "desc" } }, take: 24 }),
    e.userId ? prisma.user.findUnique({ where: { id: e.userId } }) : null,
  ]);
  const r = ratesFor({ payBasis: e.payBasis === "DAILY" ? "DAILY" : "MONTHLY", basicRate: Number(e.basicRate), workDaysPerYear: e.workDaysPerYear, minimumWageEarner: e.minimumWageEarner });
  const cats = Object.entries(ITEM_CATEGORIES).flatMap(([kind, m]) => Object.entries(m).map(([k, v]) => [`${kind}:${k}`, `${kind === "EARNING" ? "Earning" : kind === "DEDUCTION" ? "Deduction" : "Employer benefit"} - ${v}`]));
  return (
    <>
      <div className="top"><div><h1>{e.code} {employeeName(e)}</h1><div className="muted">{e.position} · {e.department} · hired {e.dateHired ? fmtDate(e.dateHired) : "-"} · {e.employmentStatus}</div></div>
        <Link className="btn secondary" href={`/masters/employees/edit?code=${encodeURIComponent(e.code)}`}>Edit master data</Link></div>
      <div className="grid" style={{ marginBottom: 16 }}>
        {[["Basic rate", `${peso(e.basicRate)} ${e.payBasis === "DAILY" ? "/ day" : "/ month"}`], ["Monthly equivalent", peso(r.monthly)], ["Daily rate", peso(r.daily)], ["Hourly rate", peso(r.hourly)]].map(([l, n]) => (
          <div className="card stat" key={l} style={{ marginBottom: 0 }}><div className="n">{n}</div><div className="l">{l}</div></div>))}
      </div>

      {hr && <div className="card">
        <h2 style={{ marginTop: 0 }}>Schedule, reporting line and pay settings</h2>
        <ActionForm action={hrSetupAction}>
          <input type="hidden" name="op" value="employee" /><input type="hidden" name="employeeId" value={e.id} />
          <div className="row">
            <div><label>Work schedule</label><MasterPicker name="shiftId" ariaLabel="Work schedule" defaultValue={e.shiftId ?? ""} emptyLabel="No fixed schedule" placeholder="No fixed schedule" options={shifts.map((s) => ({ value: s.id, label: s.name }))} /></div>
            <div><label>Reporting manager / supervisor</label><MasterPicker name="managerId" ariaLabel="Reporting manager" defaultValue={e.managerId ?? ""} emptyLabel="None (HR approves)" placeholder="None (HR approves)" options={others.map((o) => ({ value: o.id, code: o.code, label: employeeName(o), hint: o.position ?? undefined }))} /></div>
            <div><label>Work days per year (rate factor)</label><input name="workDaysPerYear" type="number" defaultValue={e.workDaysPerYear} /></div>
            <div><label>Cost center code</label><input name="costCenter" defaultValue={e.costCenter ?? ""} /></div>
            <div><label>Payroll bank account no.</label><input name="bankAccountNo" defaultValue={e.bankAccountNo ?? ""} /></div>
            <div><label>Separation date</label><input type="date" name="separationDate" defaultValue={e.separationDate ? fmtDate(e.separationDate) : ""} /></div>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <div><label><input type="checkbox" name="minimumWageEarner" defaultChecked={e.minimumWageEarner} style={{ width: "auto" }} /> Minimum wage earner (tax-exempt basic, holiday, OT, night differential)</label></div>
            <div style={{ flex: 0 }}><button>Save</button></div>
          </div>
        </ActionForm>
      </div>}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recurring allowances, loans and benefits</h2>
        <p className="muted" style={{ marginTop: 0 }}>Amounts are per payroll. Loans stop when the balance reaches zero. De minimis items are tax-exempt up to the RR 29-2025 ceilings; the excess counts toward the P90,000 exemption.</p>
        <table><thead><tr><th>Type</th><th>Description</th><th className="num">Per payroll</th><th className="num">Balance</th><th>From</th><th>To</th><th>Active</th></tr></thead>
          <tbody>{e.payItems.map((i) => (
            <tr key={i.id}><td>{i.kind.toLowerCase()} · {(ITEM_CATEGORIES as Record<string, Record<string, string>>)[i.kind]?.[i.category] ?? i.category}{i.deMinimisCode ? ` (${DE_MINIMIS[i.deMinimisCode]?.label})` : ""}</td><td>{i.name}</td>
              <td className="num">{peso(i.amount)}</td><td className="num">{i.balance !== null ? peso(i.balance) : ""}</td><td>{i.startDate ? fmtDate(i.startDate) : ""}</td><td>{i.endDate ? fmtDate(i.endDate) : ""}</td><td>{i.isActive ? "Yes" : "No"}</td></tr>
          ))}{e.payItems.length === 0 && <tr><td colSpan={7} className="muted">None.</td></tr>}</tbody></table>
        <ActionForm action={payItemAction} style={{ marginTop: 12 }}>
          <input type="hidden" name="employeeId" value={e.id} />
          <div className="row">
            <div><label>Type</label><select name="type">{cats.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div><label>De minimis kind</label><select name="deMinimisCode" defaultValue=""><option value="">(n/a)</option>{Object.entries(DE_MINIMIS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
            <div><label>Description</label><input name="name" required placeholder="e.g. Rice subsidy, SSS salary loan" /></div>
            <div><label>Amount per payroll</label><input name="amount" className="num" required /></div>
            <div><label>Loan balance</label><input name="balance" className="num" placeholder="loans only" /></div>
            <div><label>Start</label><input type="date" name="startDate" /></div>
            <div><label>End</label><input type="date" name="endDate" /></div>
            <div style={{ flex: 0 }}><button>Add</button></div>
          </div>
        </ActionForm>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Leave balances {year}</h2>
        <table><thead><tr><th>Leave</th><th className="num">Credits</th><th className="num">Used</th><th className="num">Pending</th><th className="num">Available</th>{hr && <th>Set credits</th>}</tr></thead>
          <tbody>{balances.map((b) => (
            <tr key={b.leaveTypeId}><td>{b.code} {b.name}{b.paid ? "" : " (unpaid)"}</td><td className="num">{b.tracked ? b.credits : "-"}</td><td className="num">{b.used}</td><td className="num">{b.pending}</td><td className="num">{b.tracked ? b.available : "-"}</td>
              {hr && <td><ActionForm action={hrSetupAction}><input type="hidden" name="op" value="credit" /><input type="hidden" name="employeeId" value={e.id} /><input type="hidden" name="leaveTypeId" value={b.leaveTypeId} /><input type="hidden" name="year" value={year} />
                <div className="row" style={{ gap: 4 }}><div style={{ minWidth: 70 }}><input name="days" defaultValue={b.credits} className="num" /></div><div style={{ flex: 0 }}><button className="secondary">Set</button></div></div></ActionForm></td>}</tr>
          ))}</tbody></table>
      </div>

      {hr && <div className="card">
        <h2 style={{ marginTop: 0 }}>Employee portal login</h2>
        {login ? <p>Linked to <b>{login.email}</b>. The employee signs in at the normal login page and lands on the portal.</p> : <p className="muted">Not linked yet.</p>}
        <ActionForm action={hrSetupAction}>
          <input type="hidden" name="op" value="login" /><input type="hidden" name="employeeId" value={e.id} />
          <div className="row">
            <div><label>Email</label><input name="email" type="email" defaultValue={login?.email ?? e.email ?? ""} required /></div>
            <div><label>Temporary password (new logins)</label><input name="password" type="text" minLength={8} required /></div>
            <div style={{ flex: 0 }}><button>{login ? "Relink" : "Create login"}</button></div>
          </div>
        </ActionForm>
      </div>}

      <h2>Payslips</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Payroll</th><th>Period</th><th>Status</th><th className="num">Gross</th><th className="num">Tax</th><th className="num">Net</th><th></th></tr></thead>
        <tbody>{slips.map((s) => (
          <tr key={s.id}><td><Link href={`/payroll/${s.runId}`}>{s.run.number}</Link></td><td>{fmtDate(s.run.periodStart)} to {fmtDate(s.run.periodEnd)}</td><td>{s.run.status}</td>
            <td className="num">{peso(s.gross)}</td><td className="num">{peso(s.withholdingTax)}</td><td className="num">{peso(s.netPay)}</td>
            <td><a href={`/api/payroll/pdf?doc=payslip&run=${s.runId}&employee=${e.id}`} target="_blank">PDF</a></td></tr>
        ))}</tbody></table></div>
    </>
  );
}
