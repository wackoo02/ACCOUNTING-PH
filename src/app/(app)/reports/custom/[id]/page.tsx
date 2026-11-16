import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { canDelete, canEdit, canShare, getReport } from "@/lib/reporting/saved";
import { definitionSchema } from "@/lib/reporting/definition";
import { builderLookups } from "@/lib/reporting/lookups";
import { ReportBuilder } from "@/components/reporting/ReportBuilder";
import { prisma } from "@/lib/db";
import { runReportAction } from "../actions";

export default async function SavedCustomReport({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const m = { userId: ctx.user.id, organizationId: ctx.org.id, role: ctx.role };
  const r = await getReport(id, m);
  if (!r) notFound();
  const parsed = definitionSchema.safeParse(r.definition);
  if (!parsed.success) return <div className="errors">This saved report could not be read. Ask its owner to open and save it again.</div>;
  const def = { ...parsed.data, title: parsed.data.title || r.name };
  const [lookups, first, owner] = await Promise.all([
    builderLookups(ctx.user.id, ctx.org.id), runReportAction(def),
    prisma.user.findUnique({ where: { id: r.ownerId }, select: { name: true } }),
  ]);
  return (
    <ReportBuilder key={`${r.id}:${r.updatedAt.getTime()}`} initialDef={def} initialResult={first} lookups={lookups}
      saved={{ id: r.id, name: r.name, description: r.description, visibility: r.visibility, sharedRoles: r.sharedRoles, sharedUserIds: r.sharedUserIds, allowEdit: r.allowEdit,
        editable: canEdit(r, m), deletable: canDelete(r, m), shareable: canShare(r, m), ownerName: owner?.name ?? "Former user", mine: r.ownerId === ctx.user.id }} />
  );
}
