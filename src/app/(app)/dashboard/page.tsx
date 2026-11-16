import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { budgetVsActual, costByDimension, kpis } from "@/lib/ledger/reports";
import { fiscalStart } from "@/lib/budgets";
import { fiscalYearOf } from "@/lib/ledger/service";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";

const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);
const x = (n: number | null) => (n === null ? "—" : n.toFixed(2));

export default async function Dashboard() {
  const ctx = await requireCtx("reports.view");
  const orgId = ctx.org.id;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const fy = fiscalYearOf(org.fiscalYearStartMonth, new Date());
  const { start } = await fiscalStart(orgId, fy);
  const to = new Date(today());
  const monthsIn = (to.getUTCFullYear() - start.getUTCFullYear()) * 12 + to.getUTCMonth() - start.getUTCMonth() + 1;
  const [k, pending, drafts, recent, byDept, byProj, bva] = await Promise.all([
    kpis(orgId, start, to),
    prisma.journalEntry.count({ where: { organizationId: orgId, status: "PENDING_APPROVAL" } }),
    prisma.journalEntry.count({ where: { organizationId: orgId, status: "DRAFT" } }),
    prisma.journalEntry.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" }, take: 8 }),
    costByDimension(orgId, "departmentId", start, to),
    costByDimension(orgId, "projectId", start, to),
    budgetVsActual(orgId, fy, start, 1, Math.min(12, Math.max(1, monthsIn))),
  ]);
  const budgetExp = bva.rows.filter((r) => r.account.type === "EXPENSE").reduce((s, r) => s + r.budget, 0n);
  const actualExp = bva.rows.filter((r) => r.account.type === "EXPENSE").reduce((s, r) => s + r.actual, 0n);
  const budgetVar = budgetExp === 0n ? null : Number(((budgetExp - actualExp) * 10000n) / budgetExp) / 100;
  const tiles: [string, string, string?][] = [
    ["Revenue", `₱ ${formatPeso(k.revenue)}`],
    ["Gross margin", pct(k.grossMarginPct), `₱ ${formatPeso(k.grossProfit)}`],
    ["Operating expenses", `₱ ${formatPeso(k.opex)}`],
    ["Net profit", `₱ ${formatPeso(k.netProfit)}`, `Net margin ${pct(k.netMarginPct)}`],
    ["Cash position", `₱ ${formatPeso(k.cash)}`],
    ["Working capital", `₱ ${formatPeso(k.workingCapital)}`],
    ["Current ratio", x(k.currentRatio)],
    ["Debt-to-equity", x(k.debtToEquity)],
    ["Expense budget variance", pct(budgetVar), budgetExp === 0n ? "No budget uploaded" : "Positive = under budget"],
  ];
  const DimTable = ({ title, rows }: { title: string; rows: { id: string | null; label: string; amount: bigint }[] }) => (
    <div className="card" style={{ flex: 1, minWidth: 280 }}>
      <strong>{title}</strong>
      <table style={{ marginTop: 6 }}><tbody>
        {rows.slice(0, 8).map((r) => <tr key={r.id ?? "none"}><td className={r.id ? "" : "muted"}>{r.label}</td><td className="num">{formatPeso(r.amount)}</td></tr>)}
        {rows.length === 0 && <tr><td className="muted">No expenses yet</td></tr>}
      </tbody></table>
    </div>
  );
  return (
    <>
      <div className="top"><h1>{ctx.org.name}</h1><span className="muted">FY{fy} to date ({fmtDate(start)} to {today()})</span><Link className="btn" href="/journals/new">New journal entry</Link></div>
      {(pending > 0 || drafts > 0) && (
        <div className="notice">
          {pending > 0 && <><Link href="/journals?status=PENDING_APPROVAL">{pending} entr{pending === 1 ? "y" : "ies"} waiting for approval</Link>. </>}
          {drafts > 0 && <Link href="/journals?status=DRAFT">{drafts} draft{drafts === 1 ? "" : "s"}</Link>}
        </div>
      )}
      <div className="grid">
        {tiles.map(([l, n, sub]) => <div key={l} className="card stat"><div className="n">{n}</div><div className="l">{l}</div>{sub && <div className="l">{sub}</div>}</div>)}
      </div>
      <div className="row" style={{ alignItems: "stretch" }}>
        <DimTable title="Cost per department" rows={byDept} />
        <DimTable title="Cost per project" rows={byProj} />
      </div>
      <h2>Recent entries</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Description</th><th>Status</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {recent.map((e) => (
            <tr key={e.id}><td>{fmtDate(e.date)}</td><td><Link href={`/journals/${e.id}`}>{e.number}</Link></td><td>{e.memo}</td>
              <td><span className={`badge ${e.status}`}>{e.status.replace("_", " ")}</span></td><td className="num">{formatPeso(toCentavos(e.totalDebit.toString()))}</td></tr>
          ))}
          {recent.length === 0 && <tr><td colSpan={5} className="muted">No entries yet. Start with your opening balances as a journal entry.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
