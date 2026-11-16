"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ReportVisibility, Role } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { runReport } from "@/lib/reporting/run";
import { deleteReport, saveReport } from "@/lib/reporting/saved";
import type { ReportResult } from "@/lib/reporting/result";

export type RunState = { ok: true; result: ReportResult } | { ok: false; errors: string[] };

export async function runReportAction(definition: unknown): Promise<RunState> {
  const ctx = await requireCtx("reports.view");
  try {
    const r = await runReport({ userId: ctx.user.id, currentOrgId: ctx.org.id }, definition);
    return r.ok ? { ok: true, result: r.result } : r;
  } catch (e) {
    console.error(e);
    return { ok: false, errors: ["The report could not be run. Check the filters and try again."] };
  }
}

export type SaveState = { ok: true; id: string; message: string } | { ok: false; errors: string[] };

export async function saveReportAction(input: {
  id?: string | null; asCopy?: boolean; name: string; description?: string; definition: unknown;
  visibility: ReportVisibility; sharedRoles?: Role[]; sharedUserIds?: string[]; allowEdit?: boolean;
}): Promise<SaveState> {
  const ctx = await requireCtx("reports.view");
  const r = await saveReport({ userId: ctx.user.id, organizationId: ctx.org.id, role: ctx.role }, { ...input, id: input.asCopy ? null : input.id });
  if (!r.ok) return r;
  revalidatePath("/reports/custom");
  return { ok: true, id: r.id, message: input.id && !input.asCopy ? "Report saved." : "Report saved to your reports." };
}

export async function deleteReportAction(id: string) {
  const ctx = await requireCtx("reports.view");
  const r = await deleteReport({ userId: ctx.user.id, organizationId: ctx.org.id, role: ctx.role }, id);
  if (!r.ok) return { ok: false as const, errors: r.errors ?? ["Could not delete"] };
  revalidatePath("/reports/custom");
  redirect("/reports/custom");
}
