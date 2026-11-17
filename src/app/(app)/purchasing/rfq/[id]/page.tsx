import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate, today } from "@/lib/format";
import { calcLine } from "@/lib/ap/compute";
import { fromCentavos } from "@/lib/money";
import { peso } from "@/lib/ap/view";
import { ActionForm } from "@/components/ActionForm";
import { Workflow } from "@/components/ap/Workflow";
import { awardAction, quoteAction } from "../../../ap-actions";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

type RfqLine = { lineNo: number; description: string; quantity: string; unit: string | null };

export default async function RfqView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const rfq = await prisma.rfq.findFirst({ where: { id, organizationId: ctx.org.id }, include: { quotes: { orderBy: { total: "asc" } }, request: true } });
  if (!rfq) notFound();
  const vendors = await prisma.vendor.findMany({ where: { organizationId: ctx.org.id, isActive: true }, orderBy: { name: "asc" } });
  const vname = new Map(vendors.map((v) => [v.id, v]));
  const lines = rfq.lines as RfqLine[];
  const open = rfq.status === "OPEN" && can(ctx.role, "journal.create");
  const po = rfq.purchaseOrderId ? await prisma.purchaseOrder.findUnique({ where: { id: rfq.purchaseOrderId } }) : null;
  const lowest = rfq.quotes[0]?.id;
  const price = (q: (typeof rfq.quotes)[number], lineNo: number) => (q.prices as { lineNo: number; unitPrice: string }[]).find((p) => p.lineNo === lineNo)?.unitPrice;
  return (
    <>
      <div className="top"><h1>RFQ {rfq.number} <span className="badge PENDING_APPROVAL">{rfq.status}</span></h1>
        {open && <Workflow doc="RFQ" id={rfq.id} ops={["cancel"]} />}</div>
      <div className="card grid">
        <div><label>Date</label>{fmtDate(rfq.date)}</div>
        <div><label>Reply due</label>{rfq.dueDate ? fmtDate(rfq.dueDate) : "—"}</div>
        {rfq.request && <div><label>Purchase request</label><Link href={`/purchasing/requests/${rfq.request.id}`}>{rfq.request.number}</Link> · {rfq.request.purpose}</div>}
        {po && <div><label>Awarded</label>{vname.get(po.vendorId ?? "")?.name} · <Link href={`/purchasing/orders/${po.id}`}>{po.number}</Link>{rfq.awardReason && <div className="muted">{rfq.awardReason}</div>}</div>}
      </div>

      <h2>Canvass sheet</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Item</th><th className="num">Qty</th>{rfq.quotes.map((q) => <th key={q.id} className="num">{vname.get(q.vendorId)?.name}{q.id === lowest && <div className="badge POSTED">lowest</div>}</th>)}</tr></thead>
        <tbody>
          {lines.map((l) => <tr key={l.lineNo}><td>{l.lineNo}</td><td>{l.description}</td><td className="num">{l.quantity} {l.unit}</td>
            {rfq.quotes.map((q) => { const p = price(q, l.lineNo); return <td key={q.id} className="num">{p ? <>{peso(p)}<div className="muted">{peso(fromCentavos(calcLine({ quantity: l.quantity, unitPrice: p }, { vatInclusive: true, vendorVatRegistered: true }).gross))}</div></> : <span className="muted">no offer</span>}</td>; })}</tr>)}
          <tr className="total"><td colSpan={3} className="num">Total incl. VAT</td>{rfq.quotes.map((q) => <td key={q.id} className="num">{peso(q.total)}</td>)}</tr>
          <tr><td colSpan={3} className="num">Prices</td>{rfq.quotes.map((q) => <td key={q.id} className="num">{q.vatInclusive ? "VAT-inclusive" : "VAT-exclusive"}</td>)}</tr>
          <tr><td colSpan={3} className="num">Lead time / terms</td>{rfq.quotes.map((q) => <td key={q.id} className="num">{q.leadTimeDays ?? "—"} days / {q.paymentTermsDays ?? "—"} days</td>)}</tr>
          <tr><td colSpan={3} className="num">Quote ref. / valid until</td>{rfq.quotes.map((q) => <td key={q.id} className="num">{q.quoteRef ?? "—"}{q.validUntil ? ` / ${fmtDate(q.validUntil)}` : ""}{q.remarks && <div className="muted">{q.remarks}</div>}</td>)}</tr>
          {open && <tr className="noprint"><td colSpan={3} />{rfq.quotes.map((q) => <td key={q.id} className="num">
            <ActionForm action={awardAction}><input type="hidden" name="rfqId" value={rfq.id} /><input type="hidden" name="quoteId" value={q.id} />
              {q.id !== lowest && <input name="reason" placeholder="Why not the lowest?" style={{ marginBottom: 4 }} />}
              <button>Award PO</button></ActionForm>
            <ActionForm action={quoteAction}><input type="hidden" name="rfqId" value={rfq.id} /><input type="hidden" name="quoteId" value={q.id} /><input type="hidden" name="op" value="delete" /><button className="link" style={{ color: "var(--danger)" }}>Remove quote</button></ActionForm>
          </td>)}</tr>}
        </tbody>
      </table></div>

      {open && <ActionForm action={quoteAction} className="card noprint" style={{ marginTop: 16 }}>
        <strong>Record a supplier quote</strong>
        <input type="hidden" name="rfqId" value={rfq.id} />
        <div className="row" style={{ marginTop: 8 }}>
          <div style={{ flex: 2 }}><label>Supplier</label><MasterPicker name="vendorId" ariaLabel="Supplier" required placeholder="Type to search…" options={idOpts(vendors)} add={{ kind: "vendors", noun: "supplier" }} /></div>
          <div><label>Quote ref.</label><input name="quoteRef" /></div>
          <div><label>Quote date</label><input type="date" name="quoteDate" defaultValue={today()} /></div>
          <div><label>Valid until</label><input type="date" name="validUntil" /></div>
          <div><label>Lead time (days)</label><input name="leadTimeDays" className="num" /></div>
          <div><label>Terms (days)</label><input name="paymentTermsDays" className="num" /></div>
        </div>
        <label style={{ display: "flex", gap: 6, marginTop: 8 }}><input type="checkbox" name="vatInclusive" defaultChecked style={{ width: "auto" }} /> Prices include VAT</label>
        <table style={{ marginTop: 8 }}><thead><tr><th>Item</th><th className="num">Qty</th><th className="num" style={{ width: 160 }}>Unit price</th></tr></thead>
          <tbody>{lines.map((l) => <tr key={l.lineNo}><td>{l.description}</td><td className="num">{l.quantity} {l.unit}</td><td><input name={`price_${l.lineNo}`} className="num" inputMode="decimal" placeholder="blank = no offer" /></td></tr>)}</tbody></table>
        <div style={{ marginTop: 8 }}><label>Remarks</label><input name="remarks" /></div>
        <button style={{ marginTop: 8 }}>Save quote</button>
      </ActionForm>}
    </>
  );
}
