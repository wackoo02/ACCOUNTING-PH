import { requireCtx } from "@/lib/auth";
import { today } from "@/lib/format";
import { invoiceFormData } from "@/lib/ar/form-data";
import { ContractForm } from "@/components/ContractForm";

export default async function NewContract() {
  const ctx = await requireCtx("journal.create");
  const data = await invoiceFormData(ctx.org.id);
  return (
    <>
      <div className="top"><h1>New Billing Contract</h1></div>
      <ContractForm data={data} initial={{
        kind: "SUBSCRIPTION", name: "", customerId: "", startDate: today(), endDate: "", frequency: "MONTHLY", nextBillDate: "", termsDays: "", contractValue: "",
        pricesIncludeVat: false, ewtTaxCodeId: "", autoSubmit: true, status: "ACTIVE", memo: "", lines: [], milestones: [],
      }} />
    </>
  );
}
