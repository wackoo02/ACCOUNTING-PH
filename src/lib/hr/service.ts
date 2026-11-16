// HR: schedules, holidays, time logs, leave credits and employee requests (leave, overtime,
// time amendment, schedule change) routed to the reporting manager. Approved time feeds payroll.
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { LedgerError, asDay, audit, nextNumber } from "../ledger/service";
import {
  evaluateDay, fmtClock, manilaInstant, manilaMinutes, manilaToday, parseClock, weekday, type DayInput, type DayResult, type ShiftDef,
} from "../payroll/attendance";
import { DEFAULT_LEAVE_TYPES, DEFAULT_SHIFTS, nationalHolidays } from "../payroll/holidays";

type Tx = Prisma.TransactionClient;
const fail = (msg: string): never => { throw new LedgerError([msg]); };
export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 864e5));
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}
export const REQUEST_TYPES: Record<string, string> = {
  LEAVE: "Leave", OVERTIME: "Overtime", TIME_AMENDMENT: "Time amendment", SCHEDULE_CHANGE: "Change of schedule",
};
export const employeeName = (e: { firstName: string; lastName: string; middleName?: string | null }) =>
  `${e.lastName}, ${e.firstName}${e.middleName ? ` ${e.middleName[0]}.` : ""}`;

export function shiftDef(s: { startTime: string; endTime: string; breakMinutes: number; graceMinutes: number; restDays: string }): ShiftDef {
  return {
    start: parseClock(s.startTime), end: parseClock(s.endTime), breakMinutes: s.breakMinutes, graceMinutes: s.graceMinutes,
    restDays: s.restDays.split(",").map((x) => x.trim()).filter(Boolean).map(Number),
  };
}

// ---------- Setup ----------

/** Default shifts, PH leave types and this year's national holidays for a company (only what is missing). */
export async function ensureHrSetup(organizationId: string, year: number) {
  await prisma.$transaction(async (tx) => {
    if ((await tx.shift.count({ where: { organizationId } })) === 0)
      await tx.shift.createMany({ data: DEFAULT_SHIFTS.map((s) => ({ ...s, organizationId })) });
    const have = new Set((await tx.leaveType.findMany({ where: { organizationId }, select: { code: true } })).map((l) => l.code));
    const add = DEFAULT_LEAVE_TYPES.filter((l) => !have.has(l.code));
    if (add.length) await tx.leaveType.createMany({ data: add.map((l) => ({ ...l, organizationId })) });
    if ((await tx.holiday.count({ where: { organizationId, date: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) } } })) === 0)
      await loadHolidaysTx(tx, organizationId, year);
  });
}

async function loadHolidaysTx(tx: Tx, organizationId: string, year: number) {
  const { holidays } = nationalHolidays(year);
  let added = 0;
  for (const h of holidays) {
    const r = await tx.holiday.upsert({
      where: { organizationId_date_name: { organizationId, date: new Date(h.date), name: h.name } },
      create: { organizationId, date: new Date(h.date), name: h.name, type: h.type, source: "AUTO" },
      update: {},
    });
    if (r.source === "AUTO") added++;
  }
  return added;
}

/** Auto-update: load the national holidays for a year (keeps manual entries). */
export async function loadNationalHolidays(organizationId: string, userId: string, year: number) {
  if (year < 2000 || year > 2100) fail("Enter a valid year");
  return prisma.$transaction(async (tx) => {
    const n = await loadHolidaysTx(tx, organizationId, year);
    await audit(tx, organizationId, userId, "holiday.load", String(year), { year, count: n }, null, null, "holiday");
    return { proclaimed: nationalHolidays(year).proclaimed, count: n };
  });
}

