import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { apFormData } from "@/lib/ap/form-data";
import { blankHeader, d10, docLine } from "@/lib/ap/view";
import { DocForm } from "@/components/ap/DocForm";

export default async function EditPr({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.create");
  const { id } = await params;
  const pr = await prisma.purchaseRequest.findFirst({ where: { id, organizationId: ctx.org.id, status: "DRAFT" }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!pr) notFound();
  const data = await apFormData(ctx.org.id);
  return (<><div className="top"><h1>Edit {pr.number}</h1></div>
    <DocForm mode="PR" data={data} initial={blankHeader({ id: pr.id, date: d10(pr.date), neededBy: d10(pr.neededBy), purpose: pr.purpose, departmentId: pr.departmentId ?? "", costCenterId: pr.costCenterId ?? "", projectId: pr.projectId ?? "", branchId: pr.branchId ?? "" })}
      initialLines={pr.lines.map((l) => docLine(l))} /></>);
}
