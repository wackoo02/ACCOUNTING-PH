import { notFound, redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { receiptFormData } from "@/lib/ar/form-data";
import { ReceiptForm } from "@/components/ReceiptForm";

export default async function EditCollection({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.create");
  const { id } = await params;
  const r = await prisma.arReceipt.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!r) notFound();
  if (r.status !== "DRAFT") redirect(`/receivables/collections/${id}`);
  const data = await receiptFormData(ctx.org.id);
  const plan = r.plan as { invoiceId: string; amount: string }[];
  return (
    <>
      <div className="top"><h1>Edit draft collection</h1></div>
      {r.rejectReason && <div className="errors">Returned by the approver: {r.rejectReason}</div>}
      <ReceiptForm data={data} canPost={can(ctx.role, "journal.post")} initial={{
        id: r.id, customerId: r.customerId, date: fmtDate(r.date), bankAccountId: r.bankAccountId, method: r.method, checkNo: r.checkNo ?? "", checkDate: r.checkDate ? fmtDate(r.checkDate) : "",
        checkBank: r.checkBank ?? "", reference: r.reference ?? "", memo: r.memo ?? "", fxRate: r.fxRate.toString(), cashAmount: r.cashAmount.toString(),
        withholdingTaxCodeId: r.withholdingTaxCodeId ?? "", withholdingAmount: r.withholdingAmount.toString() === "0" ? "" : r.withholdingAmount.toString(),
        applications: Object.fromEntries(plan.map((p) => [p.invoiceId, p.amount])),
      }} />
    </>
  );
}