export async function saveHoliday(organizationId: string, userId: string, input: { date: string; name: string; type: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) fail("Enter the holiday date");
  if (!input.name.trim()) fail("Enter the holiday name");
  if (!["REGULAR", "SPECIAL", "SPECIAL_WORKING"].includes(input.type)) fail("Choose the holiday type");
  return prisma.$transaction(async (tx) => {
    const h = await tx.holiday.upsert({
      where: { organizationId_date_name: { organizationId, date: new Date(input.date), name: input.name.trim() } },
      create: { organizationId, date: new Date(input.date), name: input.name.trim(), type: input.type, source: "MANUAL" },
      update: { type: input.type, source: "MANUAL" },
    });
    await audit(tx, organizationId, userId, "holiday.save", h.id, null, null, h, "holiday");
    return h;
  });
}

export async function deleteHoliday(organizationId: string, userId: string, id: string) {
  await prisma.$transaction(async (tx) => {
    const h = await tx.holiday.findFirst({ where: { id, organizationId } });
    if (!h) fail("Holiday not found");
    await tx.holiday.delete({ where: { id } });
    await audit(tx, organizationId, userId, "holiday.delete", id, null, h, null, "holiday");
  });
}

export async function saveShift(organizationId: string, userId: string, input: { id?: string; code: string; name: string; startTime: string; endTime: string; breakMinutes: number; graceMinutes: number; restDays: string; isActive?: boolean }) {
  if (!input.code.trim() || !input.name.trim()) fail("Enter the shift code and name");
  parseClock(input.startTime); parseClock(input.endTime);
  const restDays = input.restDays.split(",").map((x) => x.trim()).filter(Boolean);
  if (restDays.some((d) => !/^[0-6]$/.test(d))) fail("Rest days are weekday numbers 0 (Sunday) to 6 (Saturday), separated by commas");
  const data = {
    code: input.code.trim().toUpperCase(), name: input.name.trim(), startTime: input.startTime, endTime: input.endTime,
    breakMinutes: Math.max(0, input.breakMinutes | 0), graceMinutes: Math.max(0, input.graceMinutes | 0), restDays: restDays.join(","), isActive: input.isActive ?? true,
  };
  return prisma.$transaction(async (tx) => {
    const s = input.id
      ? await tx.shift.update({ where: { id: (await tx.shift.findFirstOrThrow({ where: { id: input.id, organizationId } })).id }, data })
      : await tx.shift.create({ data: { ...data, organizationId } });
    await audit(tx, organizationId, userId, "shift.save", s.id, null, null, s, "shift");
    return s;
  });
}

/** Employee HR setup: schedule, reporting manager, pay settings. */
export async function saveEmployeeHr(organizationId: string, userId: string, employeeId: string, input: {
  shiftId?: string | null; managerId?: string | null; workDaysPerYear?: number; minimumWageEarner?: boolean; costCenter?: string | null;
  bankAccountNo?: string | null; separationDate?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.employee.findFirst({ where: { id: employeeId, organizationId } });
    if (!before) fail("Employee not found");
    if (input.managerId === employeeId) fail("An employee cannot report to themselves");
    if (input.managerId) {
      // Prevent reporting loops.
      let m: string | null = input.managerId;
      for (let i = 0; m && i < 50; i++) {
        if (m === employeeId) fail("That manager reports (directly or indirectly) to this employee");
        m = (await tx.employee.findUnique({ where: { id: m }, select: { managerId: true } }))?.managerId ?? null;
      }
    }
    const after = await tx.employee.update({
      where: { id: employeeId },
      data: {
        shiftId: input.shiftId || null, managerId: input.managerId || null,
        // Keep the Mobility app's approver (supervisorCode) in step with the reporting manager.
        supervisorCode: input.managerId ? (await tx.employee.findUnique({ where: { id: input.managerId } }))?.code ?? null : before!.supervisorCode,
        workDaysPerYear: input.workDaysPerYear && input.workDaysPerYear > 0 ? input.workDaysPerYear : before!.workDaysPerYear,
        minimumWageEarner: input.minimumWageEarner ?? before!.minimumWageEarner,
        costCenter: input.costCenter?.trim() || null, bankAccountNo: input.bankAccountNo?.trim() || null,
        separationDate: input.separationDate ? new Date(input.separationDate) : null,
      },
    });
    await audit(tx, organizationId, userId, "employee.hr", employeeId, null, before, after, "employee");
    return after;
  });
}

