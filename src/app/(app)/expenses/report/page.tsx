import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { employeeExpenseReport } from "@/lib/expense/service";
import { firstOfYear, parseDateParam, today } from "@/lib/format";
import { MODULES, PAYMENTS, type ModuleKey, type PaymentKey } from "@/lib/expense/catalog";
import { StatusBadge, peso } from "@/components/ExpenseUi";
import { MasterPicker } from "@/components/MasterPicker";
import { empOpts } from "@/lib/lookup";

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const MODS = Object.keys(MODULES) as ModuleKey[];

export default async function EmployeeReport({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const from = parseDateParam(sp.from, firstOfYear()), to = parseDateParam(sp.to, today());
  const employeeId = one(sp.employeeId), pending = one(sp.pending) === "1";
  const [rows, emps] = await Promise.all([
    employeeExpenseReport(ctx.org.id, { from, to, employeeId: employeeId || null, includePending: pending }),
    prisma.employee.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } }),
  ]);
  const grand = rows.reduce((s, r) => s + Number(r.total), 0);
  return (
    <>
      <div className="top">
        <h1>Employee expense report</h1>
        <form className="row noprint" style={{ alignItems: "end" }}>
          <div><label>Employee / partner</label><MasterPicker name="employeeId" ariaLabel="Employee / partner" defaultValue={employeeId} emptyLabel="Everyone" placeholder="Everyone" options={empOpts(emps)} /></div>
          <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
          <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
          <div><label>Include</label><select name="pending" defaultValue={pending ? "1" : ""}><option value="">Cleared only</option><option value="1">Also claims in the workflow</option></select></div>
          <div style={{ flex: 0 }}><button>Show</button></div>
        </form>
      </div>
      <p className="muted">{from} to {to}. Cost is net of input VAT. Reimbursable is what the company still owes the employee for cleared claims they paid themselves.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Employee</th>{MODS.map((k) => <th key={k} className="num">{MODULES[k].label}</th>)}<th className="num">Claims</th><th className="num">Total cost</th><th className="num">Reimbursable</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.employee.id ?? "none"}><td>{r.employee.name}{r.employee.code ? <span className="muted"> {r.employee.code}</span> : null}{r.employee.isPartner ? <span className="badge X-APPROVED" style={{ marginLeft: 6 }}>Partner</span> : null}</td>{MODS.map((k) => <td key={k} className="num">{Number(r.byModule[k]) ? peso(r.byModule[k]) : ""}</td>)}<td className="num">{r.count}</td><td className="num"><b>{peso(r.total)}</b></td><td className="num">{Number(r.reimbursable) ? peso(r.reimbursable) : ""}</td></tr>)}</tbody>
        <tfoot><tr><th>Total</th>{MODS.map((k) => <th key={k} className="num">{peso(rows.reduce((s, r) => s + Number(r.byModule[k]), 0).toFixed(2))}</th>)}<th className="num">{rows.reduce((s, r) => s + r.count, 0)}</th><th className="num">{peso(grand.toFixed(2))}</th><th /></tr></tfoot>
      </table></div>
      {rows.filter((r) => r.lines.length).map((r) => (
        <div className="card" key={`d-${r.employee.id ?? "none"}`}>
          <h3 style={{ marginTop: 0 }}>{r.employee.name} · {peso(r.total)}</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>Claim</th><th>Module</th><th>Purpose / description</th><th>Paid by</th><th>Status</th><th className="num">VAT</th><th className="num">Cost</th></tr></thead>
            <tbody>{r.lines.map((l) => <tr key={l.id}><td>{l.date}</td><td><Link href={`/expenses/claims/${l.id}`}>{l.number}</Link></td><td>{MODULES[l.module as ModuleKey].label}</td><td>{l.purpose ?? l.description}</td><td>{PAYMENTS[l.payment as PaymentKey].label.replace("I paid (reimburse me)", "Employee")}</td><td><StatusBadge status={l.status} /></td><td className="num">{Number(l.vat) ? peso(l.vat) : ""}</td><td className="num">{peso(l.cost)}</td></tr>)}</tbody>
          </table></div>
        </div>
      ))}
    </>
  );
}
