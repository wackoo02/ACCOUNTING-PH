import { requireCtx } from "@/lib/auth";
import { leaseFormData } from "@/lib/leases/form-data";
import { LeaseForm } from "@/components/LeaseForm";

export default async function NewLease() {
  const ctx = await requireCtx("journal.create");
  const data = await leaseFormData(ctx.org.id);
  return (
    <>
      <div className="top"><h1>New Lease (PFRS 16)</h1></div>
      <div className="notice">Enter the contract terms. Veritus works out the lease liability, the right-of-use asset and the monthly schedule, and shows them before anything posts.</div>
      <LeaseForm data={data} initial={{ exemption: "NONE", currencyCode: data.baseCurrency }} />
    </>
  );
}
