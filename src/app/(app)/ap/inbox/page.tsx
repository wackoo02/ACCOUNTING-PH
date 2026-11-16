import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { aiConfigured, type InvoiceExtraction } from "@/lib/ap/inbox";
import { ActionForm } from "@/components/ActionForm";
import { inboxUpload } from "../../ap-actions";

const LABEL: Record<string, string> = { NEW: "NEW", READING: "READING…", READY: "TO REVIEW", FAILED: "COULD NOT READ", BILLED: "BILL CREATED", REJECTED: "REJECTED" };
const BADGE: Record<string, string> = { NEW: "DRAFT", READING: "DRAFT", READY: "PENDING_APPROVAL", FAILED: "VOID", BILLED: "POSTED", REJECTED: "VOID" };

export default async function Inbox({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const status = sp.status ?? "OPEN";
  const [docs, org, vendors, counts] = await Promise.all([
    prisma.apInboxDocument.findMany({ where: { organizationId: ctx.org.id, ...(status === "OPEN" ? { status: { in: ["NEW", "READING", "READY", "FAILED"] } } : status ? { status } : {}) }, orderBy: { receivedAt: "desc" }, take: 200, select: { id: true, source: true, fromEmail: true, subject: true, receivedAt: true, fileName: true, status: true, extraction: true, vendorId: true, purchaseOrderId: true, duplicateOfId: true, error: true, billId: true } }),
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.vendor.findMany({ where: { organizationId: ctx.org.id }, select: { id: true, name: true } }),
    prisma.apInboxDocument.groupBy({ by: ["status"], where: { organizationId: ctx.org.id }, _count: true }),
  ]);
  const vname = new Map(vendors.map((v) => [v.id, v.name]));
  const n = (s: string[]) => counts.filter((c) => s.includes(c.status)).reduce((a, c) => a + c._count, 0);
  return (
    <>
      <div className="top"><h1>AP Invoice Inbox</h1>{can(ctx.role, "org.manage") && <Link className="btn secondary" href="/ap/inbox/setup">Email address set-up</Link>}</div>
      <p className="muted">Supplier invoices {org.apInboxAddress ? <>emailed to <strong>{org.apInboxAddress}</strong> or </> : ""}uploaded here are read automatically: supplier, TIN, invoice number, VAT, withholding tax, and whether each line is an expense, prepayment, fixed asset or inventory. Accounting staff review and correct the details, then create the bill, which goes through the AP approval matrix.</p>
      {!aiConfigured() && <div className="notice">Automatic reading needs ANTHROPIC_API_KEY on the server. Until then, open each document and enter the details by hand.</div>}
      {can(ctx.role, "journal.create") && <ActionForm action={inboxUpload} className="card row noprint">
        <div style={{ flex: 3 }}><label>Upload supplier invoices (PDF, JPG, PNG; several at once)</label><input type="file" name="files" multiple accept="application/pdf,image/jpeg,image/png,image/webp" /></div>
        <div style={{ flex: 0 }}><button>Upload and read</button></div>
      </ActionForm>}
      <div className="row noprint" style={{ gap: 8, marginBottom: 10 }}>
        {[["OPEN", `To review (${n(["NEW", "READING", "READY", "FAILED"])})`], ["BILLED", `Bill created (${n(["BILLED"])})`], ["REJECTED", `Rejected (${n(["REJECTED"])})`], ["", "All"]].map(([k, l]) => <Link key={k} className={`btn ${status === k ? "" : "secondary"}`} href={`/ap/inbox?status=${k}`}>{l}</Link>)}
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Received</th><th>From</th><th>File</th><th>Supplier</th><th>Invoice no.</th><th className="num">Total</th><th>Matched</th><th>Status</th></tr></thead>
        <tbody>
          {docs.map((d) => { const x = (d.extraction as { result?: InvoiceExtraction } | null)?.result; return (
            <tr key={d.id}><td style={{ whiteSpace: "nowrap" }}>{d.receivedAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{d.source === "EMAIL" ? d.fromEmail : "uploaded"}{d.subject && <div className="muted">{d.subject}</div>}</td>
              <td><Link href={`/ap/inbox/${d.id}`}>{d.fileName}</Link></td><td>{d.vendorId ? vname.get(d.vendorId) : x?.vendor.name ? <span className="muted">{x.vendor.name} (new)</span> : ""}</td><td>{x?.invoiceNo}</td><td className="num">{x?.totalAmountDue}</td>
              <td>{d.purchaseOrderId ? "PO ✓" : ""}{d.duplicateOfId && <span className="badge VOID"> same file again</span>}{x && x.confidence !== "high" && <span className="badge DRAFT"> {x.confidence} confidence</span>}</td>
              <td><span className={`badge ${BADGE[d.status]}`}>{LABEL[d.status]}</span>{d.error && <div className="muted">{d.error}</div>}</td></tr>); })}
          {!docs.length && <tr><td colSpan={8} className="muted">Nothing here.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
