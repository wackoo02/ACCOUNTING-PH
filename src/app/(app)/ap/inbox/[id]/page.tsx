import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { apFormData } from "@/lib/ap/form-data";
import { blankHeader, openPurchaseOrders } from "@/lib/ap/view";
import { matchExtraction, proposedLines, type InvoiceExtraction } from "@/lib/ap/inbox";
import { DocForm, blankLine, type DocLine } from "@/components/ap/DocForm";
import { ActionForm } from "@/components/ActionForm";
import { inboxAction } from "../../../ap-actions";

export default async function InboxDoc({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const d = await prisma.apInboxDocument.findFirst({ where: { id, organizationId: ctx.org.id }, select: { id: true, fileName: true, mediaType: true, status: true, extraction: true, vendorId: true, purchaseOrderId: true, duplicateOfId: true, error: true, billId: true, fromEmail: true, subject: true, rejectReason: true, receivedAt: true } });
  if (!d) notFound();
  const ex = d.extraction as { model?: string; readAt?: string; result?: InvoiceExtraction } | null;
  const r = ex?.result;
  const editable = can(ctx.role, "journal.create") && ["READY", "FAILED", "NEW"].includes(d.status);
  const [data, pos] = editable ? await Promise.all([apFormData(ctx.org.id), openPurchaseOrders(ctx.org.id)]) : [null, []];
  const match = r ? await matchExtraction(ctx.org.id, r, d.id) : null;
  const vendor = data?.vendors.find((v) => v.id === (d.vendorId ?? match?.vendorId));
  const vendorRec = vendor ? await prisma.vendor.findUnique({ where: { id: vendor.id } }) : null;
  let lines: DocLine[] = [];
  if (r && editable) lines = (await proposedLines(ctx.org.id, r, vendorRec?.atcCode)).map((l) => ({ ...blankLine(), ...l }));
  const po = pos.find((p) => p.id === (d.purchaseOrderId ?? match?.purchaseOrderId));
  if (po && lines.length) {
    // Link each extracted line to the PO line with the most similar description.
    const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    lines = lines.map((l) => {
      const lw = words(l.description);
      const best = po.lines.map((pl) => ({ pl, score: [...words(pl.description)].filter((w) => lw.has(w)).length })).sort((a, b) => b.score - a.score)[0];
      return best && best.score > 0 ? { ...l, poLineId: best.pl.id, accountId: best.pl.accountId, category: best.pl.category, dims: best.pl.dims } : l;
    });
  }
  const bill = d.billId ? await prisma.apBill.findUnique({ where: { id: d.billId } }) : null;
  return (
    <>
      <div className="top"><h1>{d.fileName}</h1>
        <div className="row" style={{ gap: 8, flex: 0 }}>
          {editable && <ActionForm action={inboxAction}><input type="hidden" name="id" value={d.id} /><input type="hidden" name="op" value="read" /><button className="secondary">Read again</button></ActionForm>}
          <Link className="btn secondary" href="/ap/inbox">Back to inbox</Link>
        </div>
      </div>
      {bill && <div className="notice">Bill <Link href={`/ap/bills/${bill.id}`}>{bill.number}</Link> was created from this document.</div>}
      {d.status === "REJECTED" && <div className="notice">Rejected: {d.rejectReason}</div>}
      {d.error && <div className="errors">{d.error}</div>}
      {match?.duplicateBill && <div className="errors">This invoice number from this supplier is already recorded as <Link href={`/ap/bills/${match.duplicateBill.id}`}>{match.duplicateBill.number}</Link>. Reject it as a duplicate unless it is a different invoice.</div>}
      {(d.duplicateOfId || match?.duplicateDocId) && <div className="notice">The same {d.duplicateOfId ? "file" : "invoice"} arrived before: <Link href={`/ap/inbox/${d.duplicateOfId ?? match?.duplicateDocId}`}>open the earlier copy</Link>.</div>}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 42%) 1fr", gap: 16, alignItems: "start" }}>
        <div className="card" style={{ position: "sticky", top: 8 }}>
          <div className="muted" style={{ marginBottom: 6 }}>{d.fromEmail ? `From ${d.fromEmail}` : "Uploaded"} · {d.receivedAt.toISOString().slice(0, 16).replace("T", " ")}{d.subject ? ` · ${d.subject}` : ""}</div>
          {d.mediaType === "application/pdf"
            ? <iframe src={`/api/ap-inbox/${d.id}`} style={{ width: "100%", height: "78vh", border: 0 }} title="Supplier invoice" />
            // eslint-disable-next-line @next/next/no-img-element
            : <img src={`/api/ap-inbox/${d.id}`} alt="Supplier invoice" style={{ width: "100%" }} />}
          {r && <div style={{ marginTop: 8, fontSize: 12 }}>
            <strong>What was read</strong> ({r.confidence} confidence{ex?.model ? `, ${ex.model}` : ""})<br />
            {r.vendor.name} · TIN {r.vendor.tin || "none"} · {r.vendor.vatRegistered ? "VAT" : "non-VAT"}<br />
            Invoice {r.invoiceNo || "?"} dated {r.invoiceDate || "?"}{r.poNumber && ` · PO ${r.poNumber}`}<br />
            VATable {r.vatableSales} · VAT {r.vatAmount} · exempt {r.vatExemptSales} · zero-rated {r.zeroRatedSales} · total {r.totalAmountDue}
            {r.ewtAtcSuggestion && <><br />Suggested EWT: {r.ewtAtcSuggestion}</>}
            {r.notes && <><br /><em>{r.notes}</em></>}
          </div>}
        </div>
        <div>
          {editable && data ? <>
            {!vendor && r?.vendor.name && <div className="notice">Supplier &quot;{r.vendor.name}&quot; (TIN {r.vendor.tin || "none"}) is not in the vendor list. Add it under <Link href="/masters/vendors">Master Lists → Vendors</Link>, then reload this page.</div>}
            <DocForm mode="BILL" data={data} openPos={pos} initialLines={lines}
              initial={blankHeader({
                vendorId: vendor?.id ?? "", invoiceNo: r?.invoiceNo ?? "", invoiceDate: /^\d{4}-\d{2}-\d{2}$/.test(r?.invoiceDate ?? "") ? r!.invoiceDate : blankHeader().invoiceDate,
                dueDate: /^\d{4}-\d{2}-\d{2}$/.test(r?.dueDate ?? "") ? r!.dueDate : "", purchaseOrderId: po?.id ?? "", vatInclusive: po?.vatInclusive ?? r?.pricesIncludeVat ?? true,
                currencyCode: po?.currencyCode ?? (r?.currency || vendor?.currency || data.baseCurrency), fxRate: po?.fxRate ?? "1", purpose: r?.lines[0]?.description ?? "", inboxDocumentId: d.id,
              })} />
            <ActionForm action={inboxAction} className="card" style={{ marginTop: 16 }}>
              <input type="hidden" name="id" value={d.id} /><input type="hidden" name="op" value="reject" />
              <div className="row"><div style={{ flex: 3 }}><label>Not a valid invoice? Reject with a reason (duplicate, not ours, statement only)</label><input name="reason" required /></div><div style={{ flex: 0 }}><button className="danger">Reject</button></div></div>
            </ActionForm>
          </> : <div className="card muted">{d.status === "READING" ? "Reading the document… refresh in a moment." : "Nothing to review."}</div>}
        </div>
      </div>
    </>
  );
}
