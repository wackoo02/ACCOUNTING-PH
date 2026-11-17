// Veritus AI ERP assistant. Answers questions about the company's books from a live snapshot of the
// ledger and sub-ledgers. With ANTHROPIC_API_KEY set, Claude writes the answer from that snapshot;
// without it, common questions are answered directly from the same figures.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { Role } from "@prisma/client";
import { prisma } from "./db";
import { businessInsights, dashboardData, topCustomers, topProducts, manilaToday } from "./dashboard";
import { fiscalStart } from "./budgets";
import { fiscalYearOf } from "./ledger/service";
import { kpis } from "./ledger/reports";
import { formatQty } from "./inventory/qty";

const MODEL = process.env.ASSISTANT_MODEL || "claude-sonnet-5-5";

export type AssistantLink = { label: string; href: string };
export type AssistantReply = { answer: string; links: AssistantLink[]; source: "ai" | "rules" };

const peso = (n: bigint | number) => `₱${(typeof n === "bigint" ? Number(n) / 100 : n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

async function snapshot(organizationId: string, role: Role) {
  const today = manilaToday();
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const fy = fiscalYearOf(org.fiscalYearStartMonth, today);
  const { start } = await fiscalStart(organizationId, fy);
  const d = await dashboardData(organizationId, { today, months: 6 });
  const [ins, cust, prod, k, payslips] = await Promise.all([
    businessInsights(organizationId, role, d),
    topCustomers(organizationId, start, today),
    topProducts(organizationId, start, today),
    kpis(organizationId, start, today),
    prisma.payrollRun.findFirst({ where: { organizationId }, orderBy: { periodEnd: "desc" }, include: { payslips: { select: { gross: true, netPay: true, withholdingTax: true } } } }).catch(() => null),
  ]);
  return { org, today, fy, start, d, ins, cust, prod, k, payroll: payslips };
}
type Snap = Awaited<ReturnType<typeof snapshot>>;

function snapshotText(s: Snap) {
  const L: string[] = [];
  L.push(`Company: ${s.org.name}. Today (Manila): ${ymd(s.today)}. Fiscal year ${s.fy} started ${ymd(s.start)}. Base currency PHP.`);
  L.push("Key balances (today vs last month-end):");
  for (const x of s.d.kpis) L.push(`- ${x.label}: ${peso(x.value)} (prior ${peso(x.prior)}${x.changePct === null ? "" : `, ${x.changePct >= 0 ? "+" : ""}${x.changePct.toFixed(1)}%`} ${x.compare})`);
  L.push(`FY to date: revenue ${peso(s.k.revenue)}, gross profit ${peso(s.k.grossProfit)}, operating expenses ${peso(s.k.opex)}, net profit ${peso(s.k.netProfit)}, working capital ${peso(s.k.workingCapital)}, current ratio ${s.k.currentRatio ?? "n/a"}.`);
  L.push("Monthly revenue / cash inflow / cash outflow (pesos):");
  for (const m of s.d.series) L.push(`- ${m.key}: revenue ${m.revenue.toFixed(2)}, inflow ${m.inflow.toFixed(2)}, outflow ${m.outflow.toFixed(2)}`);
  L.push("Top customers by amount billed FY to date:");
  for (const c of s.cust) L.push(`- ${c.name} (${c.code}): ${peso(c.amount)}`);
  L.push(`Top products by quantity (${s.prod.basis === "sales" ? "sales invoices" : "stock issues"}) FY to date:`);
  for (const p of s.prod.rows) L.push(`- ${p.name}: ${p.qty} ${p.unit}${p.amount !== null ? `, sales ${peso(p.amount)}` : ""}`);
  L.push(`Overdue receivables: ${peso(s.ins.ar.total)} total.`);
  for (const a of s.ins.ar.list.slice(0, 10)) L.push(`- ${a.name}: ${peso(a.amount)}, ${a.count} invoice(s), oldest ${s.ins.ar.days(a.oldest)} days past due`);
  L.push(`Items at or below reorder point: ${s.ins.stock.length}.`);
  for (const i of s.ins.stock.slice(0, 10)) L.push(`- ${i.code} ${i.name}: on hand ${formatQty(i.qty)} ${i.unit ?? ""}, reorder point ${formatQty(i.reorderPoint)}${i.warehouseCode ? `, warehouse ${i.warehouseCode}` : ""}`);
  L.push("BIR filings:");
  for (const t of s.ins.tax.overdue.slice(0, 5)) L.push(`- NOT FILED: ${t.label}, ${t.period.label}, was due ${ymd(t.due)}`);
  for (const t of s.ins.tax.upcoming) L.push(`- Upcoming: ${t.label}, ${t.period.label}, due ${ymd(t.due)}`);
  L.push("Waiting for approval:");
  for (const p of s.ins.pending) L.push(`- ${p.text}`);
  if (s.payroll) {
    const g = s.payroll.payslips.reduce((t, p) => t + Number(p.gross), 0), n = s.payroll.payslips.reduce((t, p) => t + Number(p.netPay), 0), w = s.payroll.payslips.reduce((t, p) => t + Number(p.withholdingTax), 0);
    L.push(`Latest payroll run ${s.payroll.number} ${ymd(s.payroll.periodStart)} to ${ymd(s.payroll.periodEnd)} (${s.payroll.status}): ${s.payroll.payslips.length} employees, gross ${peso(g)}, net pay ${peso(n)}, withholding tax ${peso(w)}.`);
  }
  return L.join("\n");
}

const PAGES: AssistantLink[] = [
  { label: "Customer aging", href: "/receivables/aging" }, { label: "AP aging", href: "/ap/aging" },
  { label: "VAT return (2550Q)", href: "/tax/returns/2550Q" }, { label: "Tax calendar", href: "/tax" },
  { label: "Stock status (below reorder)", href: "/inventory?below=1" }, { label: "Payroll runs", href: "/payroll" },
  { label: "Payroll reports", href: "/payroll/reports" }, { label: "Income statement", href: "/reports/income-statement" },
  { label: "Balance sheet", href: "/reports/balance-sheet" }, { label: "Cash flow", href: "/reports/cash-flow" },
  { label: "Sales invoices", href: "/receivables" }, { label: "Bank reconciliation", href: "/bank/reconcile" },
];

/** Answers the common questions straight from the snapshot (used without an API key, or if the AI call fails). */
function ruleAnswer(q: string, s: Snap): AssistantReply {
  const t = q.toLowerCase();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  const reply = (answer: string, links: AssistantLink[]): AssistantReply => ({ answer, links, source: "rules" });
  if (has("overdue", "receivable", "collect", "aging", "utang")) {
    const a = s.ins.ar;
    if (!a.list.length) return reply("No customer invoices are past due right now.", [PAGES[0]]);
    return reply(`${peso(a.total)} is overdue from ${a.list.length} customer${a.list.length === 1 ? "" : "s"}:\n` + a.list.slice(0, 5).map((x) => `• ${x.name}: ${peso(x.amount)} (${a.days(x.oldest)} days past due)`).join("\n"), [PAGES[0], { label: "Statements of account", href: "/receivables/statement" }]);
  }
  if (has("vat", "2550", "tax", "bir", "filing")) {
    const lines = [...s.ins.tax.overdue.slice(0, 3).map((x) => `• Not filed: ${x.label}, ${x.period.label} (was due ${ymd(x.due)})`), ...s.ins.tax.upcoming.map((x) => `• ${x.label}, ${x.period.label}: due ${ymd(x.due)}`)];
    const q = Math.floor(s.today.getUTCMonth() / 3) + 1;
    return reply(`Here is where your BIR filings stand:\n${lines.join("\n") || "• Nothing due soon."}\n\nThe VAT return is computed from the tax ledger: open 2550Q for Q${q} ${s.today.getUTCFullYear()} to review, then file.`, [{ label: `VAT return Q${q}`, href: `/tax/returns/2550Q?year=${s.today.getUTCFullYear()}&n=${q}` }, PAGES[3], { label: "SLSP", href: "/tax/lists/slsp" }]);
  }
  if (has("stock", "inventory", "reorder", "item")) {
    const st = s.ins.stock;
    if (!st.length) return reply(`No items are at or below their reorder point. Inventory is valued at ${peso(s.d.kpis[4].value)}.`, [PAGES[4]]);
    return reply(`${st.length} item${st.length === 1 ? " is" : "s are"} at or below reorder point:\n` + st.slice(0, 8).map((i) => `• ${i.code} ${i.name}: ${formatQty(i.qty)} ${i.unit ?? ""} on hand (reorder at ${formatQty(i.reorderPoint)})`).join("\n"), [PAGES[4], { label: "Purchase requests", href: "/purchasing/requests" }]);
  }
  if (has("payroll", "salary", "salaries", "payslip")) {
    const p = s.payroll;
    if (!p) return reply("No payroll run has been prepared yet.", [PAGES[5]]);
    const g = p.payslips.reduce((x, y) => x + Number(y.gross), 0), n = p.payslips.reduce((x, y) => x + Number(y.netPay), 0), w = p.payslips.reduce((x, y) => x + Number(y.withholdingTax), 0);
    return reply(`Latest payroll ${p.number} (${ymd(p.periodStart)} to ${ymd(p.periodEnd)}, ${p.status.toLowerCase()}):\n• ${p.payslips.length} employees\n• Gross pay ${peso(g)}\n• Withholding tax ${peso(w)}\n• Net pay ${peso(n)}`, [{ label: "Open payroll run", href: `/payroll/${p.id}` }, PAGES[6]]);
  }
  if (has("customer", "sales by", "client")) {
    if (!s.cust.length) return reply("No sales have been posted to customers this fiscal year yet.", [PAGES[10]]);
    return reply(`Sales by customer, FY${s.fy} to date:\n` + s.cust.map((c, i) => `${i + 1}. ${c.name}: ${peso(c.amount)}`).join("\n"), [PAGES[10], PAGES[0]]);
  }
  if (has("cash", "bank", "liquid")) {
    const k = s.d.kpis[1];
    return reply(`Cash balance is ${peso(k.value)} (${peso(k.prior)} at last month-end). Over the last 6 months cash in was ${peso(s.d.series.reduce((a, m) => a + m.inflow, 0))} and cash out ${peso(s.d.series.reduce((a, m) => a + m.outflow, 0))}.`, [PAGES[9], PAGES[11]]);
  }
  if (has("profit", "revenue", "income", "sales", "margin")) {
    return reply(`FY${s.fy} to date: revenue ${peso(s.k.revenue)}, gross profit ${peso(s.k.grossProfit)}${s.k.grossMarginPct === null ? "" : ` (${s.k.grossMarginPct.toFixed(1)}% margin)`}, net profit ${peso(s.k.netProfit)}. This month so far: ${peso(s.d.kpis[0].value)}.`, [PAGES[7], PAGES[8]]);
  }
  if (has("payable", "supplier", "vendor", "bill")) {
    return reply(`Trade payables total ${peso(s.d.kpis[3].value)} (${peso(s.d.kpis[3].prior)} at last month-end).`, [PAGES[1], { label: "Payment schedule", href: "/ap/schedule" }]);
  }
  if (has("approv", "pending")) {
    return reply(s.ins.pending.length ? s.ins.pending.map((p) => `• ${p.text}`).join("\n") : "Nothing is waiting for approval.", s.ins.pending.map((p) => ({ label: p.text, href: p.href })).slice(0, 3));
  }
  return reply("I can answer questions about receivables, payables, cash, sales, inventory, payroll and BIR filings. Try one of the suggestions, or ask something like \"Which customers are overdue?\"", PAGES.slice(0, 4));
}

export async function askAssistant(organizationId: string, role: Role, question: string, history: { role: "user" | "assistant"; content: string }[] = []): Promise<AssistantReply> {
  const s = await snapshot(organizationId, role);
  const fallback = ruleAnswer(question, s);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return fallback;
  try {
    const res = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 900,
      system: [
        `You are the Veritus ERP assistant for ${s.org.name}, a Philippine company. Answer the user's question using only the company data below.`,
        "Amounts are in Philippine pesos; write them like ₱1,234,567.00. Be brief: a short answer, then at most six bullet points. Use plain text with • bullets, no Markdown headings or tables.",
        "If the data does not cover the question, say what is missing and which Veritus page to open. Never invent figures. Follow PFRS/IFRS and BIR terms.",
        `Veritus pages you may point to: ${PAGES.map((p) => `${p.label} (${p.href})`).join(", ")}.`,
        "",
        "COMPANY DATA",
        snapshotText(s),
      ].join("\n"),
      messages: [...history.slice(-6), { role: "user", content: question.slice(0, 2000) }],
    });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    if (!text) return fallback;
    const links = PAGES.filter((p) => text.includes(p.href) || text.toLowerCase().includes(p.label.toLowerCase())).slice(0, 3);
    return { answer: text, links: links.length ? links : fallback.links, source: "ai" };
  } catch (e) {
    console.error("assistant", e);
    return fallback;
  }
}