// ---------- Leave credits and balances ----------

export async function grantLeaveCredits(organizationId: string, userId: string, year: number) {
  return prisma.$transaction(async (tx) => {
    const [emps, types] = await Promise.all([
      tx.employee.findMany({ where: { organizationId, isActive: true } }),
      tx.leaveType.findMany({ where: { organizationId, isActive: true, requiresBalance: true, annualCredits: { gt: 0 } } }),
    ]);
    let n = 0;
    for (const e of emps) for (const t of types) {
      const exists = await tx.leaveCredit.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: e.id, leaveTypeId: t.id, year } } });
      if (exists) continue;
      await tx.leaveCredit.create({ data: { organizationId, employeeId: e.id, leaveTypeId: t.id, year, days: t.annualCredits } });
      n++;
    }
    await audit(tx, organizationId, userId, "leave.grant", String(year), { year, count: n }, null, null, "leave");
    return n;
  }, { timeout: 60_000 });
}

export async function setLeaveCredit(organizationId: string, userId: string, employeeId: string, leaveTypeId: string, year: number, days: number) {
  if (!(days >= 0) || days > 400) fail("Enter the number of days");
  return prisma.$transaction(async (tx) => {
    await tx.employee.findFirstOrThrow({ where: { id: employeeId, organizationId } });
    await tx.leaveType.findFirstOrThrow({ where: { id: leaveTypeId, organizationId } });
    const c = await tx.leaveCredit.upsert({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
      create: { organizationId, employeeId, leaveTypeId, year, days }, update: { days },
    });
    await audit(tx, organizationId, userId, "leave.credit", c.id, { employeeId, leaveTypeId, year, days }, null, null, "leave");
  });
}

export type LeaveBalance = { leaveTypeId: string; code: string; name: string; paid: boolean; tracked: boolean; credits: number; used: number; pending: number; available: number };

export async function leaveBalances(organizationId: string, employeeId: string, year: number, db: Tx | typeof prisma = prisma): Promise<LeaveBalance[]> {
  const [types, credits, reqs] = await Promise.all([
    db.leaveType.findMany({ where: { organizationId, isActive: true }, orderBy: { code: "asc" } }),
    db.leaveCredit.findMany({ where: { employeeId, year } }),
    db.hrRequest.findMany({ where: { employeeId, type: "LEAVE", status: { in: ["PENDING", "APPROVED"] }, dateFrom: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) } } }),
  ]);
  return types.map((t) => {
    const credit = Number(credits.find((c) => c.leaveTypeId === t.id)?.days ?? 0);
    const mine = reqs.filter((r) => r.leaveTypeId === t.id);
    const used = mine.filter((r) => r.status === "APPROVED").reduce((n, r) => n + Number(r.days ?? 0), 0);
    const pending = mine.filter((r) => r.status === "PENDING").reduce((n, r) => n + Number(r.days ?? 0), 0);
    return { leaveTypeId: t.id, code: t.code, name: t.name, paid: t.paid, tracked: t.requiresBalance, credits: credit, used, pending, available: credit - used - pending };
  });
}

// ---------- Time in / time out ----------

async function employeeForUser(organizationId: string, userId: string) {
  const e = await prisma.employee.findFirst({ where: { organizationId, userId }, include: { shift: true } });
  if (!e) fail("Your login is not linked to an employee record. Ask HR to link it.");
  return e!;
}
export { employeeForUser };

