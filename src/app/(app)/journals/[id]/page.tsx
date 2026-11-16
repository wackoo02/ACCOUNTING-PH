import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { DIMENSIONS } from "@/lib/ledger/dimensions";
import { ACTION_LABELS, diffFields } from "@/lib/audit-view";
import { EntryActions } from "./EntryActions";
import { ActionForm } from "@/components/ActionForm";
import { makeRecurring } from "../../actions";

const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Manual journal", SALES: "Accounts Receivable (Sales)", PURCHASES: "Accounts Payable (Purchases)", BANK: "Bank", INVENTORY: "Inventory",
  FIXED_ASSETS: "Fixed Assets", PREPAID: "Prepaid Expenses", LEASE: "Leases", DEBT: "Debt", PAYROLL: "Payroll", EXPENSE_CLAIM: "Expense Claims", PETTY_CASH: "Petty Cash",
  TAX: "Tax", OPENING_BALANCE: "Opening balance", CLOSING: "Year-end closing", REVERSAL: "Reversal", INTERCOMPANY: "Intercompany",
  CONSOLIDATION: "Consolidation adjustment", FX_REVALUATION: "FX revaluation",
};

export default async function JournalView({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const e = await prisma.journalEntry.findFirst({
    where: { id, organizationId: ctx.org.id },
    include: {
      lines: { include: { account: true, department: true, branch: true, businessUnit: true, project: true, costCenter: true, profitCenter: true, location: true, productLine: true, division: true }, orderBy: { lineNo: "asc" } },
      attachments: true, reversalOf: true, reversedBy: true,
    },
  });
  if (!e) notFound();
  const [org, history, icOrgs] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }),
    prisma.auditLog.findMany({ where: { organizationId: ctx.org.id, entity: "journal", entityId: e.id }, orderBy: { createdAt: "asc" } }),
    prisma.organization.findMany({ where: { id: { in: e.lines.map((l) => l.intercompanyOrgId).filter(Boolean) as string[] } } }),
  ]);
  const userIds = [e.createdById, e.postedById, e.updatedById, e.submittedById, ...history.map((h) => h.userId)].filter(Boolean) as string[];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } } });
  const who = (uid: string | null) => users.find((u) => u.id === uid)?.name ?? "—";
  const ts = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
  const foreign = e.lines.some((l) => l.currencyCode !== org.baseCurrency);
  const accountName = new Map(e.lines.map((l) => [l.accountId, `${l.account.code} ${l.account.name}`]));
  const dimCols = DIMENSIONS.filter((d) => e.lines.some((l) => l[d.key]));
  const dimName = (l: (typeof e.lines)[number], key: string) => {
    const rel = { departmentId: l.department, branchId: l.branch, businessUnitId: l.businessUnit, projectId: l.project, costCenterId: l.costCenter, profitCenterId: l.profitCenter, locationId: l.location, productLineId: l.productLine, divisionId: l.division }[key];
    return rel ? `${rel.code}` : "";
  };
  const isPreparer = [e.createdById, e.submittedById, e.updatedById].includes(ctx.user.id);
  return (
    <>
      <div className="top">
        <h1>{e.number} <span className={`badge ${e.status}`}>{e.status.replace("_", " ")}</span>{e.book === "CONSOLIDATION" && <span className="badge VOID"> CONSOLIDATION ONLY</span>}</h1>
        <div className="noprint row" style={{ gap: 8, flex: 0 }}>
          {e.status === "DRAFT" && can(ctx.role, "journal.create") && <Link className="btn secondary" href={`/journals/${e.id}/edit`}>Edit</Link>}
          <EntryActions id={e.id} status={e.status} defaultDate={today()}
            canSubmit={can(ctx.role, "journal.create")}
            canApprove={can(ctx.role, "journal.post") && !(org.segregationOfDuties && isPreparer) && (e.status === "PENDING_APPROVAL" || !org.requireApproval || e.source !== "MANUAL")}
            canVoid={can(ctx.role, "journal.void") && !e.reversedBy && !["REVERSAL", "CLOSING"].includes(e.source) && !e.intercompanyGroupId} />
        </div>
      </div>
      <div className="card grid">
        <div><label>Posting date</label>{fmtDate(e.date)}</div>
        <div><label>Transaction date</label>{fmtDate(e.transactionDate)}</div>
        <div><label>Reference no.</label>{e.reference || "—"}</div>
        <div><label>Source module</label>{SOURCE_LABELS[e.source] ?? e.source}</div>
        <div><label>Currency</label>{foreign ? [...new Set(e.lines.map((l) => `${l.currencyCode} @ ${l.fxRate.toString()}`))].join(", ") : org.baseCurrency}</div>
        <div><label>Prepared by</label>{who(e.createdById)}<div className="muted">{ts(e.createdAt)}</div></div>
        <div><label>Last edited by</label>{e.updatedById ? who(e.updatedById) : "—"}<div className="muted">{e.updatedById ? ts(e.updatedAt) : "Not edited since created"}</div></div>
        <div><label>Approved / posted by</label>{e.postedAt ? who(e.postedById) : "—"}<div className="muted">{e.postedAt ? ts(e.postedAt) : ""}</div></div>
      </div>
      <p><strong>{e.memo}</strong></p>
      {e.reversalOf && <div className="notice">This entry reverses <Link href={`/journals/${e.reversalOf.id}`}>{e.reversalOf.number}</Link>.</div>}
      {e.reversedBy && <div className="notice">This entry was reversed by <Link href={`/journals/${e.reversedBy.id}`}>{e.reversedBy.number}</Link> on {fmtDate(e.reversedBy.date)}.</div>}
      {e.autoReverseOn && !e.reversedBy && <div className="notice">Set to reverse automatically on {fmtDate(e.autoReverseOn)}.</div>}
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Account</th><th>Description</th>
          {dimCols.map((d) => <th key={d.key}>{d.label}</th>)}
          {foreign && <><th>Ccy</th><th className="num">Forex debit</th><th className="num">Forex credit</th><th className="num">Rate</th></>}
          <th className="num">Debit ({org.baseCurrency})</th><th className="num">Credit ({org.baseCurrency})</th></tr></thead>
        <tbody>
          {e.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.lineNo}</td>
              <td><Link href={`/ledger?account=${l.accountId}`}>{l.account.code} · {l.account.name}</Link>
                {l.intercompanyOrgId && <div className="muted">Intercompany: {icOrgs.find((o) => o.id === l.intercompanyOrgId)?.name}</div>}</td>
              <td>{l.description}</td>
              {dimCols.map((d) => <td key={d.key}>{dimName(l, d.key)}</td>)}
              {foreign && <><td>{l.currencyCode}</td>
                <td className="num">{formatPeso(toCentavos(l.fxDebit.toString()), { blankZero: true })}</td>
                <td className="num">{formatPeso(toCentavos(l.fxCredit.toString()), { blankZero: true })}</td>
                <td className="num">{l.fxRate.toString()}</td></>}
              <td className="num">{formatPeso(toCentavos(l.debit.toString()), { blankZero: true })}</td>
              <td className="num">{formatPeso(toCentavos(l.credit.toString()), { blankZero: true })}</td>
            </tr>
          ))}
          <tr className="total"><td colSpan={3 + dimCols.length + (foreign ? 4 : 0)} className="num">Totals</td>
            <td className="num">{formatPeso(toCentavos(e.totalDebit.toString()))}</td>
            <td className="num">{formatPeso(toCentavos(e.totalCredit.toString()))}</td></tr>
        </tbody>
      </table></div>

      {e.source === "MANUAL" && e.status !== "VOID" && can(ctx.role, "journal.create") && (
        <details className="card noprint">
          <summary>Make recurring</summary>
          <ActionForm action={makeRecurring} style={{ marginTop: 10 }}>
            <input type="hidden" name="entryId" value={e.id} />
            <div className="row">
              <div><label>Name</label><input name="name" defaultValue={e.memo} /></div>
              <div><label>Frequency</label><select name="frequency" defaultValue="MONTHLY"><option value="MONTHLY">Monthly</option><option value="QUARTERLY">Quarterly</option><option value="SEMI_ANNUAL">Semi-annual</option><option value="ANNUAL">Annual</option></select></div>
              <div><label>Next posting date</label><input type="date" name="nextRunDate" required /></div>
              <div><label>End date (optional)</label><input type="date" name="endDate" /></div>
              <div><label>&nbsp;</label><label style={{ display: "flex", gap: 6, color: "var(--ink)" }}><input type="checkbox" name="autoSubmit" defaultChecked style={{ width: "auto" }} /> Submit for approval automatically</label></div>
              <div style={{ flex: 0 }}><button>Save</button></div>
            </div>
          </ActionForm>
        </details>
      )}

      <h2>Supporting documents</h2>
      {e.attachments.length ? (
        <ul>{e.attachments.map((a) => <li key={a.id}><a href={a.url} target="_blank" rel="noopener noreferrer">{a.name}</a></li>)}</ul>
      ) : <p className="muted">None attached.</p>}

      <h2>Audit trail</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Details / changes</th></tr></thead>
        <tbody>
          {history.map((h) => {
            const changes = diffFields(h.before, h.after).filter((c) => !["lines", "attachments"].includes(c.field) || h.action === "journal.update");
            const d = (h.details ?? {}) as Record<string, string>;
            return (
              <tr key={h.id}>
                <td style={{ whiteSpace: "nowrap" }}>{ts(h.createdAt)}</td><td>{who(h.userId)}</td><td>{ACTION_LABELS[h.action] ?? h.action}</td>
                <td>
                  {d.reason && <div>Reason: {d.reason}</div>}
                  {d.reversal && <div>Reversal entry: {d.reversal}</div>}
                  {h.action === "journal.update" && changes.length > 0 && (
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {changes.map((c) => (
                        <li key={c.field}><b>{c.field}</b>: <span className="muted">{c.field === "lines" ? c.from.replace(/\b(c[a-z0-9]{20,})\b/g, (m) => accountName.get(m) ?? m) : c.from || "(blank)"}</span> → {c.field === "lines" ? c.to.replace(/\b(c[a-z0-9]{20,})\b/g, (m) => accountName.get(m) ?? m) : c.to || "(blank)"}</li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </>
  );
}
