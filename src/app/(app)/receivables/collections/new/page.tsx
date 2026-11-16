import { requireCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { today } from "@/lib/format";
import { receiptFormData } from "@/lib/ar/form-data";
import { ReceiptForm } from "@/components/ReceiptForm";

export default async function NewCollection({ searchParams }: { searchParams: Promise<{ customer?: string; invoice?: string }> }) {
  const ctx = await requireCtx("journal.create");
  const sp = await searchParams;
  const data = await receiptFormData(ctx.org.id);
  const inv = data.invoices.find((i) => i.id === sp.invoice);
  const cust = data.customers.find((c) => c.id === (inv?.customerId ?? sp.customer));
  const bank = data.banks.find((b) => b.currencyCode === (cust?.currencyCode ?? data.baseCurrency)) ?? data.banks[0];
  const wht = inv && inv.total ? Math.round(((inv.ewt * inv.open) / inv.total) * 100) / 100 : 0;
  return (
    <>
      <div className="top"><h1>Record Collection</h1></div>
      {data.banks.length === 0 && <div className="notice">Set up a bank or cash account (Master Lists → Bank and Cash Accounts) first.</div>}
      <ReceiptForm data={data} canPost={can(ctx.role, "journal.post")} initial={{
        customerId: cust?.id ?? "", date: today(), bankAccountId: bank?.id ?? "", method: "CHECK", checkNo: "", checkDate: "", checkBank: "", reference: "", memo: "",
        fxRate: bank && bank.currencyCode !== data.baseCurrency ? "" : "1",
        cashAmount: inv ? (inv.open - wht).toFixed(2) : "", withholdingTaxCodeId: wht ? inv?.ewtTaxCodeId ?? "" : "", withholdingAmount: wht ? wht.toFixed(2) : "",
        applications: inv ? { [inv.id]: inv.open.toFixed(2) } : {},
      }} />
    </>
  );
}