/** Clock in or out from the portal. A night shift's time out after midnight closes the open log of the day before. */
export async function clock(organizationId: string, userId: string, action: "in" | "out", now = new Date()) {
  const e = await employeeForUser(organizationId, userId);
  const today = manilaToday(now);
  return prisma.$transaction(async (tx) => {
    if (action === "in") {
      const open = await tx.timeLog.findFirst({ where: { employeeId: e.id, timeOut: null, timeIn: { gte: new Date(now.getTime() - 20 * 3600e3) } } });
      if (open) fail(`You are already clocked in since ${fmtClock(manilaMinutes(ymd(open.date), open.timeIn!))}. Clock out first.`);
      const existing = await tx.timeLog.findUnique({ where: { employeeId_date: { employeeId: e.id, date: new Date(today) } } });
      if (existing?.timeIn) fail("You already have a time in and time out for today. File a time amendment to correct it.");
      const log = existing
        ? await tx.timeLog.update({ where: { id: existing.id }, data: { timeIn: now, source: "PORTAL", updatedById: userId } })
        : await tx.timeLog.create({ data: { organizationId, employeeId: e.id, date: new Date(today), timeIn: now, source: "PORTAL", updatedById: userId } });
      await audit(tx, organizationId, userId, "time.in", log.id, { employee: e.code, at: now.toISOString() }, null, null, "timelog");
      return log;
    }
    const open = await tx.timeLog.findFirst({ where: { employeeId: e.id, timeOut: null, timeIn: { not: null, gte: new Date(now.getTime() - 20 * 3600e3) } }, orderBy: { timeIn: "desc" } });
    if (!open) fail("You have no open time in. Clock in first, or file a time amendment.");
    const log = await tx.timeLog.update({ where: { id: open!.id }, data: { timeOut: now, updatedById: userId } });
    await audit(tx, organizationId, userId, "time.out", log.id, { employee: e.code, at: now.toISOString() }, null, null, "timelog");
    return log;
  });
}

/** HR manual entry / correction of a time log. */
export async function saveTimeLog(organizationId: string, userId: string, input: { employeeId: string; date: string; timeIn: string; timeOut: string; note?: string }) {
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, organizationId } });
  if (!emp) fail("Employee not found");
  const { tin, tout } = clockPair(input.date, input.timeIn, input.timeOut);
  await assertNotInFinalizedPayroll(organizationId, input.date);
  return prisma.$transaction(async (tx) => {
    const before = await tx.timeLog.findUnique({ where: { employeeId_date: { employeeId: input.employeeId, date: new Date(input.date) } } });
    const log = await tx.timeLog.upsert({
      where: { employeeId_date: { employeeId: input.employeeId, date: new Date(input.date) } },
      create: { organizationId, employeeId: input.employeeId, date: new Date(input.date), timeIn: tin, timeOut: tout, source: "MANUAL", note: input.note?.trim() || null, updatedById: userId },
      update: { timeIn: tin, timeOut: tout, source: "MANUAL", note: input.note?.trim() || null, updatedById: userId },
    });
    await audit(tx, organizationId, userId, "time.manual", log.id, { reason: input.note ?? null }, before, log, "timelog");
    return log;
  });
}

/** "08:00" / "17:30" on a date; a time out earlier than the time in is the next day. */
export function clockPair(date: string, timeIn: string, timeOut: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("Enter the date");
  const a = parseClock(timeIn), b = parseClock(timeOut);
  const tin = manilaInstant(date, a);
  const tout = manilaInstant(date, b <= a ? b + 1440 : b);
  if (tout.getTime() - tin.getTime() > 20 * 3600e3) fail("A shift cannot be longer than 20 hours");
  return { tin, tout };
}

async function assertNotInFinalizedPayroll(organizationId: string, date: string) {
  const run = await prisma.payrollRun.findFirst({
    where: { organizationId, kind: "REGULAR", status: "FINALIZED", periodStart: { lte: new Date(date) }, periodEnd: { gte: new Date(date) } },
  });
  if (run) fail(`${date} is in payroll ${run.number}, which is already finalized. Adjust it in the next payroll instead.`);
}

// ---------- Requests ----------

