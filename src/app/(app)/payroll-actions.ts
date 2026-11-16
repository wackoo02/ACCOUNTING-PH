"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCtx, hashPassword } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { LedgerError } from "@/lib/ledger/service";
import {
  addRunAdjustment, computeRun, createRun, deleteRunAdjustment, finalizeRun, recordPayment, releasePayslips, returnRun, savePayItem, setReviewed, submitRun, voidRun,
} from "@/lib/payroll/service";
import { generate2316, set2316Status } from "@/lib/payroll/bir2316";
import {
  cancelRequest, clock, createPortalLogin, createRequest, decideRequest, deleteHoliday, ensureHrSetup, grantLeaveCredits, loadNationalHolidays,
  saveEmployeeHr, saveHoliday, saveShift, saveTimeLog, setLeaveCredit, type RequestInput,
} from "@/lib/hr/service";

export type FormState = { errors?: string[]; message?: string } | undefined;

function fail(e: unknown): FormState {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && (e.message.startsWith("You do not have permission") || e.message.startsWith("Invalid time"))) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const b = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";

// ---------- Payroll runs ----------

export async function newRunAction(_: FormState, fd: FormData): Promise<FormState> {
  let id = "";
  try {
    const ctx = await requireCtx("payroll.process");
    const run = await createRun(ctx.org.id, ctx.user.id, {
      kind: s(fd, "kind") as "REGULAR", frequency: s(fd, "frequency") as "SEMI_MONTHLY", periodStart: s(fd, "periodStart"), periodEnd: s(fd, "periodEnd"), payDate: s(fd, "payDate"),
      deductContributions: s(fd, "deductContributions") === "true" ? true : s(fd, "deductContributions") === "false" ? false : undefined, yearEndAdjustment: b(fd, "yearEndAdjustment"), memo: s(fd, "memo"),
    });
    id = run.id;
  } catch (e) { return fail(e); }
  redirect(`/payroll/${id}`);
}

export async function runAction(_: FormState, fd: FormData): Promise<FormState> {
  const id = s(fd, "id"), op = s(fd, "op");
  let msg = "";
  try {
    if (op === "compute") { const c = await requireCtx("payroll.process"); const n = await computeRun(c.org.id, c.user.id, id); msg = `Computed ${n} payslip(s).`; }
    else if (op === "submit") { const c = await requireCtx("payroll.process"); await submitRun(c.org.id, c.user.id, id); msg = "Submitted for review."; }
    else if (op === "review" || op === "unreview") {
      const c = await requireCtx("payroll.approve");
      const ids = fd.getAll("slip").map(String);
      await setReviewed(c.org.id, c.user.id, id, fd.get("all") ? "all" : ids, op === "review");
      msg = op === "review" ? "Marked reviewed." : "Review mark removed.";
    }
    else if (op === "return") { const c = await requireCtx("payroll.approve"); await returnRun(c.org.id, c.user.id, id, s(fd, "reason")); msg = "Returned to the preparer."; }
    else if (op === "finalize") { const c = await requireCtx("payroll.approve"); const r = await finalizeRun(c.org.id, c.user.id, id); msg = `Finalized. Payroll accrual posted to the GL as ${r.journal.number}.`; }
    else if (op === "release") { const c = await requireCtx("payroll.approve"); await releasePayslips(c.org.id, c.user.id, id); msg = "Payslips released to the employee portal."; }
    else if (op === "pay") { const c = await requireCtx("payroll.approve"); const je = await recordPayment(c.org.id, c.user.id, id, s(fd, "bankAccountId"), s(fd, "date")); msg = `Salary payment posted as ${je.number}.`; }
    else if (op === "void") { const c = await requireCtx("payroll.approve"); await voidRun(c.org.id, c.user.id, id, s(fd, "reason")); msg = "Payroll voided."; }
    else if (op === "adjust") {
      const c = await requireCtx("payroll.process");
      const [kind, category] = s(fd, "type").split(":");
      await addRunAdjustment(c.org.id, c.user.id, id, { employeeId: s(fd, "employeeId"), kind, category, name: s(fd, "name"), amount: s(fd, "amount"), deMinimisCode: s(fd, "deMinimisCode") || null });
      msg = "Adjustment added. Compute again to include it.";
    }
    else if (op === "unadjust") { const c = await requireCtx("payroll.process"); await deleteRunAdjustment(c.org.id, c.user.id, id, s(fd, "itemId")); msg = "Adjustment removed. Compute again."; }
  } catch (e) { return fail(e); }
  revalidatePath(`/payroll/${id}`);
  return { message: msg };
}

export async function payItemAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("payroll.process");
    const [kind, category] = s(fd, "type").split(":");
    await savePayItem(c.org.id, c.user.id, {
      id: s(fd, "id") || undefined, employeeId: s(fd, "employeeId"), kind, category, name: s(fd, "name"), amount: s(fd, "amount"), balance: s(fd, "balance"),
      deMinimisCode: s(fd, "deMinimisCode") || null, startDate: s(fd, "startDate"), endDate: s(fd, "endDate"), isActive: fd.get("isActive") === null ? true : b(fd, "isActive"),
    });
  } catch (e) { return fail(e); }
  revalidatePath(`/payroll/employees/${s(fd, "employeeId")}`);
  return { message: "Saved." };
}

export async function form2316Action(_: FormState, fd: FormData): Promise<FormState> {
  let msg = "";
  try {
    const c = await requireCtx("payroll.approve");
    const op = s(fd, "op");
    if (op === "generate") msg = `Prepared ${await generate2316(c.org.id, c.user.id, Number(s(fd, "year")))} draft form(s).`;
    else {
      const ids = fd.getAll("formId").map(String);
      for (const id of ids) await set2316Status(c.org.id, c.user.id, id, op as "finalize");
      msg = `${ids.length} form(s) updated.`;
    }
  } catch (e) { return fail(e); }
  revalidatePath("/payroll/2316");
  return { message: msg };
}

