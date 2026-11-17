// Data behind the home dashboard, the notification bell and the AI assistant.
// Every figure comes from POSTED, statutory-book entries in the general ledger or from the sub-ledgers,
// so the dashboard always agrees with the financial statements.
import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { toCentavos } from "./money";
import { can } from "./permissions";
import { deadlines } from "./tax/periods";
import { stockStatus } from "./inventory/reports";
import type { Role } from "@prisma/client";
import type { IconName } from "./icons";

const c = (d: { toString(): string } | null | undefined) => toCentavos(d?.toString() ?? "0");
const DAY = 864e5;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const utcDay = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
/** Today's date in Manila (the app's business day), as a UTC-midnight Date. */
export function manilaToday(now = new Date()) {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${s}T00:00:00Z`);
}

type Bucket = "cash" | "ar" | "ap" | "inventory" | "revenue";
type DayRow = { day: Date; bucket: Bucket; debit: Prisma.Decimal | null; credit: Prisma.Decimal | null };

/** Daily debit / credit totals for the dashboard's account buckets, up to and including `to`. */
async function dailyTotals(organizationId: string, to: Date) {
  return prisma.$queryRaw<DayRow[]>`
    SELECT je."date" AS day,
      CASE
        WHEN a."systemRole" = 'AR_CONTROL' THEN 'ar'
        WHEN a."systemRole" = 'AP_CONTROL' THEN 'ap'
        WHEN a."ifrsGroup" = 'Cash and cash equivalents' THEN 'cash'
        WHEN a."ifrsGroup" = 'Inventories' THEN 'inventory'
        WHEN a."ifrsGroup" = 'Revenue' THEN 'revenue'
      END AS bucket,
      SUM(jl."debit") AS debit, SUM(jl."credit") AS credit
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON je."id" = jl."journalEntryId"
    JOIN "Account" a ON a."id" = jl."accountId"
    WHERE jl."organizationId" = ${organizationId} AND je."status" = 'POSTED' AND je."book" = 'STATUTORY'
      AND je."source" <> 'CLOSING' AND je."date" <= ${to}
      AND (a."systemRole" IN ('AR_CONTROL', 'AP_CONTROL') OR a."ifrsGroup" IN ('Cash and cash equivalents', 'Inventories', 'Revenue'))
    GROUP BY 1, 2`;
}

export type Kpi = { key: string; label: string; value: bigint; prior: bigint; changePct: number | null; compare: string; href: string; icon: IconName; tone: string };
export type MonthPoint = { label: string; key: string; revenue: number; inflow: number; outflow: number };

const pctChange = (now: bigint, before: bigint) => (before === 0n ? null : Number(((now - before) * 1000n) / (before < 0n ? -before : before)) / 10);

export async function dashboardData(organizationId: string, opts: { months?: number; today?: Date } = {}) {
  const today = opts.today ?? manilaToday();
  const months = opts.months ?? 6;
  const rows = await dailyTotals(organizationId, today);

  const y = today.getUTCFullYear(), m = today.getUTCMonth(), d = today.getUTCDate();
  const lastMonthEnd = utcDay(y, m, 0);
  const lastMonthStart = utcDay(y, m - 1, 1);
  const monthStart = utcDay(y, m, 1);
  // Same number of days into last month (capped at its last day), for a like-for-like revenue comparison.
  const lastMonthSameDay = utcDay(y, m - 1, Math.min(d, lastMonthEnd.getUTCDate()));

  // Balances (debit-positive for assets, credit-positive for liabilities / revenue).
  const sign = (b: Bucket) => (b === "ap" || b === "revenue" ? -1n : 1n);
  const bal = (b: Bucket, upTo: Date, from?: Date) => rows
    .filter((r) => r.bucket === b && r.day <= upTo && (!from || r.day >= from))
    .reduce((s, r) => s + (c(r.debit) - c(r.credit)) * sign(b), 0n);

  const revenueMtd = bal("revenue", today, monthStart);
  const revenuePrior = bal("revenue", lastMonthSameDay, lastMonthStart);
  const kpi = (key: Bucket, label: string, href: string, icon: IconName, tone: string): Kpi => {
    const value = bal(key, today), prior = bal(key, lastMonthEnd);
    return { key, label, value, prior, changePct: pctChange(value, prior), compare: "vs. last month-end", href, icon, tone };
  };
  const kpis: Kpi[] = [
    { key: "revenue", label: "Revenue this month", value: revenueMtd, prior: revenuePrior, changePct: pctChange(revenueMtd, revenuePrior), compare: "vs. last month, same days", href: "/reports/income-statement", icon: "income-statement", tone: "green" },
    kpi("cash", "Cash balance", "/bank", "wallet", "blue"),
    kpi("ar", "Total receivables", "/receivables/aging", "receivables", "orange"),
    kpi("ap", "Total payables", "/ap/aging", "payables", "purple"),
    kpi("inventory", "Inventory value", "/inventory/reports/valuation", "inventory", "teal"),
  ];

  const series: MonthPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const s = utcDay(y, m - i, 1), e = utcDay(y, m - i + 1, 0);
    const inMonth = rows.filter((r) => r.day >= s && r.day <= e);
    const sum = (b: Bucket, f: (r: DayRow) => bigint) => inMonth.filter((r) => r.bucket === b).reduce((t, r) => t + f(r), 0n);
    series.push({
      key: ymd(s).slice(0, 7),
      label: s.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      revenue: Number(sum("revenue", (r) => c(r.credit) - c(r.debit))) / 100,
      inflow: Number(sum("cash", (r) => c(r.debit))) / 100,
      outflow: Number(sum("cash", (r) => c(r.credit))) / 100,
    });
  }
  return { today, kpis, series, revenueMtd, revenuePrior };
}

/** Customers ranked by amounts billed to them (sales posted to the AR control account) in the period. */
export async function topCustomers(organizationId: string, from: Date, to: Date, take = 5) {
  const rows = await prisma.journalLine.groupBy({
    by: ["partyId"],
    where: { organizationId, partyType: "CUSTOMER", debit: { gt: 0 }, account: { systemRole: "AR_CONTROL" }, journalEntry: { status: "POSTED", book: "STATUTORY", source: "SALES", date: { gte: from, lte: to } } },
    _sum: { debit: true },
  });
  const ranked = rows.filter((r) => r.partyId).map((r) => ({ code: r.partyId!, amount: c(r._sum.debit) })).sort((a, b) => (b.amount > a.amount ? 1 : -1)).slice(0, take);
  const custs = await prisma.customer.findMany({ where: { organizationId, code: { in: ranked.map((r) => r.code) } }, select: { id: true, code: true, name: true } });
  return ranked.map((r) => {
    const k = custs.find((x) => x.code === r.code);
    return { ...r, id: k?.id ?? null, name: k?.name ?? r.code };
  });
}

/** Products ranked by quantity sold: posted sales invoice lines, or stock issues when invoicing is not used. */
export async function topProducts(organizationId: string, from: Date, to: Date, take = 5) {
  const lines = await prisma.salesInvoiceLine.groupBy({
    by: ["productId"],
    where: { productId: { not: null }, invoice: { organizationId, kind: "INVOICE", status: "POSTED", date: { gte: from, lte: to } } },
    _sum: { quantity: true, netAmount: true },
  });
  let ranked: { productId: string; qty: number; amount: bigint | null }[] = lines.map((l) => ({ productId: l.productId!, qty: Number(l._sum.quantity ?? 0), amount: c(l._sum.netAmount) }));
  let basis: "sales" | "issues" = "sales";
  if (ranked.length === 0) {
    basis = "issues";
    const moves = await prisma.inventoryMove.groupBy({ by: ["itemId"], where: { organizationId, type: "ISSUE", date: { gte: from, lte: to } }, _sum: { qty: true } });
    ranked = moves.map((mv) => ({ productId: mv.itemId, qty: -Number(mv._sum.qty ?? 0), amount: null }));
  }
  ranked = ranked.filter((r) => r.qty > 0).sort((a, b) => b.qty - a.qty).slice(0, take);
  const prods = await prisma.product.findMany({ where: { id: { in: ranked.map((r) => r.productId) } }, select: { id: true, code: true, name: true, unit: true } });
  return { basis, rows: ranked.map((r) => { const p = prods.find((x) => x.id === r.productId); return { ...r, code: p?.code ?? "", name: p?.name ?? "Item", unit: p?.unit ?? "" }; }) };
}

// ---------- Recent activity (from the audit trail) ----------

const ENTITY: Record<string, { label: string; href?: (id: string) => string; icon: IconName }> = {
  journal: { label: "Journal entry", href: (id) => `/journals/${id}`, icon: "journal" },
  sales_invoice: { label: "Sales invoice", href: (id) => `/receivables/${id}`, icon: "receivables" },
  ar_receipt: { label: "Collection", href: (id) => `/receivables/collections/${id}`, icon: "cash" },
  ap_bill: { label: "Supplier bill", href: (id) => `/ap/bills/${id}`, icon: "payables" },
  ap_payment: { label: "Payment voucher", href: (id) => `/ap/payments/${id}`, icon: "cash-out" },
  purchase_order: { label: "Purchase order", href: (id) => `/purchasing/orders/${id}`, icon: "cart" },
  purchase_request: { label: "Purchase request", href: (id) => `/purchasing/requests/${id}`, icon: "journal-new" },
  inventory: { label: "Inventory transaction", href: (id) => `/inventory/transactions/${id}`, icon: "inventory" },
  cash: { label: "Cash voucher", href: (id) => `/cash/${id}`, icon: "cash" },
  fixed_asset: { label: "Fixed asset", href: (id) => `/assets/${id}`, icon: "fixed-assets" },
  depreciation_run: { label: "Depreciation run", href: () => "/assets/depreciation", icon: "recurring" },
  payroll: { label: "Payroll run", href: (id) => `/payroll/${id}`, icon: "payroll" },
  goods_receipt: { label: "Receiving report", href: (id) => `/purchasing/receipts/${id}`, icon: "receive" },
  tax: { label: "Tax return", href: () => "/tax", icon: "bir" },
  pettycash_voucher: { label: "Expense voucher", href: () => "/expenses/claims", icon: "claims" },
  loan: { label: "Loan", href: (id) => `/debt/${id}`, icon: "debt" },
  lease: { label: "Lease", href: (id) => `/leases/${id}`, icon: "leases" },
};
const VERB: Record<string, string> = {
  create: "created", update: "updated", submit: "submitted for approval", approve: "approved", post: "posted", void: "voided", reject: "returned",
  create_post: "posted", create_submit: "submitted for approval", approve_post: "approved and posted", add: "added", dispose: "disposed",
  depreciation_run: "posted", file: "filed", finalize: "finalized", release: "released", import: "imported", delete: "deleted", email: "emailed",
};

export async function recentActivity(organizationId: string, take = 6) {
  const logs = await prisma.auditLog.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: take * 4 });
  const out: { id: string; text: string; at: Date; href?: string; icon: IconName }[] = [];
  const seen = new Set<string>();
  for (const l of logs) {
    if (out.length >= take) break;
    // One line per document: its latest step (e.g. "approved", not also "submitted" and "created").
    if (seen.has(`${l.entity}:${l.entityId}`)) continue;
    seen.add(`${l.entity}:${l.entityId}`);
    const [, verbKey = l.action] = l.action.split(/\.(.+)/);
    // A sub-ledger posting writes its own journal at the same moment; show the business document, not both.
    if (l.entity === "journal" && verbKey === "create_post" && logs.some((o) => o.entity !== "journal" && Math.abs(o.createdAt.getTime() - l.createdAt.getTime()) < 3000)) continue;
    const e = ENTITY[l.entity];
    const det = (l.details ?? {}) as Record<string, unknown>;
    const ref = String(det.number ?? det.code ?? "").trim();
    const label = e?.label ?? l.entity.replace(/[_-]+/g, " ").replace(/^\w/, (s) => s.toUpperCase());
    out.push({ id: l.id, text: `${label}${ref ? ` ${ref}` : ""} ${VERB[verbKey] ?? verbKey.replace(/_/g, " ")}`, at: l.createdAt, href: e?.href?.(l.entityId), icon: e?.icon ?? "activity" });
  }
  return out;
}

// ---------- Alerts: notifications and business insights ----------

export type Alert = { id: string; tone: "danger" | "warn" | "ok" | "info"; title: string; detail: string; href: string; icon: IconName };

export async function pendingWork(organizationId: string, role: Role) {
  const approver = can(role, "journal.post");
  const [je, si, rc, cash, bills, inv, pcv] = await Promise.all([
    prisma.journalEntry.count({ where: { organizationId, status: "PENDING_APPROVAL" } }),
    prisma.salesInvoice.count({ where: { organizationId, status: "PENDING_APPROVAL" } }),
    prisma.arReceipt.count({ where: { organizationId, status: "PENDING_APPROVAL" } }),
    prisma.cashTransaction.count({ where: { organizationId, status: "PENDING_APPROVAL" } }),
    prisma.apBill.count({ where: { organizationId, status: "PENDING_APPROVAL" } }),
    prisma.inventoryTransaction.count({ where: { organizationId, status: "PENDING_APPROVAL" } }),
    prisma.pettyCashVoucher.count({ where: { organizationId, status: "SUBMITTED" } }),
  ]);
  const items = [
    { n: je, label: "journal entr", plural: ["y", "ies"], href: "/journals?status=PENDING_APPROVAL", show: approver },
    { n: si, label: "sales document", href: "/receivables?status=PENDING_APPROVAL", show: approver },
    { n: rc, label: "collection", href: "/receivables/collections?status=PENDING_APPROVAL", show: approver },
    { n: cash, label: "cash voucher", href: "/cash?status=PENDING_APPROVAL", show: approver },
    { n: bills, label: "supplier bill", href: "/ap/approvals", show: true },
    { n: inv, label: "inventory adjustment", href: "/inventory/transactions?status=PENDING_APPROVAL", show: can(role, "inventory.approve") },
    { n: pcv, label: "expense claim", href: "/expenses/claims?q=manager", show: true },
  ].filter((i) => i.show && i.n > 0);
  return items.map((i) => ({ n: i.n, href: i.href, text: `${i.n} ${i.label}${i.plural ? (i.n === 1 ? i.plural[0] : i.plural[1]) : i.n === 1 ? "" : "s"} waiting for approval` }));
}

export async function overdueReceivables(organizationId: string, today: Date) {
  const inv = await prisma.salesInvoice.findMany({
    where: { organizationId, kind: "INVOICE", status: "POSTED", dueDate: { lt: today } },
    select: { customerId: true, customerName: true, dueDate: true, totalAmount: true, appliedAmount: true, ewtAmount: true, fxRate: true },
  });
  const by = new Map<string, { customerId: string; name: string; amount: bigint; oldest: Date; count: number }>();
  for (const i of inv) {
    const open = c(i.totalAmount) - c(i.appliedAmount);
    if (open <= 0n) continue;
    const base = (open * toCentavos(Number(i.fxRate).toFixed(2))) / 100n;
    const cur = by.get(i.customerId) ?? { customerId: i.customerId, name: i.customerName, amount: 0n, oldest: i.dueDate, count: 0 };
    cur.amount += base; cur.count++; if (i.dueDate < cur.oldest) cur.oldest = i.dueDate;
    by.set(i.customerId, cur);
  }
  const list = [...by.values()].sort((a, b) => (b.amount > a.amount ? 1 : -1));
  return { list, total: list.reduce((s, r) => s + r.amount, 0n), days: (d: Date) => Math.round((today.getTime() - d.getTime()) / DAY) };
}

export async function lowStock(organizationId: string) {
  const r = await stockStatus(organizationId, { belowOnly: true });
  return r.rows;
}

export async function nextFilings(organizationId: string, today: Date) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { vatRegistered: true } });
  const y = today.getUTCFullYear();
  const all = [...deadlines(y - 1, org.vatRegistered), ...deadlines(y, org.vatRegistered), ...deadlines(y + 1, org.vatRegistered)];
  const filed = await prisma.taxReturn.findMany({ where: { organizationId, status: "FILED", periodFrom: { gte: utcDay(y - 1, 0, 1) } }, select: { form: true, periodFrom: true } });
  const isFiled = (f: string, from: Date) => filed.some((r) => r.form === f && r.periodFrom.getTime() === from.getTime());
  const open = all.filter((x) => !isFiled(x.form, x.period.from) && x.form !== "2307");
  const overdue = open.filter((x) => x.due < today && x.due.getTime() > today.getTime() - 60 * DAY);
  const upcoming = open.filter((x) => x.due >= today).slice(0, 3);
  const days = (dd: Date) => Math.round((dd.getTime() - today.getTime()) / DAY);
  return { overdue, upcoming, days };
}

const peso = (n: bigint) => `₱${(Number(n) / 100).toLocaleString("en-PH", { maximumFractionDigits: 0 })}`;

/** Plain-language observations for the "Business insights" panel, most urgent first. */
export async function businessInsights(organizationId: string, role: Role, d: Awaited<ReturnType<typeof dashboardData>>) {
  const [stock, ar, tax, pending] = await Promise.all([lowStock(organizationId), overdueReceivables(organizationId, d.today), nextFilings(organizationId, d.today), pendingWork(organizationId, role)]);
  const out: Alert[] = [];
  if (stock.length) {
    const names = stock.slice(0, 2).map((s) => s.name).join(", ");
    out.push({ id: "stock", tone: "danger", icon: "alert", title: `${stock.length} item${stock.length === 1 ? " is" : "s are"} at or below reorder point`, detail: `${names}${stock.length > 2 ? " and more" : ""}. Reorder before you run out.`, href: "/inventory?below=1" });
  }
  if (ar.list.length) {
    const top = ar.list[0];
    out.push({ id: "ar", tone: "warn", icon: "aging", title: `${top.name} has overdue invoices`, detail: `${peso(top.amount)} is ${ar.days(top.oldest)} days past due${ar.list.length > 1 ? `; ${peso(ar.total)} overdue across ${ar.list.length} customers` : ""}.`, href: "/receivables/aging" });
  }
  if (tax.overdue.length) {
    const t = tax.overdue[0];
    out.push({ id: "tax-late", tone: "danger", icon: "bir", title: `${t.label} for ${t.period.label} is not filed`, detail: `It was due ${ymd(t.due)}. File and record it to stop penalties from growing.`, href: t.href });
  }
  const rev = d.kpis[0];
  if (rev.changePct !== null) {
    const up = rev.changePct >= 0;
    out.push({ id: "rev", tone: up ? "ok" : "warn", icon: "trend", title: `Revenue is ${up ? "up" : "down"} ${Math.abs(rev.changePct).toFixed(0)}% this month`, detail: `${peso(rev.value)} so far vs ${peso(rev.prior)} by the same day last month.`, href: "/reports/income-statement" });
  } else if (rev.value === 0n) {
    out.push({ id: "rev", tone: "info", icon: "trend", title: "No revenue posted yet this month", detail: "Post this month's sales invoices to see the trend.", href: "/receivables" });
  }
  if (tax.upcoming.length) {
    const t = tax.upcoming[0];
    const n = tax.days(t.due);
    out.push({ id: "tax", tone: "info", icon: "bir", title: `${t.label} due ${n === 0 ? "today" : `in ${n} day${n === 1 ? "" : "s"}`}`, detail: `${t.period.label}. Review the figures in the tax engine.`, href: t.href });
  }
  if (pending.length) {
    const total = pending.reduce((s, p) => s + p.n, 0);
    out.push({ id: "pending", tone: "info", icon: "approvals", title: `${total} document${total === 1 ? "" : "s"} waiting for approval`, detail: pending.slice(0, 2).map((p) => p.text).join("; "), href: pending[0].href });
  }
  return { insights: out, stock, ar, tax, pending };
}

/** Bell menu: items that need someone to act. */
export async function notifications(organizationId: string, role: Role): Promise<Alert[]> {
  const today = manilaToday();
  const [pending, tax, stock] = await Promise.all([pendingWork(organizationId, role), nextFilings(organizationId, today), lowStock(organizationId)]);
  const out: Alert[] = pending.map((p, i) => ({ id: `p${i}`, tone: "info", icon: "approvals", title: p.text, detail: "Open the approval queue", href: p.href }));
  for (const t of tax.overdue.slice(0, 3)) out.push({ id: `t-${t.form}-${t.n}-${ymd(t.due)}`, tone: "danger", icon: "bir", title: `${t.label} (${t.period.label}) not filed`, detail: `Was due ${ymd(t.due)}`, href: t.href });
  for (const t of tax.upcoming.filter((x) => tax.days(x.due) <= 7)) out.push({ id: `u-${t.form}-${t.n}`, tone: "warn", icon: "bir", title: `${t.label} due in ${tax.days(t.due)} days`, detail: t.period.label, href: t.href });
  if (stock.length) out.push({ id: "stock", tone: "warn", icon: "inventory", title: `${stock.length} item${stock.length === 1 ? "" : "s"} below reorder point`, detail: "Check stock status", href: "/inventory?below=1" });
  return out;
}