export type RequestInput = {
  type: "LEAVE" | "OVERTIME" | "TIME_AMENDMENT" | "SCHEDULE_CHANGE";
  dateFrom: string; dateTo?: string;
  leaveTypeId?: string; halfDay?: boolean;
  hours?: number;                     // overtime
  timeIn?: string; timeOut?: string;  // time amendment (HH:MM)
  shiftId?: string; restDay?: boolean; // schedule change
  reason: string;
};

/** Working days (per the employee's schedule, excluding holidays) between two dates. */
async function leaveDays(organizationId: string, employeeId: string, from: string, to: string, halfDay: boolean) {
  const sched = await scheduleFor(organizationId, [employeeId], from, to);
  const hol = await holidayMap(organizationId, from, to);
  let n = 0;
  for (const d of eachDay(from, to)) {
    const s = sched.get(employeeId)!(d);
    const h = hol.get(d) ?? [];
    if (!s.restDay && !h.some((x) => x === "REGULAR" || x === "SPECIAL")) n++;
  }
  return halfDay ? Math.min(n, 1) * 0.5 : n;
}

export async function createRequest(organizationId: string, userId: string, input: RequestInput, forEmployeeId?: string) {
  const emp = forEmployeeId
    ? await prisma.employee.findFirst({ where: { id: forEmployeeId, organizationId } })
    : await employeeForUser(organizationId, userId);
  if (!emp) fail("Employee not found");
  const from = input.dateFrom, to = input.dateTo || input.dateFrom;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) fail("Enter the date");
  if (to < from) fail("The end date is before the start date");
  if (eachDay(from, to).length > 120) fail("A request can cover at most 120 days");
  if (!input.reason?.trim()) fail("Enter the reason");
  const data: Prisma.HrRequestUncheckedCreateInput = {
    organizationId, number: "", employeeId: emp!.id, type: input.type, dateFrom: new Date(from), dateTo: new Date(to), reason: input.reason.trim(),
    approverId: emp!.managerId ?? (emp!.supervisorCode ? (await prisma.employee.findFirst({ where: { organizationId, code: emp!.supervisorCode } }))?.id ?? null : null),
    createdById: userId,
  };
  if (input.type === "LEAVE") {
    const lt = await prisma.leaveType.findFirst({ where: { id: input.leaveTypeId ?? "", organizationId, isActive: true } });
    if (!lt) fail("Choose the type of leave");
    if (input.halfDay && from !== to) fail("A half-day leave is for one date only");
    const days = await leaveDays(organizationId, emp!.id, from, to, !!input.halfDay);
    if (days <= 0) fail("Those dates are rest days or holidays: no leave is needed");
    if (lt!.requiresBalance) {
      const bal = (await leaveBalances(organizationId, emp!.id, Number(from.slice(0, 4)))).find((b) => b.leaveTypeId === lt!.id)!;
      if (bal.available < days) fail(`Not enough ${lt!.name} balance: ${bal.available} day(s) available, ${days} requested`);
    }
    const overlap = await prisma.hrRequest.findFirst({ where: { employeeId: emp!.id, type: "LEAVE", status: { in: ["PENDING", "APPROVED"] }, dateFrom: { lte: new Date(to) }, dateTo: { gte: new Date(from) } } });
    if (overlap) fail(`You already have leave request ${overlap.number} on these dates`);
    Object.assign(data, { leaveTypeId: lt!.id, halfDay: !!input.halfDay, days });
  } else if (input.type === "OVERTIME") {
    if (from !== to) fail("File overtime one date at a time");
    const h = Number(input.hours);
    if (!(h > 0 && h <= 16)) fail("Enter the overtime hours (up to 16)");
    Object.assign(data, { minutes: Math.round(h * 60) });
  } else if (input.type === "TIME_AMENDMENT") {
    if (from !== to) fail("File a time amendment one date at a time");
    if (from > manilaToday()) fail("You cannot amend a future date");
    const { tin, tout } = clockPair(from, input.timeIn ?? "", input.timeOut ?? "");
    await assertNotInFinalizedPayroll(organizationId, from);
    Object.assign(data, { timeIn: tin, timeOut: tout });
  } else if (input.type === "SCHEDULE_CHANGE") {
    if (!input.restDay) {
      const sh = await prisma.shift.findFirst({ where: { id: input.shiftId ?? "", organizationId, isActive: true } });
      if (!sh) fail("Choose the new shift");
      Object.assign(data, { shiftId: sh!.id });
    } else Object.assign(data, { restDay: true });
  } else fail("Unknown request type");

  return prisma.$transaction(async (tx) => {
    data.number = await nextNumber(tx, organizationId, "HR", Number(from.slice(0, 4)));
    const r = await tx.hrRequest.create({ data });
    await audit(tx, organizationId, userId, "request.create", r.id, { number: r.number, type: r.type }, null, r, "hr_request");
    return r;
  });
}

