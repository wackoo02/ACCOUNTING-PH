// Turns one employee's day (schedule, time logs, approved requests, holidays) into payable minutes.
// Pure functions: no database access. All clock times are Philippine time (UTC+8, no daylight saving).
import { NIGHT_END, NIGHT_START, type DayType } from "./rates";

export const PH_OFFSET_MIN = 8 * 60;

export type ShiftDef = {
  start: number;        // minutes from midnight, e.g. 480 = 8:00 AM
  end: number;          // may be smaller than start for a night shift that ends the next day
  breakMinutes: number;
  graceMinutes: number;
  restDays: number[];   // 0 = Sunday ... 6 = Saturday
};

export type DayInput = {
  date: string;                       // YYYY-MM-DD (the day the shift starts)
  shift: ShiftDef | null;             // null = no fixed schedule
  restDay: boolean;
  holidays: ("REGULAR" | "SPECIAL")[];
  timeIn?: Date | null;
  timeOut?: Date | null;
  leave?: { code: string; paid: boolean; fraction: number } | null; // fraction 1 = whole day, 0.5 = half day
  otApprovedMinutes?: number;
};

export type DayResult = {
  date: string;
  dayType: DayType;
  scheduled: boolean;      // a working day under the schedule (not a rest day)
  worked: boolean;
  regularMinutes: number;
  lateMinutes: number;
  undertimeMinutes: number;
  otMinutes: number;
  nightMinutes: number;    // night differential within regular hours
  otNightMinutes: number;  // night differential within overtime
  absentDays: number;     // 1 = whole day absent, 0.5 = half day (half-day leave, no attendance)
  leave: { code: string; paid: boolean; fraction: number } | null;
  unworkedHoliday: "REGULAR" | "DOUBLE" | "SPECIAL" | null;
};

/** Minutes from Manila midnight of `date` to the instant `t`. */
export function manilaMinutes(date: string, t: Date): number {
  const midnight = Date.parse(`${date}T00:00:00Z`) - PH_OFFSET_MIN * 60000;
  return Math.round((t.getTime() - midnight) / 60000);
}

/** The instant for `minutes` after Manila midnight of `date`. */
export function manilaInstant(date: string, minutes: number): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - PH_OFFSET_MIN * 60000 + minutes * 60000);
}

