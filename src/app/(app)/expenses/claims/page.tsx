import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { listVouchers } from "@/lib/pettycash/service";
import { MODULES, PAYMENTS, PROVIDERS, type ModuleKey, type PaymentKey } from "@/lib/expense/catalog";
import { Icon } from "@/components/Icon";
import { MODULE_ICON, StatusBadge, peso } from "@/components/ExpenseUi";

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

const QUEUES: [string, string][] = [["", "All claims"], ["manager", "Manager approvals"], ["finance", "Finance review"], ["RETURNED", "Returned to employee"], ["CLEARED", "Cleared"]];

export default async function Claims({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const q = one(sp.q), module = one(sp.module), from = one(sp.from), to = one(sp.to);
  const isQueue = q === "manager" || q === "finance";
  const rows = await listVouchers(ctx.org.id, { userId: ctx.user.id, queue: isQueue ? q : null, status: !isQueue && q ? q : null, module: module || null, from: from || null, to: to || null });
  const total = rows.reduce((s, r) => s + Number(r.totalPaid), 0);
  const href = (k: string) => `/expenses/claims?${new URLSearchParams({ ...(k ? { q: k } : {}), ...(module ? { module } : {}) })}`;
  return (
    <>
      <div className="top"><h1>Claims</h1></div>
      <div className="subtabs">{QUEUES.map(([k, l]) => <Link key={k} href={href(k)} className={q === k ? "on" : ""}>{l}</Link>)}</div>
      <form className="row noprint" style={{ alignItems: "end", marginBottom: 12 }}>
        <input type="hidden" name="q" value={q} />
        <div><label>Module</label><select name="module" defaultValue={module}><option value="">All</option>{(Object.keys(MODULES) as ModuleKey[]).map((k) => <option key={k} value={k}>{MODULES[k].label}</option>)}</select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <p className="muted">Claims are captured in the Veritus Mobility app (open <a href="/m" target="_blank">/m</a> on a phone and add it to the home screen). Managers and finance can act on them here or in the app.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Claim</th><th>Module</th><th>Employee</th><th>Provider / supplier</th><th>Purpose</th><th>Paid by</th><th>Status</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={9} className="muted">Nothing here.</td></tr>}
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.receiptDate}</td>
              <td><Link href={`/expenses/claims/${r.id}`}>{r.number}</Link></td>
              <td><span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}><Icon name={MODULE_ICON[r.module]} size={15} />{MODULES[r.module as ModuleKey].label}</span></td>
              <td>{r.employee ? `${r.employee.name}` : <span className="muted">Fund</span>}</td>
              <td>{(r.provider && PROVIDERS[r.module as ModuleKey].find((p) => p.key === r.provider)?.name) || r.vendor.name}</td>
              <td>{r.purpose ?? r.description}</td>
              <td>{PAYMENTS[r.paymentMethod as PaymentKey].label.replace("I paid (reimburse me)", "Employee")}{r.paymentAccount ? ` · ${r.paymentAccount.code}` : ""}</td>
              <td><StatusBadge status={r.status} /></td>
              <td className="num">{peso(r.totalPaid)}</td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && <tfoot><tr><th colSpan={8}>{rows.length} claim{rows.length === 1 ? "" : "s"}</th><th className="num">{peso(total.toFixed(2))}</th></tr></tfoot>}
      </table></div>
    </>
  );
}
