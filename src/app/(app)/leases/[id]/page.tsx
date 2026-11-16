import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { EXEMPTIONS, FREQUENCIES, LEASE_TYPES, STATUS_LABELS, rowOf } from "@/lib/leases/service";
import { termMonths } from "@/lib/leases/engine";
import { LeaseActions } from "./LeaseActions";

const EVENT_LABELS: Record<string, string> = { COMMENCEMENT: "Commencement", TAKE_UP: "Balances taken up at go-live", PERIOD: "Monthly posting", MODIFICATION: "Modification", TERMINATION: "Termination" };

export default async function LeaseView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const l = await prisma.lease.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!l) notFound();
  const [org, rowsRaw, events] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.leaseScheduleLine.findMany({ where: { leaseId: id }, orderBy: { periodStart: "asc" } }),
    prisma.leaseEvent.findMany({ where: { leaseId: id }, orderBy: { createdAt: "asc" } }),
  ]);
  const rows = rowsRaw.map(rowOf);
  const accountIds = [l.rouAccountId, l.accumDepAccountId, l.liabilityAccountId, l.currentLiabilityAccountId, l.interestAccountId, l.depreciationAccountId, l.rentExpenseAccountId, l.paymentAccountId, l.gainLossAccountId, l.initialCostsAccountId, l.restorationAccountId, l.takeUpOffsetAccountId].filter(Boolean) as string[];
  const [accts, journals, users, ewt] = await Promise.all([
    prisma.account.findMany({ where: { id: { in: accountIds } } }),
    prisma.journalEntry.findMany({ where: { id: { in: events.map((e) => e.journalEntryId).filter(Boolean) as string[] } }, include: { reversedBy: true } }),
    prisma.user.findMany({ where: { id: { in: [l.createdById, l.approvedById, ...events.map((e) => e.createdById)].filter(Boolean) as string[] } } }),
    l.ewtTaxCodeId ? prisma.taxCode.findUnique({ where: { id: l.ewtTaxCodeId } }) : null,
  ]);
  const acct = (i: string | null) => { const a = accts.find((x) => x.id === i); return a ? `${a.code} · ${a.name}` : "—"; };
  const je = new Map(journals.map((j) => [j.id, j]));
  const who = (u: string | null) => users.find((x) => x.id === u)?.name ?? "—";
  const a = (c: bigint) => formatPeso(c, { blankZero: true });
  const d = (v: { toString(): string }) => toCentavos(v.toString());
  const exempt = l.exemption !== "NONE";
  const next = rows.find((r) => !r.postedAt);
  const isPreparer = [l.createdById, l.updatedById].includes(ctx.user.id);
  const now = new Date();
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const totals = rows.reduce((t, r) => ({ interest: t.interest + r.interest, payment: t.payment + r.payment, dep: t.dep + r.depreciation }), { interest: 0n, payment: 0n, dep: 0n });
  const cur = l.currencyCode;
  return (
    <>
      <div className="top">
        <h1>Lease {l.number} <span className={`badge ${l.status === "ACTIVE" ? "POSTED" : l.status === "DRAFT" ? "DRAFT" : "VOID"}`}>{STATUS_LABELS[l.status]}</span></h1>
        <div className="row noprint" style={{ gap: 8, flex: 0 }}>
          {l.status === "DRAFT" && can(ctx.role, "journal.create") && <Link className="btn secondary" href={`/leases/${l.id}/edit`}>Edit</Link>}
          <LeaseActions id={l.id} status={l.status} exempt={exempt} canEdit={can(ctx.role, "journal.create")}
            canApprove={can(ctx.role, "journal.post") && !(org.segregationOfDuties && isPreparer)} canPost={can(ctx.role, "journal.post")} canUndo={can(ctx.role, "journal.void")}
            hasEvents={events.length > 0} nextStart={next?.periodStart ?? null} monthEnd={monthEnd} endDate={fmtDate(l.endDate)}
            payment={l.paymentAmount.toString()} rate={l.discountRate.toString().replace(/\.?0+$/, "")} escalation={l.escalationPct.toString().replace(/\.?0+$/, "")} />
        </div>
      </div>
      {l.status === "DRAFT" && <div className="notice">Draft: check the measurement and schedule below. {org.segregationOfDuties && isPreparer ? "Someone other than the preparer approves it." : "Approve it to post the opening entry."}</div>}
      <div className="card grid">
        <div><label>Lessor</label>{l.lessorName}{l.lessorVendorCode && <div className="muted">vendor {l.lessorVendorCode}</div>}</div>
        <div><label>Asset</label>{l.assetDescription}<div className="muted">{LEASE_TYPES[l.leaseType]}{l.location ? ` · ${l.location}` : ""}</div></div>
        <div><label>Term</label>{fmtDate(l.commencementDate)} to {fmtDate(l.endDate)}<div className="muted">{termMonths(fmtDate(l.commencementDate), fmtDate(l.endDate))} months</div></div>
        <div><label>Payments</label>{cur} {a(d(l.paymentAmount))} {FREQUENCIES[l.paymentFrequency as keyof typeof FREQUENCIES]?.toLowerCase()}, in {l.paymentTiming === "ADVANCE" ? "advance" : "arrears"}
          {d(l.escalationPct) > 0n && <div className="muted">+{l.escalationPct.toString().replace(/\.?0+$/, "")}% every {l.escalationEveryMonths} months</div>}
          <div className="muted">{l.vatable ? "plus 12% VAT" : "no VAT"}{ewt ? ` · EWT ${ewt.code} ${ewt.rate.toString()}%` : ""}</div></div>
        <div><label>Exemption</label>{EXEMPTIONS[l.exemption]}</div>
        {!exempt && <div><label>Discount rate</label>{l.discountRate.toString().replace(/\.?0+$/, "")}% a year<div className="muted">IBR {l.incrementalBorrowingRate.toString().replace(/\.?0+$/, "")}%</div></div>}
        {cur !== org.baseCurrency && <div><label>Currency</label>{cur} @ {l.fxRate.toString()} at start</div>}
        {l.takeUpDate && <div><label>Go-live take-up</label>{fmtDate(l.takeUpDate)}</div>}
      </div>

      {!exempt && <>
        <h2>Initial measurement</h2>
        <div className="table-wrap"><table><tbody>
          <tr><td>Present value of lease payments = lease liability ({cur})</td><td className="num">{a(d(l.initialLiability))}</td></tr>
          {cur !== org.baseCurrency && <tr><td>Lease liability in {org.baseCurrency} at {l.fxRate.toString()}</td><td className="num">{a((d(l.initialLiability) * toCentavos(l.fxRate.toString()) + 50n) / 100n)}</td></tr>}
          {d(l.prepaidLeasePayments) > 0n && <tr><td>Add: payments made before the start date</td><td className="num">{a(d(l.prepaidLeasePayments))}</td></tr>}
          {d(l.initialDirectCosts) > 0n && <tr><td>Add: initial direct costs</td><td className="num">{a(d(l.initialDirectCosts))}</td></tr>}
          {d(l.restorationCost) > 0n && <tr><td>Add: estimated restoration costs</td><td className="num">{a(d(l.restorationCost))}</td></tr>}
          {d(l.leaseIncentives) > 0n && <tr><td>Less: lease incentives received</td><td className="num">({a(d(l.leaseIncentives))})</td></tr>}
          <tr className="total"><td>Right-of-use asset ({org.baseCurrency})</td><td className="num">{a(d(l.initialRou))}</td></tr>
        </tbody></table></div>
      </>}

      <h2>Accounts</h2>
      <div className="card grid">
        {!exempt && <div><label>ROU asset</label>{acct(l.rouAccountId)}</div>}
        {!exempt && <div><label>Accumulated depreciation</label>{acct(l.accumDepAccountId)}</div>}
        <div><label>{exempt ? "Accrued / prepaid rent" : "Lease liability (non-current)"}</label>{acct(l.liabilityAccountId)}</div>
        {!exempt && <div><label>Lease liability (current)</label>{acct(l.currentLiabilityAccountId)}</div>}
        {!exempt && <div><label>Interest expense</label>{acct(l.interestAccountId)}</div>}
        {!exempt && <div><label>Depreciation expense</label>{acct(l.depreciationAccountId)}</div>}
        {exempt && <div><label>Rent expense</label>{acct(l.rentExpenseAccountId)}</div>}
        <div><label>Payments due to</label>{acct(l.paymentAccountId)}</div>
        <div><label>Gain / loss</label>{acct(l.gainLossAccountId)}</div>
      </div>

      {events.length > 0 && <>
        <h2>Postings</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>What</th><th>GL entry</th><th>By</th><th className="num">Interest</th><th className="num">Payment</th><th className="num">Depreciation / rent</th><th className="num">ROU change</th><th className="num">Liability change</th><th className="num">Gain (loss)</th></tr></thead>
          <tbody>{events.slice().reverse().map((e) => { const j = e.journalEntryId ? je.get(e.journalEntryId) : null; return (
            <tr key={e.id}><td>{fmtDate(e.date)}</td><td>{EVENT_LABELS[e.type] ?? e.type}{e.type !== "PERIOD" && (e.details as { input?: { memo?: string; reason?: string } } | null)?.input && <div className="muted">{(e.details as { input: { memo?: string; reason?: string } }).input.memo ?? (e.details as { input: { reason?: string } }).input.reason}</div>}</td>
              <td>{j ? <Link href={`/journals/${j.id}`}>{j.number}</Link> : "—"}</td><td>{who(e.createdById)}</td>
              <td className="num">{a(d(e.interest))}</td><td className="num">{a(d(e.payment))}</td><td className="num">{a(d(e.depreciation) + d(e.rentExpense))}</td>
              <td className="num">{a(d(e.rouAddition) + d(e.rouRemeasurement) - d(e.rouDerecognized))}</td>
              <td className="num">{a(d(e.liabilityAddition) + d(e.liabilityRemeasurement) - d(e.liabilityDerecognized))}</td><td className="num">{a(d(e.gainLoss))}</td></tr>); })}</tbody>
        </table></div>
      </>}

      <h2>{exempt ? "Rent schedule" : "Lease liability and ROU asset schedule"} ({cur})</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Month</th>{!exempt && <th className="num">Opening liability</th>}{!exempt && <th className="num">Interest</th>}<th className="num">Payment</th>{!exempt && <th className="num">Closing liability</th>}{!exempt && <th className="num">Current portion</th>}<th className="num">{exempt ? "Rent expense" : `Depreciation (${org.baseCurrency})`}</th>{!exempt && <th className="num">ROU carrying amount</th>}<th>Posted</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className={r.postedAt ? "" : "muted"}>
            <td>{r.periodStart.slice(8) !== "01" || r.periodEnd.slice(8) < "28" ? `${r.periodStart} to ${r.periodEnd}` : r.periodEnd.slice(0, 7)}</td>
            {!exempt && <td className="num">{a(r.opening)}</td>}{!exempt && <td className="num">{a(r.interest)}</td>}<td className="num">{a(r.payment)}</td>
            {!exempt && <td className="num">{a(r.closing)}</td>}{!exempt && <td className="num">{a(r.currentPortion)}</td>}<td className="num">{a(r.depreciation)}</td>{!exempt && <td className="num">{a(r.rouClosing)}</td>}
            <td>{r.journalEntryId ? <Link href={`/journals/${r.journalEntryId}`}>✓</Link> : r.postedAt ? (l.takeUpDate && r.periodEnd < fmtDate(l.takeUpDate) ? "before go-live" : "✓") : ""}</td>
          </tr>))}
          <tr className="total"><td>Total</td>{!exempt && <td />}{!exempt && <td className="num">{a(totals.interest)}</td>}<td className="num">{a(totals.payment)}</td>{!exempt && <td />}{!exempt && <td />}<td className="num">{a(totals.dep)}</td>{!exempt && <td />}<td /></tr>
        </tbody>
      </table></div>
      <p className="muted">Interest uses the effective interest method at the discount rate ÷ 12, compounded monthly (part months pro rata by days). Prepared by {who(l.createdById)}{l.approvedById ? `, approved by ${who(l.approvedById)}` : ""}.</p>
    </>
  );
}
