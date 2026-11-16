"use client";
import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import type { mobilityDashboard } from "@/lib/expense/service";
import { ApiFail, api, peso } from "./api";
import { Chips, CountUp, Errors, Header, Spinner } from "./ui";
import type { Nav } from "./App";

type Dash = Awaited<ReturnType<typeof mobilityDashboard>>;
const ym = (d: Date) => d.toISOString().slice(0, 7);

export function Insights({ nav }: { nav: Nav }) {
  void nav;
  const [month, setMonth] = useState(ym(new Date()));
  const [ytd, setYtd] = useState(false);
  const [d, setD] = useState<Dash | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const from = ytd ? `${y}-01-01` : `${month}-01`;
    setD(null);
    api<Dash>("GET", `reports/dashboard?from=${from}&to=${last}`).then(setD).catch((e) => setErrors(e instanceof ApiFail ? e.errors : ["Failed"]));
  }, [month, ytd]);
  return (
    <div className="vm-page">
      <Header title="Insights" sub="Travel, transport and delivery spend" icon="activity" right={<input type="month" className="vm-month" value={month} onChange={(e) => setMonth(e.target.value)} />} />
      <Chips options={[{ value: "M", label: "Month" }, { value: "Y", label: "Year to date" }]} value={ytd ? "Y" : "M"} onChange={(v) => setYtd(v === "Y")} />
      <Errors errors={errors} />
      {!d ? <Spinner /> : (
        <>
          <div className="vm-kpis">
            <Kpi icon="transport" label="Transportation" value={Number(d.totals.transportation)} tone="orange" />
            <Kpi icon="sent-package" label="Delivery" value={Number(d.totals.delivery)} tone="teal" />
            <Kpi icon="approvals" label="Unapproved" value={Number(d.unapproved.amount)} tone="violet" sub={`${d.unapproved.count} claims`} />
            <Kpi icon="reconcile" label="Unreconciled" value={d.unreconciled.claims + d.unreconciled.exceptions} tone="rose" sub="claims + charges" count />
          </div>
          {d.budgetVsActual.hasBudget && (
            <div className="vm-card">
              <div className="vm-section-t">Travel budget {d.budgetVsActual.year}</div>
              <Bar label="Actual vs budget" value={Number(d.budgetVsActual.actual)} max={Number(d.budgetVsActual.budget)} />
              <div className="muted">{peso(d.budgetVsActual.actual)} of {peso(d.budgetVsActual.budget)} this period</div>
            </div>
          )}
          <Group title="By department" rows={d.byDepartment} />
          <Group title="Top travelers" rows={d.topTravelers} />
          <Group title="Top delivery users" rows={d.topDeliveryUsers} />
          <Group title="By project" rows={d.byProject} />
          <Group title="By provider" rows={d.byProvider} />
          <Group title="By payment" rows={d.byPayment} />
        </>
      )}
    </div>
  );
}

function Kpi({ icon, label, value, tone, sub, count }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; value: number; tone: string; sub?: string; count?: boolean }) {
  return (
    <div className={`vm-kpi tone-${tone}`}>
      <span className="ic"><Icon name={icon} size={20} /></span>
      <div className="l">{label}</div>
      <div className="n">{count ? value : <CountUp value={value} />}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return <div className="vm-bar"><span>{label}</span><div className="track"><i style={{ width: `${pct}%` }} className={value > max ? "over" : ""} /></div><b>{Math.round(pct)}%</b></div>;
}

function Group({ title, rows }: { title: string; rows: { key: string; label: string; amount: string; count: number }[] }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => Number(r.amount)), 1);
  return (
    <div className="vm-card">
      <div className="vm-section-t">{title}</div>
      {rows.slice(0, 6).map((r) => (
        <div key={r.key} className="vm-bar"><span>{r.label}</span><div className="track"><i style={{ width: `${(Number(r.amount) / max) * 100}%` }} /></div><b>{peso(r.amount)}</b></div>
      ))}
    </div>
  );
}
