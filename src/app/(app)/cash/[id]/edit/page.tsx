import { notFound, redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { cashFormData } from "@/lib/bank/form-data";
import { CashForm, type CashMode } from "@/components/CashForm";
import type { CashLine } from "@/lib/bank/cash";

export default async function EditCash({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.create");
  const { id } = await params;
  const t = await prisma.cashTransaction.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!t) notFound();
  if (t.status !== "DRAFT" || t.isReplenishment) redirect(`/cash/${id}`);
  const data = await cashFormData(ctx.org.id);
  const mode: CashMode = t.number.startsWith("PCV") ? "PETTY" : (t.type as CashMode);
  return (
    <>
      <div className="top"><h1>Edit {t.number}</h1></div>
      {t.rejectReason && <div className="errors">Returned by the approver: {t.rejectReason}</div>}
      <CashForm {...data} mode={mode} canPost={can(ctx.role, "journal.post")} initial={{
        id: t.id, bankAccountId: t.bankAccountId, toBankAccountId: t.toBankAccountId ?? "", date: fmtDate(t.date), payee: t.payee ?? "",
        party: t.partyType && t.partyId ? `${t.partyType}:${t.partyId}` : "", method: t.method, checkNo: t.checkNo ?? "", checkDate: t.checkDate ? fmtDate(t.checkDate) : "",
        reference: t.reference ?? "", memo: t.memo, fxRate: t.fxRate.toString(), amount: t.amount.toString(), toAmount: t.toAmount?.toString() ?? "", toFxRate: t.toFxRate?.toString() ?? "1",
        withholdingTaxCodeId: t.withholdingTaxCodeId ?? "", withholdingAmount: t.withholdingTaxCodeId ? t.withholdingAmount.toString() : "",
        lines: (t.lines as CashLine[]).map((l) => ({ accountId: l.accountId, amount: l.amount, description: l.description ?? "", dims: Object.fromEntries(Object.entries(l.dims ?? {}).map(([k, v]) => [k, v ?? ""])) })),
      }} />
    </>
  );
}
