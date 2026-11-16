import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { apFormData } from "@/lib/ap/form-data";
import { blankHeader } from "@/lib/ap/view";
import { DocForm } from "@/components/ap/DocForm";

export default async function NewPo() {
  const ctx = await requireCtx("journal.create");
  const [data, org] = await Promise.all([apFormData(ctx.org.id), prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } })]);
  return (<><div className="top"><h1>New Purchase Order</h1></div>
    <DocForm mode="PO" data={data} initial={blankHeader({ deliverTo: org.registeredAddress ?? "" })} initialLines={[]} /></>);
}
