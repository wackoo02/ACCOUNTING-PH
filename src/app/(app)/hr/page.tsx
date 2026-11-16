import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { fmtDate } from "@/lib/format";
import { manilaToday } from "@/lib/payroll/attendance";
import { hrSetupAction } from "../payroll-actions";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HTYPE: Record<string, string> = { REGULAR: "Regular holiday", SPECIAL: "Special non-working day", SPECIAL_WORKING: "Special working day" };

export default async function HrSetup({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const ctx = await requireCtx("hr.manage");
  const year = Number((await searchParams).year ?? manilaToday().slice(0, 4));
  const [shifts, holidays, types] = await Promise.all([
    prisma.shift.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } }),
    prisma.holiday.findMany({ where: { organizationId: ctx.org.id, date: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) } }, orderBy: { date: "asc" } }),
    prisma.leaveType.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } }),
  ]);
  const empty = shifts.length === 0 && types.length === 0;
  return (
    <>
      <div className="top"><h1>HR Setup: Schedules, Holidays and Leave</h1></div>
      {empty && <div className="card"><p style={{ marginTop: 0 }}>Start with the standard setup: day, mid and night shifts, Philippine leave types (VL, SL, EL, SIL, maternity, paternity, solo parent, VAWC, special leave for women, bereavement) and this year's national holidays.</p>
        <ActionForm action={hrSetupAction}><input type="hidden" name="op" value="defaults" /><button>Set up defaults</button></ActionForm></div>}

      <h2>Work schedules (shifts)</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Name</th><th>Start</th><th>End</th><th>Break (min)</th><th>Grace (min)</th><th>Rest days</th><th>Active</th></tr></thead>
        <tbody>{shifts.map((s) => <tr key={s.id}><td>{s.code}</td><td>{s.name}</td><td>{s.startTime}</td><td>{s.endTime}{s.endTime < s.startTime ? " (next day)" : ""}</td><td>{s.breakMinutes}</td><td>{s.graceMinutes}</td><td>{s.restDays.split(",").filter(Boolean).map((d) => DAYS[Number(d)]).join(", ")}</td><td>{s.isActive ? "Yes" : "No"}</td></tr>)}</tbody>
      </table></div>
      <div className="card" style={{ marginTop: 10 }}>
        <ActionForm action={hrSetupAction}>
          <input type="hidden" name="op" value="shift" />
          <div className="row">
            <div><label>Existing shift to edit</label><select name="shiftId" defaultValue=""><option value="">(new shift)</option>{shifts.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}</select></div>
            <div><label>Code</label><input name="code" required placeholder="DAY" /></div>
            <div><label>Name</label><input name="name" required placeholder="Day shift 8-5" /></div>
            <div><label>Start</label><input type="time" name="startTime" defaultValue="08:00" required /></div>
            <div><label>End</label><input type="time" name="endTime" defaultValue="17:00" required /></div>
            <div><label>Break (min)</label><input name="breakMinutes" type="number" defaultValue={60} /></div>
            <div><label>Grace (min)</label><input name="graceMinutes" type="number" defaultValue={5} /></div>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <div><label>Rest days</label>{DAYS.map((d, i) => <label key={d} style={{ display: "inline-block", marginRight: 10 }}><input type="checkbox" name="restDay" value={i} defaultChecked={i === 0 || i === 6} style={{ width: "auto" }} /> {d}</label>)}</div>
            <div style={{ flex: 0 }}><button>Save shift</button></div>
          </div>
          <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>A shift that ends earlier than it starts (e.g. 22:00 to 07:00) is a night shift ending the next day. Hours between 10 PM and 6 AM get the 10% night differential.</p>
        </ActionForm>
      </div>

      <h2>Holidays {year}</h2>
      <div className="card">
        <div className="row">
          <ActionForm action={hrSetupAction} style={{ flex: 1 }}><input type="hidden" name="op" value="holidays" />
            <div className="row"><div><label>Auto-update: load national holidays for</label><input name="year" type="number" defaultValue={year} /></div><div style={{ flex: 0 }}><button>Load</button></div></div></ActionForm>
          <form style={{ flex: 0 }}><div className="row"><div><label>Show year</label><input name="year" type="number" defaultValue={year} style={{ width: 100 }} /></div><div style={{ flex: 0 }}><button className="secondary">Show</button></div></div></form>
        </div>
        <ActionForm action={hrSetupAction} style={{ marginTop: 10 }}><input type="hidden" name="op" value="holiday" />
          <div className="row">
            <div><label>Date</label><input type="date" name="date" required /></div>
            <div><label>Name</label><input name="name" required placeholder="e.g. Eid'l Fitr, City charter day" /></div>
            <div><label>Type</label><select name="type">{Object.entries(HTYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div style={{ flex: 0 }}><button>Add holiday</button></div>
          </div>
        </ActionForm>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Day</th><th>Holiday</th><th>Type</th><th>Source</th><th></th></tr></thead>
        <tbody>{holidays.map((h) => (
          <tr key={h.id}><td>{fmtDate(h.date)}</td><td>{DAYS[h.date.getUTCDay()]}</td><td>{h.name}</td><td>{HTYPE[h.type] ?? h.type}</td><td>{h.source === "AUTO" ? "National list" : "Manual"}</td>
            <td><ActionForm action={hrSetupAction} confirm="Remove this holiday?"><input type="hidden" name="op" value="delholiday" /><input type="hidden" name="holidayId" value={h.id} /><button className="link">Remove</button></ActionForm></td></tr>
        ))}{holidays.length === 0 && <tr><td colSpan={6} className="muted">No holidays for {year}. Load the national list above.</td></tr>}</tbody>
      </table></div>

      <h2>Leave types</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Code</th><th>Leave</th><th>Paid</th><th className="num">Days per year</th><th>Balance checked</th><th>Basis</th></tr></thead>
        <tbody>{types.map((t) => <tr key={t.id}><td>{t.code}</td><td>{t.name}</td><td>{t.paid ? "Yes" : "No"}</td><td className="num">{Number(t.annualCredits)}</td><td>{t.requiresBalance ? "Yes" : "No"}</td><td className="muted">{t.description}</td></tr>)}</tbody>
      </table></div>
      <div className="card" style={{ marginTop: 10 }}>
        <ActionForm action={hrSetupAction}><input type="hidden" name="op" value="grant" />
          <div className="row"><div><label>Grant yearly leave credits to all active employees for</label><input name="year" type="number" defaultValue={year} /></div><div style={{ flex: 0 }}><button>Grant credits</button></div></div>
          <p className="muted" style={{ marginBottom: 0, fontSize: 12 }}>Only adds credits an employee doesn't have yet for that year. Adjust individual credits on the employee's page.</p>
        </ActionForm>
      </div>
    </>
  );
}
