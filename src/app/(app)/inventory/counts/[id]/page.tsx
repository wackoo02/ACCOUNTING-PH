import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { countVariances } from "@/lib/inventory/counts";
import { formatQty, fromQty, toQty } from "@/lib/inventory/qty";
import { CountSheet } from "./CountSheet";

export default async function CountView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const exists = await prisma.inventoryCount.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!exists) notFound();
  const { count: c, lines } = await prisma.$transaction((tx) => countVariances(tx, ctx.org.id, id));
  const [org, wh, locs, items, users] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.warehouse.findUniqueOrThrow({ where: { id: c.warehouseId } }),
    prisma.warehouseLocation.findMany({ where: { warehouseId: c.warehouseId }, orderBy: { code: "asc" } }),
    prisma.product.findMany({ where: { organizationId: ctx.org.id, isStocked: true, isActive: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: [c.createdById, c.submittedById, c.postedById].filter(Boolean) as string[] } } }),
  ]);
  const who = (u: string | null) => users.find((x) => x.id === u)?.name ?? "—";
  const loc = (lid: string | null) => (lid ? locs.find((l) => l.id === lid)?.code ?? "" : "");
  const preparer = [c.createdById, c.submittedById].includes(ctx.user.id);
  const canApprove = can(ctx.role, "inventory.approve") && !(org.segregationOfDuties && preparer) && (c.status === "PENDING_APPROVAL" || (c.status === "DRAFT" && !org.requireApproval));
  const sorted = [...lines].sort((a, b) => (loc(a.line.locationId) + a.line.item.code).localeCompare(loc(b.line.locationId) + b.line.item.code));
  return (
    <>
      <div className="top"><h1>{c.type === "PHYSICAL" ? "Physical Inventory Count" : "Cycle Count"} {c.number} <span className={`badge ${c.status}`}>{c.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : c.status}</span></h1></div>
      <div className="print-only"><strong>{org.name}</strong></div>
      {c.rejectReason && c.status === "DRAFT" && <div className="errors">Returned for recount: {c.rejectReason}</div>}
      {c.adjustmentId && <div className="notice">Variances posted as adjustment <Link href={`/inventory/transactions/${c.adjustmentId}`}>view document</Link>.</div>}
      <div className="card grid">
        <div><label>Warehouse</label>{wh.code} · {wh.name}</div><div><label>Count date</label>{fmtDate(c.date)}</div>
        <div><label>Prepared by</label>{who(c.createdById)}</div><div><label>Submitted by</label>{c.submittedById ? who(c.submittedById) : "—"}</div><div><label>Approved by</label>{c.postedById ? who(c.postedById) : "—"}</div>
        {c.memo && <div><label>Notes</label>{c.memo}</div>}
      </div>
      <CountSheet id={c.id} status={c.status} canEdit={c.status === "DRAFT" && can(ctx.role, "inventory.transact")} canApprove={canApprove} canReject={c.status === "PENDING_APPROVAL" && can(ctx.role, "inventory.approve")}
        items={items} locations={locs.map((l) => ({ id: l.id, code: l.code }))}
        lines={sorted.map((v) => ({
          id: v.line.id, item: `${v.line.item.code} ${v.line.item.name}`, unit: v.line.item.unit ?? "", location: loc(v.line.locationId), lotNo: v.line.lotNo ?? "",
          systemQty: formatQty(toQty(v.line.systemQty)), onHand: formatQty(v.onHand), changed: v.changedSinceSheet,
          counted: v.counted === null ? "" : fromQty(v.counted), variance: v.counted === null ? "" : formatQty(v.variance), note: v.line.note ?? "",
        }))} />
    </>
  );
}
