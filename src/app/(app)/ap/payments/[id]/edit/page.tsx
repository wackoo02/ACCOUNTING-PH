import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { d10 } from "@/lib/ap/view";
import { PaymentForm } from "@/components/ap/PaymentForm";
import { openBills, payFormProps } from "@/lib/ap/pay-view";

export default async function EditPayment({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.create");
  const { id } = await params;
  const p = await prisma.apPayment.findFirst({ where: { id, organizationId: ctx.org.id, status: "DRAFT" }, include: { lines: true } });
  if (!p) notFound();
  const [props, bills] = await Promise.all([payFormProps(ctx.org.id), openBills(ctx.org.id, p.id)]);
  return (<><div className="top"><h1>Edit {p.number}</h1></div>
    <PaymentForm {...props} bills={bills} initial={{ id: p.id, vendorId: p.vendorId, bankAccountId: p.bankAccountId, date: d10(p.date), method: p.method, checkNo: p.checkNo ?? "", checkDate: d10(p.checkDate), reference: p.reference ?? "", memo: p.memo, fxRate: p.fxRate.toString(), amounts: Object.fromEntries(p.lines.map((l) => [l.billId, l.amount.toString()])) }} /></>);
}