// ---------- HR setup ----------

export async function hrSetupAction(_: FormState, fd: FormData): Promise<FormState> {
  let msg = "";
  try {
    const c = await requireCtx("hr.manage");
    const op = s(fd, "op");
    if (op === "defaults") { await ensureHrSetup(c.org.id, new Date().getUTCFullYear()); msg = "Default shifts, leave types and holidays are set up."; }
    else if (op === "holidays") { const r = await loadNationalHolidays(c.org.id, c.user.id, Number(s(fd, "year"))); msg = `${r.proclaimed ? "Loaded the proclaimed" : "Loaded the computed (not yet proclaimed)"} national holidays. Add Eid'l Fitr / Eid'l Adha and local holidays manually.`; }
    else if (op === "holiday") { await saveHoliday(c.org.id, c.user.id, { date: s(fd, "date"), name: s(fd, "name"), type: s(fd, "type") }); msg = "Holiday saved."; }
    else if (op === "delholiday") { await deleteHoliday(c.org.id, c.user.id, s(fd, "holidayId")); msg = "Holiday removed."; }
    else if (op === "shift") {
      await saveShift(c.org.id, c.user.id, { id: s(fd, "shiftId") || undefined, code: s(fd, "code"), name: s(fd, "name"), startTime: s(fd, "startTime"), endTime: s(fd, "endTime"), breakMinutes: Number(s(fd, "breakMinutes")), graceMinutes: Number(s(fd, "graceMinutes")), restDays: fd.getAll("restDay").map(String).join(","), isActive: fd.get("isActive") === null ? true : b(fd, "isActive") });
      msg = "Shift saved.";
    }
    else if (op === "grant") { const n = await grantLeaveCredits(c.org.id, c.user.id, Number(s(fd, "year"))); msg = `Granted ${n} leave credit(s).`; }
    else if (op === "credit") { await setLeaveCredit(c.org.id, c.user.id, s(fd, "employeeId"), s(fd, "leaveTypeId"), Number(s(fd, "year")), Number(s(fd, "days"))); msg = "Leave credit saved."; }
    else if (op === "employee") {
      await saveEmployeeHr(c.org.id, c.user.id, s(fd, "employeeId"), {
        shiftId: s(fd, "shiftId"), managerId: s(fd, "managerId"), workDaysPerYear: Number(s(fd, "workDaysPerYear")), minimumWageEarner: b(fd, "minimumWageEarner"),
        costCenter: s(fd, "costCenter"), bankAccountNo: s(fd, "bankAccountNo"), separationDate: s(fd, "separationDate") || null,
      });
      msg = "Employee HR settings saved.";
    }
    else if (op === "login") {
      const r = await createPortalLogin(c.org.id, c.user.id, s(fd, "employeeId"), s(fd, "email"), s(fd, "password"), hashPassword);
      msg = r.existed ? "Linked to the existing login. The employee signs in with their current password." : "Portal login created. Give the employee the email and temporary password.";
    }
    else if (op === "timelog") { await saveTimeLog(c.org.id, c.user.id, { employeeId: s(fd, "employeeId"), date: s(fd, "date"), timeIn: s(fd, "timeIn"), timeOut: s(fd, "timeOut"), note: s(fd, "note") }); msg = "Time log saved."; }
  } catch (e) { return fail(e); }
  revalidatePath("/hr");
  revalidatePath("/payroll/employees");
  return { message: msg };
}

// ---------- Employee portal ----------

export async function clockAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx(undefined, { portal: true });
    const op = s(fd, "op") === "out" ? "out" : "in";
    await clock(c.org.id, c.user.id, op);
    revalidatePath("/portal");
    return { message: op === "in" ? "Time in recorded." : "Time out recorded." };
  } catch (e) { return fail(e); }
}

export async function requestAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx(undefined, { portal: true });
    const input: RequestInput = {
      type: s(fd, "type") as RequestInput["type"], dateFrom: s(fd, "dateFrom"), dateTo: s(fd, "dateTo") || undefined, leaveTypeId: s(fd, "leaveTypeId"), halfDay: b(fd, "halfDay"),
      hours: Number(s(fd, "hours")), timeIn: s(fd, "timeIn"), timeOut: s(fd, "timeOut"), shiftId: s(fd, "shiftId"), restDay: b(fd, "restDay"), reason: s(fd, "reason"),
    };
    // HR can file on behalf of an employee.
    const forEmployee = s(fd, "employeeId");
    if (forEmployee && !can(c.role, "hr.manage")) return { errors: ["Only HR can file for another employee"] };
    const r = await createRequest(c.org.id, c.user.id, input, forEmployee || undefined);
    revalidatePath("/portal");
    return { message: `Request ${r.number} sent ${r.approverId ? "to your reporting manager" : "to HR"} for approval.` };
  } catch (e) { return fail(e); }
}

export async function decideAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx(undefined, { portal: true });
    const op = s(fd, "op");
    if (op === "cancel") { await cancelRequest(c.org.id, c.user.id, s(fd, "requestId")); revalidatePath("/portal"); return { message: "Request cancelled." }; }
    const r = await decideRequest(c.org.id, c.user.id, can(c.role, "hr.manage"), s(fd, "requestId"), op === "approve", s(fd, "remarks"));
    revalidatePath("/portal"); revalidatePath("/hr/requests");
    return { message: `${r.number} ${op === "approve" ? "approved" : "rejected"}.` };
  } catch (e) { return fail(e); }
}
