import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { LEASE_TYPES, STATUS_LABELS } from "@/lib/leases/service";

type SP = Promise<Record<string, string | undefined>>;

export default async function LeaseList({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const where: Prisma.LeaseWhereInput = { organizationId: ctx.org.id };
  if (sp.status) where.status = sp.status;
  if (sp.type) where.leaseType = sp.type;
  if (sp.q) where.OR = [{ number: { contains: sp.q, mode: "insensitive" } }, { lessorName: { contains: sp.q, mode: "insensitive" } }, { assetDescription: { contains: sp.q, mode: "insensitive" } }];
  const leases = await prisma.lease.findMany({ where, orderBy: [{ status: "asc" }, { number: "asc" }] });
  const lastPosted = await prisma.leaseScheduleLine.groupBy({ by: ["leaseId"], where: { organizationId: ctx.org.id, journalEntryId: { not: null } }, _max: { periodEnd: true } });
  const posted = new Map(lastPosted.map((r) => [r.leaseId, r._max.periodEnd]));
  const amt = (v: { toString(): string }) => formatPeso(toCentavos(v.toString()));
  return (
    <>
      <div className="top"><h1>Leases (PFRS 16)</h1>
        <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}>
          {can(ctx.role, "journal.create") && <Link className="btn" href="/leases/new">New lease</Link>}
          {can(ctx.role, "journal.post") && <Link className="btn secondary" href="/leases/post">Post lease entries</Link>}
        </div>
      </div>
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="No., lessor, asset" /></div>
        <div><label>Type</label><select name="type" defaultValue={sp.type ?? ""}><option value="">All</option>{Object.entries(LEASE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option>{Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>No.</th><th>Lessor</th><th>Asset</th><th>Start</th><th>End</th><th>Payment</th><th>Rate</th><th>Status</th><th>Posted through</th><th className="num">Initial liability</th><th className="num">Initial ROU asset</th></tr></thead>
        <tbody>
          {leases.map((l) => (
            <tr key={l.id}>
              <td><Link href={`/leases/${l.id}`}>{l.number}</Link></td><td>{l.lessorName}</td><td>{l.assetDescription}</td>
              <td>{fmtDate(l.commencementDate)}</td><td>{fmtDate(l.endDate)}</td>
              <td>{l.currencyCode} {amt(l.paymentAmount)} {l.paymentFrequency.toLowerCase().replace("_", "-")}</td>
              <td>{l.exemption === "NONE" ? `${l.discountRate.toString().replace(/\.?0+$/, "")}%` : l.exemption === "SHORT_TERM" ? "Short-term" : "Low-value"}</td>
              <td><span className={`badge ${l.status === "ACTIVE" ? "POSTED" : l.status === "DRAFT" ? "DRAFT" : "VOID"}`}>{STATUS_LABELS[l.status]}</span></td>
              <td>{posted.get(l.id) ? fmtDate(posted.get(l.id)!) : "—"}</td>
              <td className="num">{amt(l.initialLiability)}</td><td className="num">{amt(l.initialRou)}</td>
            </tr>
          ))}
          {leases.length === 0 && <tr><td colSpan={11} className="muted">No leases yet. Add your office, warehouse, vehicle and equipment leases with New lease.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
