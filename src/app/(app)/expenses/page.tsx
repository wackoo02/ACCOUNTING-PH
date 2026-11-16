import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { mobilityDashboard } from "@/lib/expense/service";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/lib/icons";
import { Breakdown, peso } from "@/components/ExpenseUi";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function ExpenseDashboard({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const d = await mobilityDashboard(ctx.org.id, { from, to });
  const tiles: [string, string, IconName, string?][] = [
    ["Transportation and travel", peso(d.totals.transportation), "transport"],
    ["Delivery", peso(d.totals.delivery), "sent-package"],
    ["Petty cash", peso(d.totals.pettyCash), "petty-cash"],
    ["Paid by company (GCash, Maya, cards)", peso(d.totals.corporatePaid), "wallet"],
    ["Paid by employees (to reimburse)", peso(d.totals.employeePaid), "payroll"],
    ["Unapproved", peso(d.unapproved.amount), "approvals", `${d.unapproved.count} claim${d.unapproved.count === 1 ? "" : "s"} in the workflow`],
    ["Unreconciled", String(d.unreconciled.claims + d.unreconciled.exceptions), "reconcile", `${d.unreconciled.claims} claims not on a statement · ${d.unreconciled.exceptions} charges with no claim`],
  ];
  const bva = d.budgetVsActual;
  const pct = Number(bva.budget) > 0 ? (Number(bva.actual) / Number(bva.budget)) * 100 : 0;
  return (
    <>
      <div className="top">
        <h1>Dashboard</h1>
        <form className="row noprint" style={{ alignItems: "end" }}>
          <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
          <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
          <div style={{ flex: 0 }}><button>Show</button></div>
        </form>
      </div>
      <p className="muted">Amounts are the expense cost (net of input VAT) of claims cleared by finance. Unapproved counts claims still in the workflow.</p>
      <div className="grid">
        {tiles.map(([l, n, icon, sub]) => <div key={l} className="card stat"><span className="stat-icon"><Icon name={icon} size={18} /></span><div className="n">{n}</div><div className="l">{l}</div>{sub && <div className="l">{sub}</div>}</div>)}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Travel budget vs actual, {bva.year}</h3>
        {bva.hasBudget ? (
          <>
            <div className="hbar"><span className="lbl">Actual vs budget</span><span className="track"><i className={pct > 100 ? "over" : ""} style={{ width: `${Math.min(100, pct)}%` }} /></span><b>{Math.round(pct)}%</b><span /></div>
            <p className="muted">{peso(bva.actual)} spent of {peso(bva.budget)} budgeted on the mapped travel and transportation accounts. {Number(bva.variance) >= 0 ? `${peso(bva.variance)} left.` : `Over by ${peso(String(-Number(bva.variance)))}.`}</p>
          </>
        ) : <p className="muted">No {bva.year} budget on the travel and transportation accounts. Add one in <Link href="/reports/budget-vs-actual">Budget vs Actual</Link>.</p>}
      </div>
      <div className="grid2">
        <Breakdown title="By department" rows={d.byDepartment} />
        <Breakdown title="By employee" rows={d.byEmployee} />
        <Breakdown title="Top travelers" rows={d.topTravelers} />
        <Breakdown title="Top delivery users" rows={d.topDeliveryUsers} />
        <Breakdown title="By project" rows={d.byProject} />
        <Breakdown title="By provider" rows={d.byProvider} />
        <Breakdown title="By payment" rows={d.byPayment} />
        <Breakdown title="By module" rows={d.byModule} />
      </div>
    </>
  );
}
