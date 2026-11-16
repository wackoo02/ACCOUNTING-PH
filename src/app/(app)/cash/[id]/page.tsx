import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { ACTION_LABELS } from "@/lib/audit-view";
import { cashTypeLabel, type CashLine } from "@/lib/bank/cash";
import { CashActions } from "./CashActions";

const METHOD: Record<string, string> = { CASH: "Cash", CHECK: "Check", BANK_TRANSFER: "Bank transfer", ONLINE: "Online / card", EWALLET: "GCash / Maya" };

export default async function CashView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const t = await prisma.cashTransaction.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!t) notFound();
  const [org, banks, history, journal, tax, pcvs, replenishedBy] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.bankAccount.findMany({ where: { id: { in: [t.bankAccountId, t.toBankAccountId].filter(Boolean) as string[] } } }),
    prisma.auditLog.findMany({ where: { organizationId: ctx.org.id, entity: "cash", entityId: t.id }, orderBy: { createdAt: "asc" } }),
    t.journalEntryId ? prisma.journalEntry.findUnique({ where: { id: t.journalEntryId }, include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } }, reversedBy: true } }) : null,
    t.withholdingTaxCodeId ? prisma.taxCode.findUnique({ where: { id: t.withholdingTaxCodeId } }) : null,
    t.isReplenishment ? prisma.cashTransaction.findMany({ where: { replenishedById: t.id }, orderBy: { date: "asc" } }) : Promise.resolve([]),
    t.replenishedById ? prisma.cashTransaction.findUnique({ where: { id: t.replenishedById } }) : null,
  ]);
  const lines = t.lines as CashLine[];
  const accts = new Map((await prisma.account.findMany({ where: { id: { in: lines.map((l) => l.accountId) } } })).map((a) => [a.id, a]));
  const users = await prisma.user.findMany({ where: { id: { in: [t.createdById, t.approvedById, t.voidedById, ...history.map((h) => h.userId)].filter(Boolean) as string[] } } });
  const who = (u: string | null) => users.find((x) => x.id === u)?.name ?? "—";
  const bank = banks.find((b) => b.id === t.bankAccountId)!;
  const to = banks.find((b) => b.id === t.toBankAccountId);
  const cleared = journal?.lines.find((l) => l.accountId === bank.glAccountId)?.clearedAt;
  const isPreparer = [t.createdById, t.submittedById, t.updatedById].includes(ctx.user.id);
  const amt = (v: { toString(): string } | null) => formatPeso(toCentavos(v?.toString() ?? "0"));
  const gross = lines.reduce((s, l) => s + toCentavos(l.amount), 0n);
  const isCheck = t.method === "CHECK" && t.type !== "RECEIPT";
  return (
    <>
      <div className="top">
        <h1>{cashTypeLabel(t)} {t.number} <span className={`badge ${t.status}`}>{t.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : t.status}</span></h1>
        <div className="row noprint" style={{ gap: 8, flex: 0 }}>
          {t.status === "DRAFT" && !t.isReplenishment && can(ctx.role, "journal.create") && <Link className="btn secondary" href={`/cash/${t.id}/edit`}>Edit</Link>}
          <CashActions id={t.id} status={t.status} defaultDate={today()} isCheck={isCheck} released={!!t.checkReleasedAt}
            canSubmit={can(ctx.role, "journal.create")} canVoid={can(ctx.role, "journal.void")}
            canApprove={can(ctx.role, "journal.post") && !(org.segregationOfDuties && isPreparer) && (t.status === "PENDING_APPROVAL" || !org.requireApproval)} />
        </div>
      </div>
      <div className="print-only"><strong>{org.name}</strong>{org.tin ? ` · TIN ${org.tin}` : ""}<br />{org.registeredAddress}</div>
      {t.rejectReason && t.status === "DRAFT" && <div className="errors">Returned by the approver: {t.rejectReason}</div>}
      {t.status === "VOID" && <div className="notice">Voided by {who(t.voidedById)}: {t.voidReason}</div>}
      <div className="card grid">
        <div><label>Date</label>{fmtDate(t.date)}</div>
        <div><label>{t.type === "RECEIPT" ? "Deposited to" : t.type === "TRANSFER" ? "From" : "Paid from"}</label>{bank.code} · {bank.name}</div>
        {to && <div><label>To</label>{to.code} · {to.name}</div>}
        {t.payee && <div><label>{t.type === "RECEIPT" ? "Received from" : "Payee"}</label>{t.payee}{t.partyId && <div className="muted">{t.partyType?.toLowerCase()} {t.partyId}</div>}</div>}
        <div><label>Method</label>{METHOD[t.method] ?? t.method}</div>
        {t.checkNo && <div><label>Check no.</label>{t.checkNo}{t.checkDate && <div className="muted">dated {fmtDate(t.checkDate)}</div>}</div>}
        {isCheck && t.status === "POSTED" && <div><label>Check status</label>{cleared ? `Cleared by bank ${fmtDate(cleared)}` : t.checkReleasedAt ? `Released ${fmtDate(t.checkReleasedAt)}, outstanding` : "Not yet released"}</div>}
        {!isCheck && t.status === "POSTED" && (bank.kind === "CURRENT" || bank.kind === "SAVINGS") && <div><label>Bank clearing</label>{cleared ? `Cleared ${fmtDate(cleared)}` : "Not yet on a bank statement"}</div>}
        <div><label>Reference</label>{t.reference || "—"}</div>
        <div><label>Amount</label><strong>{t.currencyCode} {amt(t.amount)}</strong>{t.currencyCode !== org.baseCurrency && <div className="muted">@ {t.fxRate.toString()}</div>}</div>
        {to && t.toAmount && to.currencyCode !== t.currencyCode && <div><label>Received</label>{to.currencyCode} {amt(t.toAmount)} @ {t.toFxRate?.toString()}</div>}
      </div>
      <p><strong>{t.memo}</strong></p>
      {replenishedBy && <div className="notice">Replenished by <Link href={`/cash/${replenishedBy.id}`}>{replenishedBy.number}</Link>.</div>}

      {lines.length > 0 && <div className="table-wrap"><table>
        <thead><tr><th>Account</th><th>Description</th><th className="num">Amount ({t.currencyCode})</th></tr></thead>
        <tbody>
          {lines.map((l, i) => <tr key={i}><td>{accts.get(l.accountId)?.code} · {accts.get(l.accountId)?.name}</td><td>{l.description}</td><td className="num">{formatPeso(toCentavos(l.amount))}</td></tr>)}
          {tax && <tr className="total"><td colSpan={2} className="num">Total</td><td className="num">{formatPeso(gross)}</td></tr>}
          {tax && <tr><td colSpan={2} className="num">{t.type === "RECEIPT" ? "Less: tax withheld by customer" : "Less: expanded withholding tax"} ({tax.code}{tax.atcCode ? `, ATC ${tax.atcCode}` : ""})</td><td className="num">({amt(t.withholdingAmount)})</td></tr>}
          <tr className="total"><td colSpan={2} className="num">{t.type === "RECEIPT" ? "Net cash received" : "Net amount paid"}</td><td className="num">{amt(t.amount)}</td></tr>
        </tbody>
      </table></div>}

      {pcvs.length > 0 && <>
        <h2>Petty cash vouchers replenished</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>No.</th><th>Payee</th><th>Particulars</th><th className="num">Amount</th></tr></thead>
          <tbody>{pcvs.map((p) => <tr key={p.id}><td>{fmtDate(p.date)}</td><td><Link href={`/cash/${p.id}`}>{p.number}</Link></td><td>{p.payee}</td><td>{p.memo}</td><td className="num">{amt(p.amount)}</td></tr>)}</tbody>
        </table></div>
      </>}

      <div className="card grid sign">
        <div><label>Prepared by</label>{who(t.createdById)}<div className="muted">{t.createdAt.toISOString().slice(0, 10)}</div></div>
        <div><label>Approved by</label>{t.approvedById ? who(t.approvedById) : "—"}<div className="muted">{t.approvedAt?.toISOString().slice(0, 10)}</div></div>
        <div className="print-only"><label>{t.type === "RECEIPT" ? "Received by (cashier)" : "Received payment (signature over printed name)"}</label><br /><br />______________________</div>
      </div>

      {journal && <>
        <h2 className="noprint">General ledger entry <Link href={`/journals/${journal.id}`}>{journal.number}</Link>{journal.reversedBy && <> · reversed by <Link href={`/journals/${journal.reversedBy.id}`}>{journal.reversedBy.number}</Link></>}</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Account</th><th>Description</th><th className="num">Debit ({org.baseCurrency})</th><th className="num">Credit ({org.baseCurrency})</th></tr></thead>
          <tbody>{journal.lines.map((l) => <tr key={l.id}><td>{l.account.code} · {l.account.name}</td><td>{l.description}</td><td className="num">{formatPeso(toCentavos(l.debit.toString()), { blankZero: true })}</td><td className="num">{formatPeso(toCentavos(l.credit.toString()), { blankZero: true })}</td></tr>)}</tbody>
        </table></div>
      </>}

      <h2 className="noprint">Audit trail</h2>
      <div className="table-wrap noprint"><table>
        <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
        <tbody>{history.map((h) => { const d = (h.details ?? {}) as Record<string, string>; return (
          <tr key={h.id}><td style={{ whiteSpace: "nowrap" }}>{h.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{who(h.userId)}</td><td>{ACTION_LABELS[h.action] ?? h.action}</td>
            <td>{d.reason && <>Reason: {d.reason}</>}{d.journal && <>GL entry {d.journal}</>}{d.date && <>Date {d.date}</>}</td></tr>); })}</tbody>
      </table></div>
    </>
  );
}