/** Can this user decide on the request? The reporting manager (or anyone above), or HR. Never one's own. */
export async function canDecide(organizationId: string, userId: string, hrManager: boolean, r: { employeeId: string; approverId: string | null }) {
  const me = await prisma.employee.findFirst({ where: { organizationId, userId } });
  if (me && me.id === r.employeeId) return false;
  if (hrManager) return true;
  if (!me) return false;
  // Walk up the reporting line from the employee.
  let m = (await prisma.employee.findUnique({ where: { id: r.employeeId }, select: { managerId: true } }))?.managerId ?? null;
  for (let i = 0; m && i < 50; i++) {
    if (m === me.id) return true;
    m = (await prisma.employee.findUnique({ where: { id: m }, select: { managerId: true } }))?.managerId ?? null;
  }
  return false;
}

export async function decideRequest(organizationId: string, userId: string, hrManager: boolean, requestId: string, approve: boolean, remarks?: string) {
  const r = await prisma.hrRequest.findFirst({ where: { id: requestId, organizationId } });
  if (!r) fail("Request not found");
  if (r!.status !== "PENDING") fail(`This request is already ${r!.status.toLowerCase()}`);
  if (!(await canDecide(organizationId, userId, hrManager, r!))) fail("Only the employee's reporting manager or HR can decide on this request");
  if (!approve && !remarks?.trim()) fail("Enter the reason for rejecting");
  if (approve && (r!.type === "TIME_AMENDMENT" || r!.type === "OVERTIME" || r!.type === "LEAVE")) await assertNotInFinalizedPayroll(organizationId, ymd(r!.dateFrom));
  return prisma.$transaction(async (tx) => {
    const after = await tx.hrRequest.update({
      where: { id: r!.id },
      data: { status: approve ? "APPROVED" : "REJECTED", decidedById: userId, decidedAt: new Date(), remarks: remarks?.trim() || null },
    });
    if (approve && r!.type === "TIME_AMENDMENT") {
      await tx.timeLog.upsert({
        where: { employeeId_date: { employeeId: r!.employeeId, date: r!.dateFrom } },
        create: { organizationId, employeeId: r!.employeeId, date: r!.dateFrom, timeIn: r!.timeIn, timeOut: r!.timeOut, source: "AMENDED", note: `${r!.number}: ${r!.reason}`, updatedById: userId },
        update: { timeIn: r!.timeIn, timeOut: r!.timeOut, source: "AMENDED", note: `${r!.number}: ${r!.reason}`, updatedById: userId },
      });
    }
    await audit(tx, organizationId, userId, approve ? "request.approve" : "request.reject", r!.id, { number: r!.number, remarks: remarks ?? null }, r, after, "hr_request");
    return after;
  });
}

