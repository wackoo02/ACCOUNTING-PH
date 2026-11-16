import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { LoanForm } from "../../LoanForm";
import { loanFormData } from "../../data";

export default async function EditLoan({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("journal.post");
  const { id } = await params;
  const loan = await prisma.loan.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!loan) notFound();
  const [d, used] = await Promise.all([loanFormData(ctx.org.id), prisma.loanTransaction.count({ where: { loanId: id, status: { not: "VOID" } } })]);
  return (<><div className="top"><h1>Edit loan {loan.number}</h1></div><LoanForm {...d} loan={loan} locked={used > 0} /></>);
}
