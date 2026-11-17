"use client";
import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { MasterPicker } from "@/components/MasterPicker";
import { requestAction } from "@/app/(app)/payroll-actions";

export function RequestForm({ leaveTypes, shifts, today }: { leaveTypes: { id: string; label: string }[]; shifts: { id: string; name: string }[]; today: string }) {
  const [type, setType] = useState("LEAVE");
  const [half, setHalf] = useState(false);
  const [rest, setRest] = useState(false);
  return (
    <ActionForm action={requestAction}>
      <div className="row">
        <div><label>Request</label>
          <select name="type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="LEAVE">Leave</option><option value="OVERTIME">Overtime</option><option value="TIME_AMENDMENT">Time amendment (correct my time)</option><option value="SCHEDULE_CHANGE">Change of shift / schedule</option>
          </select></div>
        {type === "LEAVE" && <div><label>Type of leave</label><MasterPicker name="leaveTypeId" ariaLabel="Type of leave" required defaultValue={leaveTypes[0]?.id} options={leaveTypes.map((l) => ({ value: l.id, label: l.label }))} /></div>}
        <div><label>{type === "LEAVE" || type === "SCHEDULE_CHANGE" ? "From" : "Date"}</label><input type="date" name="dateFrom" defaultValue={today} required /></div>
        {(type === "LEAVE" && !half) || type === "SCHEDULE_CHANGE" ? <div><label>To</label><input type="date" name="dateTo" defaultValue={today} /></div> : null}
        {type === "LEAVE" && <div style={{ flex: 0, minWidth: 110 }}><label><input type="checkbox" name="halfDay" checked={half} onChange={(e) => setHalf(e.target.checked)} style={{ width: "auto" }} /> Half day</label></div>}
        {type === "OVERTIME" && <div><label>Overtime hours</label><input name="hours" type="number" step="0.25" min="0.25" max="16" required /></div>}
        {type === "TIME_AMENDMENT" && <><div><label>Correct time in</label><input type="time" name="timeIn" required /></div><div><label>Correct time out</label><input type="time" name="timeOut" required /></div></>}
        {type === "SCHEDULE_CHANGE" && <>
          <div style={{ flex: 0, minWidth: 130 }}><label><input type="checkbox" name="restDay" checked={rest} onChange={(e) => setRest(e.target.checked)} style={{ width: "auto" }} /> Rest day</label></div>
          {!rest && <div><label>New shift</label><MasterPicker name="shiftId" ariaLabel="New shift" required defaultValue={shifts[0]?.id} options={shifts.map((s) => ({ value: s.id, label: s.name }))} /></div>}
        </>}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <div style={{ flex: 3 }}><label>Reason</label><input name="reason" required /></div>
        <div style={{ flex: 0 }}><button>Send for approval</button></div>
      </div>
    </ActionForm>
  );
}