export async function cancelRequest(organizationId: string, userId: string, requestId: string) {
  const r = await prisma.hrRequest.findFirst({ where: { id: requestId, organizationId }, include: { employee: true } });
  if (!r) fail("Request not found");
  if (r!.employee.userId !== userId) fail("You can only cancel your own requests");
  if (r!.status !== "PENDING") fail("Only pending requests can be cancelled");
  await prisma.$transaction(async (tx) => {
    await tx.hrRequest.update({ where: { id: r!.id }, data: { status: "CANCELLED", decidedAt: new Date() } });
    await audit(tx, organizationId, userId, "request.cancel", r!.id, { number: r!.number }, null, null, "hr_request");
  });
}

// ---------- Attendance (feeds payroll) ----------

async function holidayMap(organizationId: string, from: string, to: string) {
  const hs = await prisma.holiday.findMany({ where: { organizationId, date: { gte: new Date(from), lte: new Date(to) } } });
  const m = new Map<string, ("REGULAR" | "SPECIAL")[]>();
  for (const h of hs) {
    if (h.type !== "REGULAR" && h.type !== "SPECIAL") continue;
    const k = ymd(h.date);
    m.set(k, [...(m.get(k) ?? []), h.type]);
  }
  return m;
}

/** For each employee, a function giving the schedule of a date (default shift, overridden by approved schedule changes). */
async function scheduleFor(organizationId: string, employeeIds: string[], from: string, to: string) {
  const [emps, shifts, changes] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: employeeIds }, organizationId } }),
    prisma.shift.findMany({ where: { organizationId } }),
    prisma.hrRequest.findMany({ where: { employeeId: { in: employeeIds }, type: "SCHEDULE_CHANGE", status: "APPROVED", dateFrom: { lte: new Date(to) }, dateTo: { gte: new Date(from) } }, orderBy: { decidedAt: "asc" } }),
  ]);
  const byId = new Map(shifts.map((s) => [s.id, s]));
  const out = new Map<string, (d: string) => { shift: ShiftDef | null; restDay: boolean; shiftCode: string | null }>();
  for (const e of emps) {
    const base = e.shiftId ? byId.get(e.shiftId) : undefined;
    const mine = changes.filter((c) => c.employeeId === e.id);
    out.set(e.id, (d: string) => {
      const ch = [...mine].reverse().find((c) => ymd(c.dateFrom) <= d && ymd(c.dateTo) >= d);
      if (ch?.restDay) return { shift: base ? shiftDef(base) : null, restDay: true, shiftCode: "REST" };
      const s = ch?.shiftId ? byId.get(ch.shiftId) : base;
      if (!s) return { shift: null, restDay: weekday(d) === 0, shiftCode: null }; // no schedule: Sunday off
      const def = shiftDef(s);
      // Approved change to a working shift on a normal rest day makes it a working day.
      return { shift: def, restDay: ch?.shiftId ? false : def.restDays.includes(weekday(d)), shiftCode: s.code };
    });
  }
  return out;
}

export type EmployeeAttendance = { employeeId: string; days: (DayResult & { shiftCode: string | null; timeIn: Date | null; timeOut: Date | null; employed: boolean })[] };