/** Today's date in Manila as YYYY-MM-DD. */
export function manilaToday(now = new Date()): string {
  return new Date(now.getTime() + PH_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function parseClock(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid time "${s}" (use HH:MM)`);
  const v = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Invalid time "${s}"`);
  return v;
}
export const fmtClock = (min: number) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export function dayTypeOf(holidays: ("REGULAR" | "SPECIAL")[], restDay: boolean): DayType {
  const reg = holidays.filter((h) => h === "REGULAR").length;
  const base = reg >= 2 ? "DOUBLE" : reg === 1 ? "REGULAR" : holidays.includes("SPECIAL") ? "SPECIAL" : "ORDINARY";
  if (!restDay) return base;
  return base === "ORDINARY" ? "REST" : (`${base}_REST` as DayType);
}

const overlap = (a1: number, a2: number, b1: number, b2: number) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

/** Night-differential minutes (10 PM - 6 AM) inside [from, to], minutes relative to the day's midnight. */
export function nightMinutes(from: number, to: number): number {
  let n = 0;
  for (let k = -1; k <= 2; k++) n += overlap(from, to, NIGHT_START + (k - 1) * 1440, NIGHT_END + k * 1440);
  return n;
}

export function evaluateDay(d: DayInput): DayResult {
  const dayType = dayTypeOf(d.holidays, d.restDay);
  const scheduled = !d.restDay;
  const res: DayResult = {
    date: d.date, dayType, scheduled, worked: false, regularMinutes: 0, lateMinutes: 0, undertimeMinutes: 0, otMinutes: 0,
    nightMinutes: 0, otNightMinutes: 0, absentDays: 0, leave: d.leave ?? null, unworkedHoliday: null,
  };
  const hasLog = !!(d.timeIn && d.timeOut && d.timeOut > d.timeIn);
  if (!hasLog) {
    if (scheduled && dayType === "ORDINARY") res.absentDays = Math.max(0, 1 - (d.leave?.fraction ?? 0));
    const base = dayTypeOf(d.holidays, false);
    if (base !== "ORDINARY") res.unworkedHoliday = base as "REGULAR" | "DOUBLE" | "SPECIAL";
    return res;
  }
  res.worked = true;
  const tin = manilaMinutes(d.date, d.timeIn!);
  const tout = manilaMinutes(d.date, d.timeOut!);
  const s = d.shift;
  if (!s) {
    // No fixed schedule: up to 8 hours (after break) are regular, approved overtime beyond.
    const span = tout - tin;
    const brk = span > 300 ? 60 : 0;
    res.regularMinutes = Math.min(480, Math.max(0, span - brk));
    const extra = Math.max(0, span - brk - 480);
    res.otMinutes = Math.min(extra, d.otApprovedMinutes ?? 0);
    const regEnd = tin + res.regularMinutes + brk;
    res.nightMinutes = Math.min(res.regularMinutes, nightMinutes(tin, regEnd));
    res.otNightMinutes = nightMinutes(regEnd, regEnd + res.otMinutes);
    return res;
  }
  const S = s.start;
  const E = s.end > s.start ? s.end : s.end + 1440;
  const schedMinutes = Math.max(0, E - S - s.breakMinutes);
  const a = Math.max(tin, S), b = Math.min(tout, E);
  const inside = Math.max(0, b - a);
  const brk = inside > 300 ? s.breakMinutes : Math.max(0, inside - schedMinutes);
  res.regularMinutes = Math.min(schedMinutes, Math.max(0, inside - brk));
  if (scheduled) {
    res.lateMinutes = tin > S + s.graceMinutes ? Math.min(tin - S, schedMinutes) : 0;
    res.undertimeMinutes = tout < E ? Math.min(E - tout, schedMinutes) : 0;
    // A half-day leave covers the missing half; don't also charge it as late/undertime.
    if (d.leave && d.leave.fraction > 0 && d.leave.fraction < 1) {
      const covered = Math.round(schedMinutes * d.leave.fraction);
      const short = res.lateMinutes + res.undertimeMinutes;
      const left = Math.max(0, short - covered);
      if (res.lateMinutes >= res.undertimeMinutes) { res.lateMinutes = Math.min(res.lateMinutes, left); res.undertimeMinutes = Math.max(0, left - res.lateMinutes); }
      else { res.undertimeMinutes = Math.min(res.undertimeMinutes, left); res.lateMinutes = Math.max(0, left - res.undertimeMinutes); }
    }
  }
  const after = Math.max(0, tout - E), before = Math.max(0, S - tin);
  res.otMinutes = Math.min(after + before, d.otApprovedMinutes ?? 0);
  res.nightMinutes = Math.min(res.regularMinutes, nightMinutes(a, b));
  const otAfter = Math.min(after, res.otMinutes);
  const otBefore = res.otMinutes - otAfter;
  res.otNightMinutes = nightMinutes(E, E + otAfter) + nightMinutes(S - otBefore, S);
  return res;
}

export type AttendanceSummary = {
  daysScheduled: number;
  daysWorked: number;
  absences: number;
  lateMinutes: number;
  undertimeMinutes: number;
  otMinutes: number;
  nightMinutes: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
};

export function summarize(days: DayResult[]): AttendanceSummary {
  const s: AttendanceSummary = { daysScheduled: 0, daysWorked: 0, absences: 0, lateMinutes: 0, undertimeMinutes: 0, otMinutes: 0, nightMinutes: 0, paidLeaveDays: 0, unpaidLeaveDays: 0 };
  for (const d of days) {
    if (d.scheduled) s.daysScheduled++;
    if (d.worked) s.daysWorked++;
    s.absences += d.absentDays;
    s.lateMinutes += d.lateMinutes; s.undertimeMinutes += d.undertimeMinutes; s.otMinutes += d.otMinutes;
    s.nightMinutes += d.nightMinutes + d.otNightMinutes;
    if (d.leave) { if (d.leave.paid) s.paidLeaveDays += d.leave.fraction; else s.unpaidLeaveDays += d.leave.fraction; }
  }
  return s;
}
