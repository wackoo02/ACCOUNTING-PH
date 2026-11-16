import { requireCtx } from "@/lib/auth";
import { LoanForm } from "../LoanForm";
import { loanFormData } from "../data";

export default async function NewLoan() {
  const ctx = await requireCtx("journal.post");
  const d = await loanFormData(ctx.org.id);
  return (<><div className="top"><h1>New loan</h1></div><LoanForm {...d} locked={false} /></>);
}