/** Day-by-day attendance for employees over a period, from time logs and approved requests. */
export async function attendanceFor(organizationId: string, employeeIds: string[], from: string, to: string): Promise<Map<string, EmployeeAttendance>> {
  const [emps, sched, hol, logs, reqs, leaveTypes] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: employeeIds }, organizationId } }),
    scheduleFor(organizationId, employeeIds, from, to),
    holidayMap(organizationId, from, to),
    prisma.timeLog.findMany({ where: { employeeId: { in: employeeIds }, date: { gte: new Date(from), lte: new Date(to) } } }),
    prisma.hrRequest.findMany({ where: { employeeId: { in: employeeIds }, status: "APPROVED", type: { in: ["LEAVE", "OVERTIME"] }, dateFrom: { lte: new Date(to) }, dateTo: { gte: new Date(from) } } }),
    prisma.leaveType.findMany({ where: { organizationId } }),
  ]);
  const lt = new Map(leaveTypes.map((l) => [l.id, l]));
  const out = new Map<string, EmployeeAttendance>();
  for (const e of emps) {
    const days: EmployeeAttendance["days"] = [];
    const hired = e.dateHired ? ymd(e.dateHired) : null;
    const left = e.separationDate ? ymd(e.separationDate) : null;
    for (const d of eachDay(from, to)) {
      const s = sched.get(e.id)!(d);
      const log = logs.find((l) => l.employeeId === e.id && ymd(l.date) === d);
      const leaveReq = reqs.find((r) => r.employeeId === e.id && r.type === "LEAVE" && ymd(r.dateFrom) <= d && ymd(r.dateTo) >= d);
      const ot = reqs.filter((r) => r.employeeId === e.id && r.type === "OVERTIME" && ymd(r.dateFrom) === d).reduce((n, r) => n + (r.minutes ?? 0), 0);
      const t = leaveReq ? lt.get(leaveReq.leaveTypeId ?? "") : undefined;
      const input: DayInput = {
        date: d, shift: s.shift, restDay: s.restDay, holidays: hol.get(d) ?? [],
        timeIn: log?.timeIn ?? null, timeOut: log?.timeOut ?? null, otApprovedMinutes: ot,
        leave: leaveReq && t && !s.restDay ? { code: t.code, paid: t.paid, fraction: leaveReq.halfDay ? 0.5 : 1 } : null,
      };
      const employed = !(hired && d < hired) && !(left && d > left);
      let r = evaluateDay(input);
      if (!employed) {
        // Before hire / after separation: nothing is paid; monthly-paid salary is reduced for the scheduled days.
        r = { ...evaluateDay({ ...input, timeIn: null, timeOut: null, leave: null, holidays: [] }), unworkedHoliday: null };
      }
      days.push({ ...r, shiftCode: s.shiftCode, timeIn: log?.timeIn ?? null, timeOut: log?.timeOut ?? null, employed });
    }
    out.set(e.id, { employeeId: e.id, days });
  }
  return out;
}

/** Employees a manager approves for: direct and indirect reports. */
export async function teamOf(organizationId: string, managerEmployeeId: string) {
  const all = await prisma.employee.findMany({ where: { organizationId }, select: { id: true, managerId: true } });
  const ids = new Set<string>();
  const walk = (id: string) => { for (const e of all) if (e.managerId === id && !ids.has(e.id)) { ids.add(e.id); walk(e.id); } };
  walk(managerEmployeeId);
  return [...ids];
}

/** Create or reset an employee's portal login (role EMPLOYEE unless the user already has a role in the company). */
export async function createPortalLogin(organizationId: string, adminUserId: string, employeeId: string, email: string, password: string, hashPassword: (p: string) => Promise<string>) {
  const e = await prisma.employee.findFirst({ where: { id: employeeId, organizationId } });
  if (!e) fail("Employee not found");
  const mail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) fail("Enter a valid email address");
  if (password.length < 8) fail("The temporary password must be at least 8 characters");
  const hash = await hashPassword(password);
  return prisma.$transaction(async (tx) => {
    // An existing login (any company) keeps its own password; only new logins get the temporary one.
    let user = await tx.user.findUnique({ where: { email: mail } });
    const existed = !!user;
    if (!user) user = await tx.user.create({ data: { email: mail, name: `${e!.firstName} ${e!.lastName}`, passwordHash: hash } });
    const linked = await tx.employee.findFirst({ where: { organizationId, userId: user.id, NOT: { id: e!.id } } });
    if (linked) fail(`That login is already linked to employee ${linked.code}`);
    const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId } } });
    if (!m) await tx.membership.create({ data: { userId: user.id, organizationId, role: "EMPLOYEE" } });
    await tx.employee.update({ where: { id: e!.id }, data: { userId: user.id, email: e!.email ?? mail } });
    await audit(tx, organizationId, adminUserId, "employee.portal_login", e!.id, { email: mail, existed }, null, null, "employee");
    return { user, existed };
  });
}

export { asDay };
