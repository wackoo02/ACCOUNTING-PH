import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { leaseFormData } from "@/lib/leases/form-data";
import { LeaseForm, type LeaseFormValues } from "@/components/LeaseForm";

export default async function EditLease({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.create");
  const { id } = await params;
  const l = await prisma.lease.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!l) notFound();
  const data = await leaseFormData(ctx.org.id);
  const initial: LeaseFormValues = {};
  for (const [k, v] of Object.entries(l)) {
    if (v instanceof Date) initial[k] = v.toISOString().slice(0, 10);
    else if (v === null || typeof v === "string" || typeof v === "boolean") initial[k] = v;
    else if (typeof v === "number" || (v && typeof v === "object" && "toFixed" in v)) initial[k] = String(v);
  }
  initial.dims = (l.dims ?? {}) as Record<string, string | null>;
  if (l.currentLiabilityAccountId === null) initial.currentLiabilityAccountId = "";
  return (
    <>
      <div className="top"><h1>Edit Lease {l.number}</h1></div>
      {l.status !== "DRAFT" ? <div className="errors">Only a draft lease can be edited. Use Modify or Terminate on the lease page.</div> : <LeaseForm data={data} initial={initial} />}
    </>
  );
}
