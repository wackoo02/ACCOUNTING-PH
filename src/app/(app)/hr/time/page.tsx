import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { DtrTable } from "@/components/HrRequests";
import { attendanceFor, employeeName } from "@/lib/hr/service";
import { manilaToday } from "@/lib/payroll/attendance";
import { hrSetupAction } from "../../payroll-actions";

export default async function TimeRecords({ searchParams }: { searchParams: Promise<{ employee?: string; from?: string; to?: string }> }) {
  const ctx = await requireCtx("hr.manage");
  const sp = await searchParams;
  const t = manilaToday();
  const from = sp.from ?? `${t.slice(0, 8)}01`, to = sp.to ?? t;
  const emps = await prisma.employee.findMany({ where: { organizationId: ctx.org.id, isActive: true, isPartner: false }, orderBy: { code: "asc" } });
  const emp = emps.find((e) => e.id === sp.employee) ?? emps[0];
  const att = emp ? (await attendanceFor(ctx.org.id, [emp.id], from, to)).get(emp.id) : null;
  return (
    <>
      <div className="top"><h1>Time Records</h1>
        {emp && <a className="btn secondary" target="_blank" href={`/api/payroll/pdf?doc=attendance&employees=${emp.id}&from=${from}&to=${to}`}>Daily time record (PDF)</a>}</div>
      <form className="card row noprint">
        <div><label>Employee</label><select name="employee" defaultValue={emp?.id}>{emps.map((e) => <option key={e.id} value={e.id}>{e.code} {employeeName(e)}</option>)}</select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      {emp && att && <>
        <DtrTable days={att.days} />
        <div className="card" style={{ marginTop: 12 }}>
          <h2 style={{ marginTop: 0 }}>Manual time entry / correction (HR)</h2>
          <ActionForm action={hrSetupAction}>
            <input type="hidden" name="op" value="timelog" /><input type="hidden" name="employeeId" value={emp.id} />
            <div className="row">
              <div><label>Date</label><input type="date" name="date" required /></div>
              <div><label>Time in</label><input type="time" name="timeIn" required /></div>
              <div><label>Time out</label><input type="time" name="timeOut" required /></div>
              <div><label>Reason</label><input name="note" required /></div>
              <div style={{ flex: 0 }}><button>Save</button></div>
            </div>
          </ActionForm>
        </div>
      </>}
    </>
  );
}
