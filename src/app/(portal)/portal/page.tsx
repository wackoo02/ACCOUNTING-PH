import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { DtrTable, RequestList } from "@/components/HrRequests";
import { attendanceFor, employeeName, leaveBalances, ymd } from "@/lib/hr/service";
import { fmtClock, manilaMinutes, manilaToday } from "@/lib/payroll/attendance";
import { clockAction } from "@/app/(app)/payroll-actions";
import { RequestForm } from "./RequestForm";

const ORDER = ["VL", "SL", "EL", "SIL"];
const order = (c: string) => (ORDER.indexOf(c) + 1 || 99);
const peso = (n: unknown) => Number(n ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function Portal() {
  const ctx = await requireCtx(undefined, { portal: true });
  const me = await prisma.employee.findFirst({ where: { organizationId: ctx.org.id, userId: ctx.user.id }, include: { shift: true, manager: true } });
  if (!me) return <div className="card">Your login is not linked to an employee record yet. Ask HR to link it under Payroll → Employees and Pay.</div>;
  const today = manilaToday();
  const year = Number(today.slice(0, 4));
  const cutoffStart = Number(today.slice(8)) <= 15 ? `${today.slice(0, 8)}01` : `${today.slice(0, 8)}16`;
  const [open, todayLog, balances, requests, leaveTypes, shifts, slips, forms, att] = await Promise.all([
    prisma.timeLog.findFirst({ where: { employeeId: me.id, timeOut: null, timeIn: { not: null, gte: new Date(Date.now() - 20 * 3600e3) } } }),
    prisma.timeLog.findUnique({ where: { employeeId_date: { employeeId: me.id, date: new Date(today) } } }),
    leaveBalances(ctx.org.id, me.id, year),
    prisma.hrRequest.findMany({ where: { employeeId: me.id }, include: { employee: true }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.leaveType.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { code: "asc" } }).then((ls) => ls.sort((a, b) => order(a.code) - order(b.code))),
    prisma.shift.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { code: "asc" } }),
    prisma.payslip.findMany({ where: { employeeId: me.id, run: { status: "FINALIZED", releasedAt: { not: null } } }, include: { run: true }, orderBy: { run: { payDate: "desc" } }, take: 24 }),
    prisma.form2316.findMany({ where: { employeeId: me.id, status: "RELEASED" }, orderBy: { year: "desc" } }),
    attendanceFor(ctx.org.id, [me.id], cutoffStart, today),
  ]);
  const bal = new Map(balances.map((b) => [b.leaveTypeId, b]));
  return (
    <>
      <div className="top"><div><h1>Hi, {me.firstName}</h1><div className="muted">{me.position} · {me.department} · schedule {me.shift?.name ?? "not set"} · reports to {me.manager ? employeeName(me.manager) : "HR"}</div></div></div>
      <div className="grid">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Time in / time out</h2>
          {open ? <p>Clocked in since <b>{fmtClock(manilaMinutes(ymd(open.date), open.timeIn!))}</b> ({ymd(open.date)}).</p>
            : todayLog?.timeOut ? <p>Today: {fmtClock(manilaMinutes(today, todayLog.timeIn!))} to {fmtClock(manilaMinutes(today, todayLog.timeOut))}.</p> : <p className="muted">Not clocked in today.</p>}
          <ActionForm action={clockAction}><input type="hidden" name="op" value={open ? "out" : "in"} /><button style={{ fontSize: 16, padding: "10px 22px" }}>{open ? "Time out" : "Time in"}</button></ActionForm>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>Forgot to clock? File a time amendment below.</p>
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Leave balances {year}</h2>
          <table><tbody>{balances.filter((b) => b.tracked && (b.credits || b.used)).map((b) => <tr key={b.leaveTypeId}><td>{b.code} {b.name}</td><td className="num"><b>{b.available}</b> left</td><td className="muted num">{b.used} used{b.pending ? `, ${b.pending} pending` : ""}</td></tr>)}</tbody></table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>New request</h2>
        <RequestForm today={today} shifts={shifts.map((s) => ({ id: s.id, name: s.name }))}
          leaveTypes={leaveTypes.map((l) => { const b = bal.get(l.id); return { id: l.id, label: `${l.code} ${l.name}${b?.tracked ? ` (${b.available} left)` : ""}` }; })} />
      </div>

      <h2>My requests</h2>
      <RequestList organizationId={ctx.org.id} requests={requests} own />

      <h2>My time this cutoff ({cutoffStart} to {today})</h2>
      <DtrTable days={att.get(me.id)!.days} />
      <p><a href={`/api/payroll/pdf?doc=attendance&from=${cutoffStart}&to=${today}`} target="_blank">Daily time record (PDF)</a> · <a href={`/api/payroll/pdf?doc=leave&year=${year}`} target="_blank">My leave record (PDF)</a></p>

      <h2>Payslips and BIR 2316</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Pay date</th><th>Period</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net pay</th><th></th></tr></thead>
        <tbody>
          {slips.map((s) => <tr key={s.id}><td>{ymd(s.run.payDate)}</td><td>{ymd(s.run.periodStart)} to {ymd(s.run.periodEnd)}</td><td className="num">{peso(s.gross)}</td><td className="num">{peso(Number(s.gross) - Number(s.netPay))}</td><td className="num"><b>{peso(s.netPay)}</b></td><td><a href={`/api/payroll/pdf?doc=payslip&run=${s.runId}`} target="_blank">Payslip (PDF)</a></td></tr>)}
          {forms.map((f) => <tr key={f.id}><td colSpan={5}>BIR Form 2316 for {f.year}</td><td><a href={`/api/payroll/pdf?doc=2316&year=${f.year}`} target="_blank">2316 (PDF)</a></td></tr>)}
          {slips.length + forms.length === 0 && <tr><td colSpan={6} className="muted">Your payslips appear here once payroll releases them.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
