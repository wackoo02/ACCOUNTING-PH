import Link from "next/link";
import { Suspense } from "react";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { kpis } from "@/lib/ledger/reports";
import { fiscalStart } from "@/lib/budgets";
import { fiscalYearOf } from "@/lib/ledger/service";
import { formatPeso } from "@/lib/money";
import { businessInsights, dashboardData, recentActivity, topCustomers, topProducts } from "@/lib/dashboard";
import { can } from "@/lib/permissions";
import { Icon } from "@/components/Icon";
import { CountUp } from "@/components/CountUp";
import { SalesTrend, CashFlowBars } from "@/components/dashboard/Charts";
import { AssistantPanel } from "@/components/dashboard/AssistantPanel";
import type { IconName } from "@/lib/icons";

const whole = (c: bigint) => formatPeso(c).replace(/\.\d\d(\)?)$/, "$1");
const pct = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)}%`);
const x2 = (n: number | null) => (n === null ? "—" : n.toFixed(2));

const MODULES: { label: string; href: string; icon: IconName; tone: string }[] = [
  { label: "Finance", href: "/journals", icon: "journal", tone: "green" },
  { label: "Cash and Bank", href: "/bank", icon: "bank", tone: "blue" },
  { label: "Sales", href: "/receivables", icon: "receivables", tone: "sky" },
  { label: "Purchasing", href: "/purchasing/orders", icon: "cart", tone: "purple" },
  { label: "Payables", href: "/ap/bills", icon: "payables", tone: "violet" },
  { label: "Inventory", href: "/inventory", icon: "inventory", tone: "orange" },
  { label: "HR and Payroll", href: "/payroll", icon: "payroll", tone: "teal" },
  { label: "Mobility", href: "/expenses", icon: "mobility", tone: "pink" },
  { label: "Fixed Assets", href: "/assets", icon: "fixed-assets", tone: "slate" },
  { label: "BIR Tax", href: "/tax", icon: "bir", tone: "red" },
  { label: "Reports", href: "/reports/custom", icon: "report-builder", tone: "indigo" },
];

function greeting(now: Date) {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", hourCycle: "h23" }).format(now));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ months?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const orgId = ctx.org.id;
  const sp = await searchParams;
  const months = sp.months === "12" ? 12 : 6;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const d = await dashboardData(orgId, { months });
  const fy = fiscalYearOf(org.fiscalYearStartMonth, d.today);
  const { start } = await fiscalStart(orgId, fy);
  const [ins, customers, products, activity, k] = await Promise.all([
    businessInsights(orgId, ctx.role, d),
    topCustomers(orgId, start, d.today),
    topProducts(orgId, start, d.today),
    recentActivity(orgId, 6),
    kpis(orgId, start, d.today),
  ]);
  const now = new Date();
  const first = ctx.user.name.split(/\s+/)[0];
  const dateLine = new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(now);
  const range = (
    <div className="seg" role="group" aria-label="Chart range">
      <Link href="/dashboard" className={months === 6 ? "on" : ""} scroll={false}>6M</Link>
      <Link href="/dashboard?months=12" className={months === 12 ? "on" : ""} scroll={false}>12M</Link>
    </div>
  );
  const time = (t: Date) => {
    const sameDay = t.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
    return new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", ...(sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" }) }).format(t);
  };

  return (
    <div className="home">
      <section className="hero">
        <div>
          <h1>{greeting(now)}, <span>{first}!</span></h1>
          <p>Here&apos;s what&apos;s happening with {ctx.org.name} today.</p>
        </div>
        <div className="hero-date"><strong>{dateLine}</strong><span>FY{fy} · books as of today</span></div>
        <div className="hero-quote">
          <em>Intelligent. Integrated.<br />Compliant.</em>
          <i />
        </div>
      </section>

      <div className="kpis">
        {d.kpis.map((t) => {
          const up = (t.changePct ?? 0) >= 0;
          return (
            <Link key={t.key} href={t.href} className="kpi card">
              <span className={`kpi-icon tone-${t.tone}`}><Icon name={t.icon} size={26} /></span>
              <span className="kpi-body">
                <span className="kpi-label">{t.label}</span>
                <span className="kpi-value"><CountUp text={`₱ ${whole(t.value)}`} /></span>
              </span>
              <span className="kpi-foot">
                {t.changePct === null ? <span className="chg flat">New</span> : <span className={`chg ${up ? "up" : "down"}`}>{up ? "↗" : "↘"} {up ? "+" : ""}{t.changePct.toFixed(Math.abs(t.changePct) < 10 ? 1 : 0)}%</span>}
                <span className="muted">{t.compare}</span>
              </span>
            </Link>
          );
        })}
      </div>

      <div className="home-grid">
        <div className="card panel">
          <div className="panel-head"><Icon name="trend" size={20} /><h2>Sales Trend</h2>{range}</div>
          <SalesTrend data={d.series} />
        </div>
        <div className="card panel">
          <div className="panel-head"><Icon name="cash-flow" size={20} /><h2>Cash Flow</h2>{range}</div>
          <CashFlowBars data={d.series} />
          <div className="legend"><span><i className="in" />Inflow</span><span><i className="out" />Outflow</span></div>
        </div>
        <div className="card panel">
          <div className="panel-head"><Icon name="sparkle" size={20} /><h2>Business Insights</h2><span className="ai-pill"><Icon name="sparkle" size={12} /> AI powered</span></div>
          <ul className="insights">
            {ins.insights.slice(0, 4).map((i) => (
              <li key={i.id}>
                <Link href={i.href}>
                  <span className={`ins-icon ${i.tone}`}><Icon name={i.icon} size={18} /></span>
                  <span><strong>{i.title}</strong><small>{i.detail}</small></span>
                </Link>
              </li>
            ))}
            {ins.insights.length === 0 && <li className="muted">All clear. Nothing needs your attention right now.</li>}
          </ul>
        </div>
        <div className="assistant-slot">
          <Suspense fallback={null}><AssistantPanel aiEnabled={!!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)} /></Suspense>
        </div>

        <div className="card panel">
          <div className="panel-head"><Icon name="customers" size={20} /><h2>Top Customers</h2><Link href="/receivables/aging" className="view-all">View all</Link></div>
          <ol className="rank">
            {customers.map((c, i) => (
              <li key={c.code}><span className="n">{i + 1}</span><span className="badge-av">{c.name.slice(0, 2).toUpperCase()}</span>
                <span className="nm">{c.id ? <Link href={`/receivables/statement?customer=${c.id}`}>{c.name}</Link> : c.name}</span><b>₱ {whole(c.amount)}</b></li>
            ))}
            {customers.length === 0 && <li className="muted empty">No customer sales posted in FY{fy} yet.</li>}
          </ol>
        </div>
        <div className="card panel">
          <div className="panel-head"><Icon name="products" size={20} /><h2>Top Products</h2><Link href="/inventory/reports/turnover" className="view-all">View all</Link></div>
          <ol className="rank">
            {products.rows.map((p, i) => (
              <li key={p.productId}><span className="n">{i + 1}</span><span className="badge-av prod"><Icon name="products" size={14} /></span>
                <span className="nm">{p.name}</span><b>{p.qty.toLocaleString("en-PH", { maximumFractionDigits: 2 })} {p.unit || "pcs"}</b></li>
            ))}
            {products.rows.length === 0 && <li className="muted empty">No items sold or issued in FY{fy} yet.</li>}
          </ol>
          {products.basis === "issues" && products.rows.length > 0 && <div className="panel-note">Based on stock issued (no itemized sales invoices yet).</div>}
        </div>
        <div className="card panel">
          <div className="panel-head"><Icon name="aging" size={20} /><h2>Recent Activities</h2>{can(ctx.role, "org.manage") && <Link href="/audit" className="view-all">View all</Link>}</div>
          <ul className="activity">
            {activity.map((a) => (
              <li key={a.id}>
                <span className="act-icon"><Icon name={a.icon} size={15} /></span>
                <span className="nm">{a.href ? <Link href={a.href}>{a.text}</Link> : a.text}</span>
                <time>{time(a.at)}</time>
              </li>
            ))}
            {activity.length === 0 && <li className="muted empty">No activity yet.</li>}
          </ul>
        </div>
      </div>

      <section className="card panel health">
        <div className="panel-head"><Icon name="ratio" size={20} /><h2>Financial health, FY{fy} to date</h2><Link href="/reports/income-statement" className="view-all">Statements</Link></div>
        <div className="health-row">
          <div><small>Revenue</small><b>₱ {whole(k.revenue)}</b></div>
          <div><small>Gross margin</small><b>{pct(k.grossMarginPct)}</b></div>
          <div><small>Net profit</small><b>₱ {whole(k.netProfit)}</b></div>
          <div><small>Net margin</small><b>{pct(k.netMarginPct)}</b></div>
          <div><small>Working capital</small><b>₱ {whole(k.workingCapital)}</b></div>
          <div><small>Current ratio</small><b>{x2(k.currentRatio)}</b></div>
          <div><small>Debt-to-equity</small><b>{x2(k.debtToEquity)}</b></div>
        </div>
      </section>

      <section className="card panel">
        <div className="panel-head"><h2>Quick Access to Modules</h2></div>
        <div className="modules">
          {MODULES.map((m) => (
            <Link key={m.href} href={m.href} className="module">
              <span className={`mod-icon tone-${m.tone}`}><Icon name={m.icon} size={22} /></span>
              <span>{m.label}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
