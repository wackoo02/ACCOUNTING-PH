import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { ACTION_LABELS } from "@/lib/audit-view";
import { INV_LABELS, needsApproval, type InvType } from "@/lib/inventory/service";
import { formatQty, formatUnitCost, toQty, toUnitCost, unitCostOf } from "@/lib/inventory/qty";
import { InvActions } from "./InvActions";

export default async function InventoryDocView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const t = await prisma.inventoryTransaction.findFirst({ where: { id, organizationId: ctx.org.id }, include: { lines: { orderBy: { lineNo: "asc" }, include: { item: true } } } });
  if (!t) notFound();
  const [org, whs, locs, history, journal, voidJe, offset, accts] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.warehouse.findMany({ where: { id: { in: [t.warehouseId, t.toWarehouseId].filter(Boolean) as string[] } } }),
    prisma.warehouseLocation.findMany({ where: { organizationId: ctx.org.id } }),
    prisma.auditLog.findMany({ where: { organizationId: ctx.org.id, entity: "inventory", entityId: t.id }, orderBy: { createdAt: "asc" } }),
    t.journalEntryId ? prisma.journalEntry.findUnique({ where: { id: t.journalEntryId }, include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } } } }) : null,
    t.voidJournalId ? prisma.journalEntry.findUnique({ where: { id: t.voidJournalId } }) : null,
    t.offsetAccountId ? prisma.account.findUnique({ where: { id: t.offsetAccountId } }) : null,
    prisma.account.findMany({ where: { id: { in: t.lines.map((l) => l.accountId).filter(Boolean) as string[] } } }),
  ]);
  const users = await prisma.user.findMany({ where: { id: { in: [t.createdById, t.postedById, t.voidedById, ...history.map((h) => h.userId)].filter(Boolean) as string[] } } });
  const who = (u: string | null) => users.find((x) => x.id === u)?.name ?? "—";
  const wh = whs.find((w) => w.id === t.warehouseId)!;
  const to = whs.find((w) => w.id === t.toWarehouseId);
  const loc = (lid: string | null) => (lid ? locs.find((l) => l.id === lid)?.code ?? "" : "");
  const isPreparer = [t.createdById, t.submittedById, t.updatedById].includes(ctx.user.id);
  const approval = needsApproval(t.type);
  const canApprove = can(ctx.role, "inventory.approve") && !(org.segregationOfDuties && isPreparer);
  const canPost = !t.sourceModule && (t.status === "DRAFT" || t.status === "PENDING_APPROVAL") &&
    (approval ? canApprove && (t.status === "PENDING_APPROVAL" || !org.requireApproval) : can(ctx.role, "inventory.transact"));
  const posted = t.status === "POSTED" || (t.status === "VOID" && !!t.postedAt);
  return (
    <>
      <div className="top">
        <h1>{INV_LABELS[t.type as InvType]} {t.number} <span className={`badge ${t.status}`}>{t.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : t.status}</span></h1>
        <div className="row noprint" style={{ gap: 8, flex: 0 }}>
          {t.status === "DRAFT" && !t.sourceModule && can(ctx.role, "inventory.transact") && <Link className="btn secondary" href={`/inventory/transactions/${t.id}/edit`}>Edit</Link>}
          <InvActions id={t.id} type={t.type} status={t.status} canPost={canPost} canSubmit={approval && can(ctx.role, "inventory.transact")} canApprove={canApprove}
            canVoid={can(ctx.role, "inventory.approve") && (!t.sourceModule || t.sourceModule === "COUNT")} />
        </div>
      </div>
      <div className="print-only"><strong>{org.name}</strong>{org.tin ? ` · TIN ${org.tin}` : ""}<br />{org.registeredAddress}</div>
      {t.rejectReason && t.status === "DRAFT" && <div className="errors">Returned by the approver: {t.rejectReason}</div>}
      {t.status === "VOID" && <div className="notice">Voided by {who(t.voidedById)}: {t.voidReason}{voidJe && <> · GL reversal <Link href={`/journals/${voidJe.id}`}>{voidJe.number}</Link></>}</div>}
      {t.sourceModule && t.sourceModule !== "COUNT" && <div className="notice">Created by {t.sourceModule === "SALES" ? "Sales" : t.sourceModule === "PURCHASES" ? "Purchasing" : t.sourceModule}. Changes are made on the source document.</div>}
      {t.countId && <div className="notice">Variances from count <Link href={`/inventory/counts/${t.countId}`}>{t.reference}</Link>.</div>}
      <div className="card grid">
        <div><label>Date</label>{fmtDate(t.date)}</div>
        <div><label>{to ? "From" : "Warehouse"}</label>{wh.code} · {wh.name}</div>
        {to && <div><label>To</label>{to.code} · {to.name}</div>}
        {t.partyId && <div><label>{t.partyType?.toLowerCase()}</label>{t.partyId}</div>}
        <div><label>Reference</label>{t.reference || "—"}</div>
        {offset && <div><label>Offset account</label>{offset.code} · {offset.name}</div>}
        {posted && <div><label>Total cost</label><strong>{formatPeso(toCentavos(t.totalValue.toString()))}</strong></div>}
      </div>
      <p><strong>{t.memo}</strong></p>
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Item</th><th>Unit</th><th className="num">Quantity</th><th>Bin{to ? " (from → to)" : ""}</th><th>Lot / serial</th><th>Note</th><th className="num">Unit cost</th><th className="num">Cost</th></tr></thead>
        <tbody>
          {t.lines.map((l) => {
            const q = toQty(l.qty), v = toCentavos(l.value.toString());
            const uc = l.unitCost ? toUnitCost(l.unitCost) : q !== 0n && posted ? unitCostOf(v, q < 0n ? -q : q) : null;
            const a = accts.find((x) => x.id === l.accountId);
            return (
              <tr key={l.id}>
                <td>{l.lineNo}</td><td><Link href={`/inventory/items/${l.itemId}`}>{l.item.code}</Link> {l.item.name}{a && <div className="muted">{a.code} · {a.name}</div>}</td><td>{l.item.unit}</td>
                <td className="num">{formatQty(q)}</td><td>{loc(l.locationId)}{to ? ` → ${loc(l.toLocationId) || "default"}` : ""}</td><td>{l.lotNo}</td><td>{l.description}</td>
                <td className="num">{uc !== null ? formatUnitCost(uc) : ""}</td><td className="num">{posted ? formatPeso(v) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>

      <div className="card grid sign">
        <div><label>Prepared by</label>{who(t.createdById)}<div className="muted">{t.createdAt.toISOString().slice(0, 10)}</div></div>
        <div><label>{approval ? "Approved by" : "Posted by"}</label>{t.postedById ? who(t.postedById) : "—"}<div className="muted">{t.postedAt?.toISOString().slice(0, 10)}</div></div>
        <div className="print-only"><label>{t.type === "RECEIPT" || t.type === "RETURN_IN" ? "Received by (warehouse)" : "Released by / received by"}</label><br /><br />______________________</div>
      </div>

      {journal && <>
        <h2 className="noprint">General ledger entry <Link href={`/journals/${journal.id}`}>{journal.number}</Link></h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>{journal.lines.map((l) => <tr key={l.id}><td>{l.account.code} · {l.account.name}</td><td>{l.description}</td><td className="num">{formatPeso(toCentavos(l.debit.toString()), { blankZero: true })}</td><td className="num">{formatPeso(toCentavos(l.credit.toString()), { blankZero: true })}</td></tr>)}</tbody>
        </table></div>
      </>}
      {posted && !journal && t.type === "TRANSFER" && <p className="muted">Transfers do not post to the GL: the stock keeps its cost and stays in the same inventory account.</p>}

      <h2 className="noprint">Audit trail</h2>
      <div className="table-wrap noprint"><table>
        <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
        <tbody>{history.map((h) => { const d = (h.details ?? {}) as Record<string, string>; return (
          <tr key={h.id}><td style={{ whiteSpace: "nowrap" }}>{h.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{who(h.userId)}</td><td>{ACTION_LABELS[h.action] ?? h.action}</td>
            <td>{d.reason && <>Reason: {d.reason}</>}{d.total && <>Cost {d.total}</>}</td></tr>); })}</tbody>
      </table></div>
    </>
  );
}
