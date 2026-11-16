import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { ACTION_LABELS } from "@/lib/audit-view";
import { METHODS, openInvoices } from "@/lib/ar/service";
import { defaultRecipients } from "@/lib/ar/email";
import { ArDocActions } from "@/components/ArDocActions";
import { ActionForm } from "@/components/ActionForm";
import { applyCreditAction } from "../../../ar-actions";

const c = (v: { toString(): string } | null | undefined) => toCentavos(v?.toString() ?? "0");

export default async function CollectionView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const r = await prisma.arReceipt.findFirst({ where: { id, organizationId: ctx.org.id }, include: { applications: { orderBy: { date: "asc" } } } });
  if (!r) notFound();
  const plan = r.plan as { invoiceId: string; amount: string }[];
  const [org, bank, tax, journal, history, invs] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.bankAccount.findUnique({ where: { id: r.bankAccountId } }),
    r.withholdingTaxCodeId ? prisma.taxCode.findUnique({ where: { id: r.withholdingTaxCodeId } }) : null,
    r.journalEntryId ? prisma.journalEntry.findUnique({ where: { id: r.journalEntryId }, include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } }, reversedBy: true } }) : null,
    prisma.auditLog.findMany({ where: { organizationId: ctx.org.id, entity: "ar_receipt", entityId: r.id }, orderBy: { createdAt: "asc" } }),
    prisma.salesInvoice.findMany({ where: { id: { in: [...plan.map((p) => p.invoiceId), ...r.applications.map((a) => a.invoiceId)] } } }),
  ]);
  const inv = new Map(invs.map((i) => [i.id, i]));
  const users = await prisma.user.findMany({ where: { id: { in: [r.createdById, r.approvedById, r.voidedById, ...history.map((h) => h.userId)].filter(Boolean) as string[] } } });
  const who = (u: string | null) => users.find((x) => x.id === u)?.name ?? "—";
  const isPreparer = [r.createdById, r.submittedById, r.updatedById].includes(ctx.user.id);
  const ccy = r.currencyCode !== org.baseCurrency ? `${r.currencyCode} ` : "";
  const received = c(r.cashAmount) + c(r.withholdingAmount);
  const unapplied = received - c(r.appliedAmount);
  const open = r.status === "POSTED" && unapplied > 0n ? (await openInvoices(ctx.org.id, r.customerId)).filter((o) => o.currencyCode === r.currencyCode) : [];
  const rows = r.status === "POSTED" ? r.applications.map((a) => ({ invoiceId: a.invoiceId, amount: c(a.amount), date: a.date, later: a.journalEntryId !== r.journalEntryId }))
    : plan.map((p) => ({ invoiceId: p.invoiceId, amount: toCentavos(p.amount), date: r.date, later: false }));
  const cleared = journal?.lines.find((l) => l.accountId === bank?.glAccountId)?.clearedAt;
  return (
    <>
      <div className="top">
        <h1>Collection {r.number ?? "(draft)"} <span className={`badge ${r.status}`}>{r.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : r.status}</span></h1>
        <ArDocActions kind="receipt" id={r.id} status={r.status} pdfHref={`/api/receivables/pdf?type=receipt&id=${r.id}`} emailDocType="RECEIPT"
          recipients={(await defaultRecipients(ctx.org.id, r.customerId)).join("; ")} editHref={`/receivables/collections/${r.id}/edit`}
          canSubmit={can(ctx.role, "journal.create")} canVoid={can(ctx.role, "journal.void")}
          canApprove={can(ctx.role, "journal.post") && !(org.segregationOfDuties && isPreparer) && (r.status === "PENDING_APPROVAL" || !org.requireApproval)} />
      </div>
      {r.rejectReason && r.status === "DRAFT" && <div className="errors">Returned by the approver: {r.rejectReason}</div>}
      {r.status === "VOID" && <div className="notice">Voided by {who(r.voidedById)}: {r.voidReason}</div>}
      <div className="card grid">
        <div><label>Customer</label><Link href={`/receivables/statement?customer=${r.customerId}`}>{r.customerName}</Link></div>
        <div><label>Date</label>{fmtDate(r.date)}</div>
        <div><label>Deposited to</label>{bank?.code} · {bank?.name}{r.status === "POSTED" && <div className="muted">{cleared ? `Cleared by bank ${fmtDate(cleared)}` : "Not yet on a bank statement"}</div>}</div>
        <div><label>Paid by</label>{METHODS[r.method as keyof typeof METHODS] ?? r.method}{r.checkNo && <div className="muted">Check {r.checkNo}{r.checkBank ? ` · ${r.checkBank}` : ""}{r.checkDate ? ` · ${fmtDate(r.checkDate)}` : ""}</div>}</div>
        {r.reference && <div><label>Reference</label>{r.reference}</div>}
        <div><label>Cash received</label><strong>{ccy}{formatPeso(c(r.cashAmount))}</strong>{ccy && <div className="muted">@ {r.fxRate.toString()}</div>}</div>
        {c(r.withholdingAmount) > 0n && <div><label>Tax withheld (2307)</label>{formatPeso(c(r.withholdingAmount))} <span className="muted">{tax?.code}</span></div>}
        {r.status === "POSTED" && <div><label>Unapplied (advance)</label>{formatPeso(unapplied)}</div>}
      </div>
      {r.memo && <p>{r.memo}</p>}
      {c(r.withholdingAmount) > 0n && r.status === "POSTED" && <p className="muted">Keep the customer&apos;s BIR Form 2307 with this receipt: it supports the creditable withholding tax claimed on your income tax return.</p>}

      <h2>Applied to</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Invoice</th><th>Invoice date</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {rows.map((a, i) => { const x = inv.get(a.invoiceId); return <tr key={i}><td>{fmtDate(a.date)}{a.later ? " (from advance)" : ""}</td><td>{x ? <Link href={`/receivables/${x.id}`}>SI {x.number}</Link> : "—"}</td><td>{x ? fmtDate(x.date) : ""}</td><td className="num">{formatPeso(a.amount)}</td></tr>; })}
          {rows.length === 0 && <tr><td colSpan={4} className="muted">Not applied to any invoice: recorded as an advance from the customer.</td></tr>}
        </tbody>
      </table></div>

      {open.length > 0 && can(ctx.role, "journal.post") && <ActionForm action={applyCreditAction} className="card noprint">
        <h3 style={{ marginTop: 0 }}>Apply the advance of {ccy}{formatPeso(unapplied)} to open invoices</h3>
        <input type="hidden" name="source" value={`RECEIPT:${r.id}`} />
        <div className="row"><div style={{ flex: 0 }}><label>Date</label><input type="date" name="date" defaultValue={today()} /></div></div>
        <table><thead><tr><th>Invoice</th><th>Due</th><th className="num">Open</th><th className="num">Apply</th></tr></thead>
          <tbody>{open.map((o) => <tr key={o.id}><td>SI {o.number}</td><td>{fmtDate(o.dueDate)}</td><td className="num">{formatPeso(o.open)}</td><td><input className="num" name={`amt_${o.id}`} inputMode="decimal" /></td></tr>)}</tbody></table>
        <p className="muted">Posts a journal moving the amount from Advances from Customers to Accounts Receivable.</p>
        <button>Apply</button>
      </ActionForm>}

      <div className="card grid sign">
        <div><label>Prepared by</label>{who(r.createdById)}<div className="muted">{fmtDate(r.createdAt)}</div></div>
        <div><label>Approved by</label>{r.approvedById ? who(r.approvedById) : "—"}<div className="muted">{r.approvedAt ? fmtDate(r.approvedAt) : ""}</div></div>
      </div>

      {journal && <>
        <h2>General ledger entry <Link href={`/journals/${journal.id}`}>{journal.number}</Link>{journal.reversedBy && <> · reversed by <Link href={`/journals/${journal.reversedBy.id}`}>{journal.reversedBy.number}</Link></>}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Account</th><th>Description</th><th className="num">Debit ({org.baseCurrency})</th><th className="num">Credit ({org.baseCurrency})</th></tr></thead>
          <tbody>{journal.lines.map((l) => <tr key={l.id}><td>{l.account.code} · {l.account.name}</td><td>{l.description}</td><td className="num">{formatPeso(c(l.debit), { blankZero: true })}</td><td className="num">{formatPeso(c(l.credit), { blankZero: true })}</td></tr>)}</tbody>
        </table></div>
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
