import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { cents } from "@/lib/ap/common";
import { CATEGORY_LABELS, type Category } from "@/lib/ap/compute";
import { peso, qty, statusText, userNames } from "@/lib/ap/view";
import { Workflow } from "@/components/ap/Workflow";
import { ApprovalPanel } from "@/components/ap/ApprovalPanel";
import { ActionForm } from "@/components/ActionForm";
import { prNextStep } from "../../../ap-actions";
import { canApproveNow } from "@/lib/approvals";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

export default async function PrView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const pr = await prisma.purchaseRequest.findFirst({ where: { id, organizationId: ctx.org.id }, include: { lines: { orderBy: { lineNo: "asc" } }, rfqs: true, orders: true } });
  if (!pr) notFound();
  const [accounts, dims, vendors] = await Promise.all([
    prisma.account.findMany({ where: { id: { in: pr.lines.map((l) => l.accountId).filter(Boolean) as string[] } } }),
    prisma.dimensionValue.findMany({ where: { id: { in: [pr.departmentId, pr.costCenterId, pr.projectId, pr.branchId].filter(Boolean) as string[] } } }),
    prisma.vendor.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  const who = await userNames([pr.requestedById, pr.approvedById]);
  const total = cents(pr.estimatedTotal);
  const create = can(ctx.role, "journal.create");
  const appr = pr.status === "PENDING_APPROVAL" ? await canApproveNow(ctx.org.id, "PR", pr.id, ctx.user.id, total, [pr.requestedById]) : null;
  const ops = [
    ...(pr.status === "DRAFT" && create ? ["submit" as const] : []),
    ...(appr?.ok ? ["approve" as const, "return" as const] : []),
    ...(!["ORDERED", "CLOSED", "CANCELLED"].includes(pr.status) && create ? ["cancel" as const] : []),
  ];
  return (
    <>
      <div className="top">
        <h1>Purchase Request {pr.number} <span className={`badge ${pr.status}`}>{statusText(pr.status)}</span></h1>
        <div className="row" style={{ gap: 8, flex: "0 0 auto", maxWidth: "70%", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "flex-start" }}>
          {pr.status === "DRAFT" && create && <Link className="btn secondary" href={`/purchasing/requests/${pr.id}/edit`}>Edit</Link>}
          <Workflow doc="PR" id={pr.id} ops={ops} />
        </div>
      </div>
      {pr.rejectReason && pr.status === "DRAFT" && <div className="errors">Returned: {pr.rejectReason}</div>}
      <div className="card grid">
        <div><label>Date</label>{fmtDate(pr.date)}</div>
        <div><label>Requested by</label>{who(pr.requestedById)}</div>
        <div><label>Needed by</label>{pr.neededBy ? fmtDate(pr.neededBy) : "—"}</div>
        <div><label>Charge to</label>{dims.map((d) => `${d.code} ${d.name}`).join(" · ") || "—"}</div>
        <div><label>Estimated total</label><strong>{peso(pr.estimatedTotal)}</strong></div>
        {pr.approvedById && <div><label>Approved by</label>{who(pr.approvedById)}</div>}
      </div>
      <p><strong>{pr.purpose}</strong></p>
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Item</th><th>Type</th><th>Account</th><th className="num">Qty</th><th>Unit</th><th className="num">Est. unit cost</th><th className="num">Est. amount</th></tr></thead>
        <tbody>{pr.lines.map((l) => { const a = accounts.find((x) => x.id === l.accountId); return (
          <tr key={l.id}><td>{l.lineNo}</td><td>{l.description}</td><td>{CATEGORY_LABELS[l.category as Category] ?? l.category}</td><td>{a ? `${a.code} ${a.name}` : "—"}</td><td className="num">{qty(l.quantity)}</td><td>{l.unit}</td><td className="num">{peso(l.estUnitCost)}</td><td className="num">{peso((Number(l.quantity) * Number(l.estUnitCost)).toFixed(2))}</td></tr>); })}</tbody>
      </table></div>
      {pr.status !== "DRAFT" && <ApprovalPanel organizationId={ctx.org.id} docType="PR" docId={pr.id} total={total} preparerIds={[pr.requestedById]} userId={ctx.user.id} status={pr.status} />}

      {pr.status === "APPROVED" && create && <div className="card noprint">
        <strong>Next step</strong>
        <div className="row" style={{ marginTop: 8 }}>
          <ActionForm action={prNextStep} style={{ flex: 1 }}>
            <input type="hidden" name="id" value={pr.id} /><input type="hidden" name="op" value="rfq" />
            <label>Canvass suppliers: request for quotation, reply due</label>
            <div className="row"><div><input type="date" name="dueDate" /></div><div style={{ flex: 0 }}><button>Create RFQ</button></div></div>
          </ActionForm>
          <ActionForm action={prNextStep} style={{ flex: 1 }}>
            <input type="hidden" name="id" value={pr.id} /><input type="hidden" name="op" value="po" />
            <label>Or order directly from</label>
            <div className="row"><div><MasterPicker name="vendorId" ariaLabel="Supplier" required placeholder="Type to search…" options={idOpts(vendors)} add={{ kind: "vendors", noun: "supplier" }} /></div><div style={{ flex: 0 }}><button className="secondary">Create draft PO</button></div></div>
          </ActionForm>
        </div>
      </div>}
      {(pr.rfqs.length > 0 || pr.orders.length > 0) && <p>
        {pr.rfqs.map((r) => <span key={r.id}>RFQ <Link href={`/purchasing/rfq/${r.id}`}>{r.number}</Link> ({r.status.toLowerCase()}) · </span>)}
        {pr.orders.map((o) => <span key={o.id}>PO <Link href={`/purchasing/orders/${o.id}`}>{o.number}</Link> ({statusText(o.status).toLowerCase()}) · </span>)}
      </p>}
    </>
  );
}
