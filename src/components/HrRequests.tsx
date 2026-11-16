import type { Employee, HrRequest } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ActionForm } from "./ActionForm";
import { REQUEST_TYPES, employeeName, ymd, type EmployeeAttendance } from "@/lib/hr/service";
import { fmtClock, manilaMinutes } from "@/lib/payroll/attendance";
import { decideAction } from "@/app/(app)/payroll-actions";

const hhmm = (date: string, t: Date | null) => (t ? fmtClock(manilaMinutes(date, t)) : "");

/** Requests with approve / reject (managers, HR) or cancel (the employee's own pending requests). */
export async function RequestList({ organizationId, requests, canDecide, own }: { organizationId: string; requests: (HrRequest & { employee: Employee })[]; canDecide?: boolean; own?: boolean }) {
  const [types, shifts] = await Promise.all([
    prisma.leaveType.findMany({ where: { organizationId } }),
    prisma.shift.findMany({ where: { organizationId } }),
  ]);
  const lt = new Map(types.map((t) => [t.id, t])), sh = new Map(shifts.map((s) => [s.id, s]));
  const detail = (r: HrRequest) => {
    const d = ymd(r.dateFrom);
    if (r.type === "LEAVE") return `${lt.get(r.leaveTypeId ?? "")?.name ?? "Leave"}: ${Number(r.days ?? 0)} day(s)${r.halfDay ? " (half day)" : ""}`;
    if (r.type === "OVERTIME") return `${((r.minutes ?? 0) / 60).toFixed(2)} hour(s)`;
    if (r.type === "TIME_AMENDMENT") return `Correct to ${hhmm(d, r.timeIn)} - ${hhmm(d, r.timeOut)}`;
    return r.restDay ? "Make rest day" : `Change to ${sh.get(r.shiftId ?? "")?.name ?? "shift"}`;
  };
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>No.</th>{!own && <th>Employee</th>}<th>Request</th><th>Dates</th><th>Details</th><th>Reason</th><th>Status</th><th></th></tr></thead>
      <tbody>{requests.map((r) => (
        <tr key={r.id}>
          <td>{r.number}</td>{!own && <td>{r.employee.code} {employeeName(r.employee)}</td>}<td>{REQUEST_TYPES[r.type]}</td>
          <td>{ymd(r.dateFrom)}{+r.dateTo !== +r.dateFrom ? ` to ${ymd(r.dateTo)}` : ""}</td><td>{detail(r)}</td><td>{r.reason}{r.remarks ? <div className="muted">Remarks: {r.remarks}</div> : null}</td>
          <td><span className={`badge ${r.status}`}>{r.status}</span></td>
          <td style={{ minWidth: 220 }}>
            {r.status === "PENDING" && canDecide && (
              <ActionForm action={decideAction}><input type="hidden" name="requestId" value={r.id} />
                <div className="row" style={{ gap: 4 }}><div><input name="remarks" placeholder="Remarks" /></div>
                  <div style={{ flex: 0 }}><button name="op" value="approve">Approve</button></div><div style={{ flex: 0 }}><button name="op" value="reject" className="danger">Reject</button></div></div>
              </ActionForm>
            )}
            {r.status === "PENDING" && own && (
              <ActionForm action={decideAction} confirm="Cancel this request?"><input type="hidden" name="requestId" value={r.id} /><input type="hidden" name="op" value="cancel" /><button className="link">Cancel</button></ActionForm>
            )}
          </td>
        </tr>
      ))}{requests.length === 0 && <tr><td colSpan={8} className="muted">No requests.</td></tr>}</tbody>
    </table></div>
  );
}

export function DtrTable({ days }: { days: EmployeeAttendance["days"] }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Date</th><th>Day type</th><th>Shift</th><th>In</th><th>Out</th><th className="num">Regular hr</th><th className="num">Late</th><th className="num">Undertime</th><th className="num">OT hr</th><th className="num">Night hr</th><th>Remarks</th></tr></thead>
      <tbody>{days.map((d) => (
        <tr key={d.date} style={d.scheduled ? undefined : { background: "#fafbfc" }}>
          <td>{d.date}</td><td>{d.dayType.replace(/_/g, " ").toLowerCase()}</td><td>{d.shiftCode}</td><td>{hhmm(d.date, d.timeIn)}</td><td>{hhmm(d.date, d.timeOut)}</td>
          <td className="num">{d.regularMinutes ? (d.regularMinutes / 60).toFixed(2) : ""}</td><td className="num">{d.lateMinutes || ""}</td><td className="num">{d.undertimeMinutes || ""}</td>
          <td className="num">{d.otMinutes ? (d.otMinutes / 60).toFixed(2) : ""}</td><td className="num">{d.nightMinutes + d.otNightMinutes ? ((d.nightMinutes + d.otNightMinutes) / 60).toFixed(2) : ""}</td>
          <td>{!d.employed ? "not employed" : d.leave ? `${d.leave.code}${d.leave.fraction < 1 ? " half day" : ""}${d.leave.paid ? "" : " (unpaid)"}` : d.absentDays ? <span className="diff-bad">Absent</span> : d.timeIn && !d.timeOut ? "No time out" : ""}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
