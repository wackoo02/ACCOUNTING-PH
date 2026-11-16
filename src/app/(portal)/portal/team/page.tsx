import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { RequestList } from "@/components/HrRequests";
import { attendanceFor, employeeName, teamOf } from "@/lib/hr/service";
import { summarize, manilaToday } from "@/lib/payroll/attendance";

export default async function Team({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await requireCtx(undefined, { portal: true });
  const me = await prisma.employee.findFirst({ where: { organizationId: ctx.org.id, userId: ctx.user.id } });
  if (!me) return <div className="card">Your login is not linked to an employee record.</div>;
  const ids = await teamOf(ctx.org.id, me.id);
  const sp = await searchParams;
  const t = manilaToday();
  const from = sp.from ?? `${t.slice(0, 8)}01`, to = sp.to ?? t, year = t.slice(0, 4);
  const [pending, recent, emps, att] = await Promise.all([
    prisma.hrRequest.findMany({ where: { organizationId: ctx.org.id, employeeId: { in: ids }, status: "PENDING" }, include: { employee: true }, orderBy: { createdAt: "asc" } }),
    prisma.hrRequest.findMany({ where: { organizationId: ctx.org.id, employeeId: { in: ids }, status: { not: "PENDING" } }, include: { employee: true }, orderBy: { decidedAt: "desc" }, take: 30 }),
    prisma.employee.findMany({ where: { id: { in: ids } }, orderBy: { code: "asc" } }),
    attendanceFor(ctx.org.id, ids, from, to),
  ]);
  return (
    <>
      <div className="top"><h1>My team</h1>
        <div className="row" style={{ flex: 0, flexWrap: "nowrap", gap: 8 }}>
          <a className="btn secondary" target="_blank" href={`/api/payroll/pdf?doc=attendance&scope=team&from=${from}&to=${to}`}>Team attendance (PDF)</a>
          <a className="btn secondary" target="_blank" href={`/api/payroll/pdf?doc=leave&scope=team&year=${year}`}>Team leave (PDF)</a>
        </div></div>
      <h2>Waiting for your approval ({pending.length})</h2>
      <RequestList organizationId={ctx.org.id} requests={pending} canDecide />
      <h2>Attendance {from} to {to}</h2>
      <form className="row" style={{ marginBottom: 8 }}><div><input type="date" name="from" defaultValue={from} /></div><div><input type="date" name="to" defaultValue={to} /></div><div style={{ flex: 0 }}><button className="secondary">Show</button></div></form>
      <div className="table-wrap"><table>
        <thead><tr><th>Employee</th><th className="num">Worked</th><th className="num">Absent</th><th className="num">Leave</th><th className="num">Late (min)</th><th className="num">Undertime (min)</th><th className="num">OT (hr)</th><th className="num">Night (hr)</th></tr></thead>
        <tbody>{emps.map((e) => { const s = summarize(att.get(e.id)!.days); return (
          <tr key={e.id}><td>{e.code} {employeeName(e)}</td><td className="num">{s.daysWorked}</td><td className="num">{s.absences}</td><td className="num">{s.paidLeaveDays + s.unpaidLeaveDays}</td><td className="num">{s.lateMinutes}</td><td className="num">{s.undertimeMinutes}</td><td className="num">{(s.otMinutes / 60).toFixed(2)}</td><td className="num">{(s.nightMinutes / 60).toFixed(2)}</td></tr>
        ); })}</tbody>
      </table></div>
      <h2>Recently decided</h2>
      <RequestList organizationId={ctx.org.id} requests={recent} />
    </>
  );
}
