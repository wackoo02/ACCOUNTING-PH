import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { ACTION_LABELS } from "@/lib/audit-view";
import { openInvoices } from "@/lib/ar/service";
import { defaultRecipients, emailConfigured } from "@/lib/ar/email";
import { ArDocActions } from "@/components/ArDocActions";
import { ActionForm } from "@/components/ActionForm";
import { applyCreditAction } from "../../ar-actions";

const c = (v: { toString(): string } | null | undefined) => toCentavos(v?.toString() ?? "0");
const VAT: Record<string, string> = { VATABLE: "VATable", ZERO_RATED: "Zero-rated", EXEMPT: "Exempt" };

export default async function InvoiceView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const inv = await prisma.salesInvoice.findFirst({ where: { id, organizationId: ctx.org.id }, include: { lines: { orderBy: { lineNo: "asc" } } } });
  if (!inv) notFound();
  const cm = inv.kind === "CREDIT_MEMO";
  const [org, customer, journal, history, apps, tax, creditFor, credits, emails, series, contract] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.customer.findUnique({ where: { id: inv.customerId } }),
    inv.journalEntryId ? prisma.journalEntry.findUnique({ where: { id: inv.journalEntryId }, include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } }, reversedBy: true } }) : null,
    prisma.auditLog.findMany({ where: { organizationId: ctx.org.id, entity: "sales_invoice", entityId: inv.id }, orderBy: { createdAt: "asc" } }),
    prisma.arApplication.findMany({ where: cm ? { creditMemoId: inv.id } : { invoiceId: inv.id }, include: { receipt: true }, orderBy: { date: "asc" } }),
    inv.ewtTaxCodeId ? prisma.taxCode.findUnique({ where: { id: inv.ewtTaxCodeId } }) : null,
    inv.creditForId ? prisma.salesInvoice.findUnique({ where: { id: inv.creditForId } }) : null,
    cm ? Promise.resolve([]) : prisma.salesInvoice.findMany({ where: { creditForId: inv.id, status: { not: "VOID" } } }),
    prisma.documentEmail.findMany({ where: { organizationId: ctx.org.id, docId: inv.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    inv.seriesId ? prisma.documentSeries.findUnique({ where: { id: inv.seriesId } }) : null,
    inv.contractId ? prisma.billingContract.findUnique({ where: { id: inv.contractId } }) : null,
  ]);
  const stockDocs = cm ? [] : await prisma.inventoryTransaction.findMany({ where: { organizationId: ctx.org.id, sourceModule: "SALES", sourceId: inv.id }, orderBy: { createdAt: "asc" } });
  const accts = new Map((await prisma.account.findMany({ where: { id: { in: inv.lines.map((l) => l.accountId) } } })).map((a) => [a.id, a]));
  const otherIds = apps.map((a) => (cm ? a.invoiceId : a.creditMemoId)).filter(Boolean) as string[];
  const others = new Map((await prisma.salesInvoice.findMany({ where: { id: { in: otherIds } } })).map((x) => [x.id, x]));
  const users = await prisma.user.findMany({ where: { id: { in: [inv.createdById, inv.approvedById, inv.voidedById, ...history.map((h) => h.userId)].filter(Boolean) as string[] } } });
  const who = (u: string | null) => users.find((x) => x.id === u)?.name ?? "—";
  const isPreparer = [inv.createdById, inv.submittedById, inv.updatedById].includes(ctx.user.id);
  const ccy = inv.currencyCode !== org.baseCurrency ? `${inv.currencyCode} ` : "";
  const total = c(inv.totalAmount), applied = c(inv.appliedAmount), bal = total - applied;
  const label = cm ? "Credit memo" : "Sales invoice";
  const open = cm && inv.status === "POSTED" && bal > 0n ? await openInvoices(ctx.org.id, inv.customerId) : [];
  const custOpen = !cm && inv.status !== "VOID" && customer && c(customer.creditLimit) > 0n
    ? (await prisma.salesInvoice.findMany({ where: { organizationId: ctx.org.id, customerId: inv.customerId, kind: "INVOICE", status: "POSTED" } })).reduce((s, x) => s + c(x.totalAmount) - c(x.appliedAmount), 0n) + (inv.status === "POSTED" ? 0n : total)
    : 0n;
  return (
    <>
      <div className="top">
        <h1>{label} {inv.number ?? "(draft)"} <span className={`badge ${inv.status}`}>{inv.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : inv.status === "POSTED" ? (cm ? "ISSUED" : bal === 0n ? "PAID" : "ISSUED") : inv.status}</span></h1>
        <ArDocActions kind="invoice" id={inv.id} status={inv.status} pdfHref={`/api/receivables/pdf?type=invoice&id=${inv.id}`} emailDocType={inv.kind}
          recipients={(await defaultRecipients(ctx.org.id, inv.customerId)).join("; ")} editHref={`/receivables/${inv.id}/edit`}
          canSubmit={can(ctx.role, "journal.create")} canVoid={can(ctx.role, "journal.void")}
          canApprove={can(ctx.role, "journal.post") && !(org.segregationOfDuties && isPreparer) && (inv.status === "PENDING_APPROVAL" || !org.requireApproval)} />
      </div>
      {inv.rejectReason && inv.status === "DRAFT" && <div className="errors">Returned by the approver: {inv.rejectReason}</div>}
      {inv.status === "VOID" && <div className="notice">Voided by {who(inv.voidedById)}: {inv.voidReason}</div>}
      {custOpen > c(customer?.creditLimit) && <div className="errors">Credit limit: {customer!.name} would owe {formatPeso(custOpen)}, above the credit limit of {formatPeso(c(customer!.creditLimit))}.</div>}
      {inv.status === "POSTED" && !emailConfigured() && <div className="notice noprint">Emailing is not switched on yet (needs SMTP settings on the server). Use Print / PDF and send the file meanwhile.</div>}
      <div className="card grid">
        <div><label>Customer</label><Link href={`/receivables/statement?customer=${inv.customerId}`}>{inv.customerName}</Link><div className="muted">{customer?.code}{inv.customerTin ? ` · TIN ${inv.customerTin}` : ""}</div></div>
        <div><label>Date</label>{fmtDate(inv.date)}</div>
        {!cm && <div><label>Due date</label>{fmtDate(inv.dueDate)} <span className="muted">({inv.termsDays} days)</span></div>}
        {inv.reference && <div><label>Reference</label>{inv.reference}</div>}
        {creditFor && <div><label>Credits invoice</label><Link href={`/receivables/${creditFor.id}`}>SI {creditFor.number}</Link></div>}
        {cm && inv.reason && <div><label>Reason</label>{inv.reason}</div>}
        {contract && <div><label>Billing contract</label><Link href={`/receivables/billing/${contract.id}`}>{contract.number}</Link> {contract.name}</div>}
        {series && <div><label>Series</label>{series.name} <div className="muted">{series.authorityType} {series.authorityNo}</div></div>}
        <div><label>Total</label><strong>{ccy}{formatPeso(total)}</strong>{ccy && <div className="muted">@ {inv.fxRate.toString()}</div>}</div>
        {inv.status === "POSTED" && <div><label>{cm ? "Unapplied" : "Balance due"}</label><strong>{ccy}{formatPeso(bal)}</strong></div>}
      </div>
      {inv.memo && <p>{inv.memo}</p>}

      <div className="table-wrap"><table>
        <thead><tr><th>Description</th><th className="num">Qty</th><th>Unit</th><th className="num">Unit price</th><th className="num">Discount</th>{org.vatRegistered && <th>VAT</th>}<th>Account</th><th className="num">Net of VAT</th>{org.vatRegistered && <th className="num">VAT</th>}</tr></thead>
        <tbody>
          {inv.lines.map((l) => <tr key={l.id}>
            <td>{l.description}</td><td className="num">{Number(l.quantity).toLocaleString("en-PH", { maximumFractionDigits: 4 })}</td><td>{l.unit}</td>
            <td className="num">{Number(l.unitPrice).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}</td><td className="num">{formatPeso(c(l.discount), { blankZero: true })}</td>
            {org.vatRegistered && <td>{VAT[l.vatType]}</td>}<td>{accts.get(l.accountId)?.code} {accts.get(l.accountId)?.name}</td>
            <td className="num">{formatPeso(c(l.netAmount))}</td>{org.vatRegistered && <td className="num">{formatPeso(c(l.vatAmount), { blankZero: true })}</td>}
          </tr>)}
        </tbody>
      </table></div>
      <div className="card row">
        {org.vatRegistered && <>
          <div className="stat"><div className="l">VATable sales</div><div className="n">{formatPeso(c(inv.vatableSales))}</div></div>
          <div className="stat"><div className="l">VAT 12%</div><div className="n">{formatPeso(c(inv.vatAmount))}</div></div>
          <div className="stat"><div className="l">Zero-rated</div><div className="n">{formatPeso(c(inv.zeroRatedSales))}</div></div>
          <div className="stat"><div className="l">VAT-exempt</div><div className="n">{formatPeso(c(inv.exemptSales))}</div></div>
        </>}
        <div className="stat"><div className="l">Total</div><div className="n">{ccy}{formatPeso(total)}</div></div>
        {tax && <div className="stat"><div className="l">Expected withholding ({tax.code})</div><div className="n">({formatPeso(c(inv.ewtAmount))})</div></div>}
      </div>

      {(apps.length > 0 || credits.length > 0) && <>
        <h2>{cm ? "Applied to invoices" : "Payments and credits"}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Document</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {apps.map((a) => {
              const o = cm ? others.get(a.invoiceId) : a.creditMemoId ? others.get(a.creditMemoId) : null;
              return <tr key={a.id}><td>{fmtDate(a.date)}</td><td>
                {a.receipt ? <Link href={`/receivables/collections/${a.receipt.id}`}>Collection {a.receipt.number}</Link> : o ? <Link href={`/receivables/${o.id}`}>{o.kind === "CREDIT_MEMO" ? "Credit memo" : "Invoice"} {o.number}</Link> : "—"}
              </td><td className="num">{formatPeso(c(a.amount))}</td></tr>;
            })}
          </tbody>
        </table></div>
      </>}
      {!cm && inv.status === "POSTED" && bal > 0n && can(ctx.role, "journal.create") && <p className="noprint">
        <Link className="btn" href={`/receivables/collections/new?customer=${inv.customerId}&invoice=${inv.id}`}>Record payment</Link>{" "}
        <Link className="btn secondary" href={`/receivables/new?kind=CREDIT_MEMO&creditFor=${inv.id}`}>Issue credit memo</Link>
      </p>}

      {open.length > 0 && can(ctx.role, "journal.post") && <ActionForm action={applyCreditAction} className="card noprint">
        <h3 style={{ marginTop: 0 }}>Apply the unapplied {ccy}{formatPeso(bal)} to open invoices</h3>
        <input type="hidden" name="source" value={`CREDIT_MEMO:${inv.id}`} />
        <div className="row"><div style={{ flex: 0 }}><label>Date</label><input type="date" name="date" defaultValue={today()} /></div></div>
        <table><thead><tr><th>Invoice</th><th>Due</th><th className="num">Open</th><th className="num">Apply</th></tr></thead>
          <tbody>{open.filter((o) => o.currencyCode === inv.currencyCode).map((o) => <tr key={o.id}><td>SI {o.number}</td><td>{fmtDate(o.dueDate)}</td><td className="num">{formatPeso(o.open)}</td><td><input className="num" name={`amt_${o.id}`} inputMode="decimal" /></td></tr>)}</tbody></table>
        <button style={{ marginTop: 8 }}>Apply</button>
      </ActionForm>}

      <div className="card grid sign">
        <div><label>Prepared by</label>{who(inv.createdById)}<div className="muted">{fmtDate(inv.createdAt)}</div></div>
        <div><label>Approved / issued by</label>{inv.approvedById ? who(inv.approvedById) : "—"}<div className="muted">{inv.approvedAt ? fmtDate(inv.approvedAt) : ""}</div></div>
        {inv.emailedAt && <div><label>Last emailed</label>{inv.emailedAt.toISOString().slice(0, 16).replace("T", " ")} UTC</div>}
      </div>

      {journal && <>
        <h2>General ledger entry <Link href={`/journals/${journal.id}`}>{journal.number}</Link>{journal.reversedBy && <> · reversed by <Link href={`/journals/${journal.reversedBy.id}`}>{journal.reversedBy.number}</Link></>}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Account</th><th>Description</th><th className="num">Debit ({org.baseCurrency})</th><th className="num">Credit ({org.baseCurrency})</th></tr></thead>
          <tbody>{journal.lines.map((l) => <tr key={l.id}><td>{l.account.code} · {l.account.name}</td><td>{l.description}</td><td className="num">{formatPeso(c(l.debit), { blankZero: true })}</td><td className="num">{formatPeso(c(l.credit), { blankZero: true })}</td></tr>)}</tbody>
        </table></div>
      </>}
      {stockDocs.length > 0 && <p>Cost of goods sold: {stockDocs.map((d, k) => <span key={d.id}>{k > 0 && ", "}<Link href={`/inventory/transactions/${d.id}`}>{d.number}</Link> {formatPeso(c(d.totalValue))}{d.status === "VOID" && " (void)"}</span>)}</p>}

      {emails.length > 0 && <>
        <h2>Emails</h2>
        <div className="table-wrap"><table><thead><tr><th>When (UTC)</th><th>To</th><th>Status</th></tr></thead>
          <tbody>{emails.map((e) => <tr key={e.id}><td>{e.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{e.to}</td><td>{e.status}{e.error ? `: ${e.error}` : ""}</td></tr>)}</tbody></table></div>
      </>}

      <h2>Audit trail</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
        <tbody>{history.map((h) => { const d = (h.details ?? {}) as Record<string, string>; return (
          <tr key={h.id}><td style={{ whiteSpace: "nowrap" }}>{h.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{who(h.userId)}</td><td>{ACTION_LABELS[h.action] ?? h.action}</td>
            <td>{d.reason && <>Reason: {d.reason}</>}{d.number && <>No. {d.number} </>}{d.journal && <>GL entry {d.journal}</>}{d.to && <>To {d.to}</>}</td></tr>); })}</tbody>
      </table></div>
    </>
  );
}
