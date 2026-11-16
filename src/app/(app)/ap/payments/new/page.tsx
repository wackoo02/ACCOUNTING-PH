import { requireCtx } from "@/lib/auth";
import { today } from "@/lib/format";
import { openBills, payFormProps } from "@/lib/ap/pay-view";
import { PaymentForm } from "@/components/ap/PaymentForm";

export default async function NewPayment({ searchParams }: { searchParams: Promise<{ vendor?: string; bill?: string }> }) {
  const ctx = await requireCtx("journal.create");
  const sp = await searchParams;
  const [props, bills] = await Promise.all([payFormProps(ctx.org.id), openBills(ctx.org.id)]);
  const bank = props.banks.find((b) => b.kind === "CURRENT" || b.kind === "SAVINGS") ?? props.banks[0];
  const pre = bills.find((b) => b.id === sp.bill);
  return (<><div className="top"><h1>New Payment Voucher</h1></div>
    <PaymentForm {...props} bills={bills} initial={{ vendorId: sp.vendor ?? "", bankAccountId: bank?.id ?? "", date: today(), method: bank?.nextCheckNo ? "CHECK" : "BANK_TRANSFER", checkNo: "", checkDate: "", reference: "", memo: "", fxRate: "1", amounts: pre ? { [pre.id]: pre.open } : {} }} /></>);
}
