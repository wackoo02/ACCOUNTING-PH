import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { postLeasesAction } from "../../lease-actions";

export default async function PostLeases() {
  const ctx = await requireCtx("journal.post");
  const now = new Date();
  const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).toISOString().slice(0, 10);
  const due = await prisma.leaseScheduleLine.findMany({
    where: { organizationId: ctx.org.id, postedAt: null, lease: { status: "ACTIVE" }, periodEnd: { lte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)) } },
    include: { lease: true }, orderBy: [{ periodEnd: "asc" }], take: 500,
  });
  const a = (v: { toString(): string }) => formatPeso(toCentavos(v.toString()), { blankZero: true });
  return (
    <>
      <div className="top"><h1>Post Lease Entries</h1></div>
      <p>Posts each active lease&apos;s monthly entry up to the date you choose: interest on the lease liability, depreciation of the right-of-use asset (or straight-line rent for short-term and low-value leases), payments falling due to Accounts Payable with VAT and withholding tax, and the current / non-current reclass. Run it at every month-end close.</p>
      <ActionForm action={postLeasesAction} className="card row">
        <div><label>Post through</label><input type="date" name="through" defaultValue={lastMonthEnd} /></div>
        <div style={{ flex: 0 }}><button>Post</button></div>
      </ActionForm>
      <h2>Not yet posted (through this month)</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Month ending</th><th>Lease</th><th>Asset</th><th className="num">Interest</th><th className="num">Depreciation / rent</th><th className="num">Payment due</th></tr></thead>
        <tbody>
          {due.map((r) => <tr key={r.id}><td>{fmtDate(r.periodEnd)}</td><td><Link href={`/leases/${r.leaseId}`}>{r.lease.number}</Link></td><td>{r.lease.assetDescription}</td><td className="num">{a(r.interest)}</td><td className="num">{a(r.depreciation)}</td><td className="num">{a(r.payment)}</td></tr>)}
          {due.length === 0 && <tr><td colSpan={6} className="muted">Everything is posted.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
