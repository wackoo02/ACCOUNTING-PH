// All payroll and HR reports are delivered as PDF (no spreadsheet export), per the payroll spec.
import { NextResponse, type NextRequest } from "next/server";
import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { LedgerError } from "@/lib/ledger/service";
import { teamOf } from "@/lib/hr/service";
import { manilaToday } from "@/lib/payroll/attendance";
import type { Form2316Data } from "@/lib/payroll/bir2316";
import { attendancePdf, earningsSummaryPdf, form2316Pdf, laborCostPdf, leavePdf, payslipsPdf, registerPdf, taxReportPdf } from "@/lib/payroll/documents";

const deny = () => NextResponse.json({ error: "You do not have access to this document." }, { status: 403 });

export async function GET(req: NextRequest) {
  const ctx = await requireCtx(undefined, { portal: true });
  const q = req.nextUrl.searchParams;
  const doc = q.get("doc") ?? "";
  const org = ctx.org.id;
  const payroll = can(ctx.role, "payroll.process") || can(ctx.role, "payroll.approve");
  const hr = can(ctx.role, "hr.manage");
  const me = await prisma.employee.findFirst({ where: { organizationId: org, userId: ctx.user.id } });
  const today = manilaToday();
  const year = Number(q.get("year") ?? today.slice(0, 4));
  const from = q.get("from") ?? `${today.slice(0, 8)}01`, to = q.get("to") ?? today;
  let bytes: Uint8Array;
  let name = doc;
  try {
    if (doc === "payslip") {
      const runId = q.get("run") ?? "";
      let emp = q.get("employee") ?? undefined;
      if (!payroll) {
        const run = await prisma.payrollRun.findFirst({ where: { id: runId, organizationId: org, status: "FINALIZED", releasedAt: { not: null } } });
        if (!run || !me) return deny();
        emp = me.id;
      }
      bytes = await payslipsPdf(org, runId, emp);
      name = "payslip";
    } else if (doc === "register" && payroll) bytes = await registerPdf(org, q.get("run") ?? "");
    else if (doc === "labor" && payroll) bytes = await laborCostPdf(org, from, to);
    else if (doc === "tax" && payroll) bytes = await taxReportPdf(org, from, to);
    else if (doc === "earnings" && payroll) bytes = await earningsSummaryPdf(org, year);
    else if (doc === "2316") {
      const emp = payroll ? q.get("employee") ?? "" : me?.id ?? "";
      const f = await prisma.form2316.findFirst({ where: { organizationId: org, employeeId: emp, year } });
      if (!payroll && f?.status !== "RELEASED") return deny();
      bytes = await form2316Pdf(org, emp, year, f && f.status !== "DRAFT" ? (f.data as unknown as Form2316Data) : null, f?.status ?? "DRAFT");
      name = `BIR-2316-${year}`;
    } else if (doc === "attendance" || doc === "leave") {
      // HR: anyone. Managers: their team. Employees: themselves.
      let ids = (q.get("employees") ?? "").split(",").filter(Boolean);
      const allowed = hr ? null : new Set([...(me ? [me.id] : []), ...(me ? await teamOf(org, me.id) : [])]);
      if (q.get("scope") === "team" && me) ids = await teamOf(org, me.id);
      if (q.get("scope") === "all" && hr) ids = (await prisma.employee.findMany({ where: { organizationId: org, isActive: true }, select: { id: true } })).map((e) => e.id);
      if (!ids.length && me) ids = [me.id];
      if (allowed) ids = ids.filter((i) => allowed.has(i));
      if (!ids.length) return deny();
      bytes = doc === "attendance" ? await attendancePdf(org, ids, from, to) : await leavePdf(org, ids, year);
    } else return deny();
  } catch (e) {
    if (e instanceof LedgerError) return NextResponse.json({ error: e.errors.join("; ") }, { status: 400 });
    throw e;
  }
  return new NextResponse(Buffer.from(bytes), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${name}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
