import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { employeeName } from "@/lib/hr/service";

const peso = (n: unknown) => Number(n ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function PayrollEmployees() {
  const ctx = await requireCtx("payroll.process");
  const emps = await prisma.employee.findMany({ where: { organizationId: ctx.org.id, isPartner: false }, include: { shift: true, manager: true }, orderBy: { code: "asc" } });
  return (
    <>
      <div className="top"><h1>Employees and Pay</h1>
        <div className="row noprint" style={{ flex: 0, flexWrap: "nowrap", gap: 8 }}><Link className="btn secondary" href="/masters/employees">Employee master list (add / upload)</Link></div></div>
      <p className="muted">Add employees and their basic data in the master list (Excel upload works). Here you set each person's schedule, reporting manager, allowances, loans and portal login.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>No.</th><th>Name</th><th>Department</th><th>Position</th><th>Status</th><th>Pay basis</th><th className="num">Rate</th><th>Schedule</th><th>Reports to</th><th>Portal</th></tr></thead>
        <tbody>{emps.map((e) => (
          <tr key={e.id} style={e.isActive ? undefined : { opacity: 0.55 }}>
            <td><Link href={`/payroll/employees/${e.id}`}>{e.code}</Link></td><td>{employeeName(e)}{e.minimumWageEarner ? <span className="badge DRAFT" style={{ marginLeft: 6 }}>MWE</span> : null}</td>
            <td>{e.department}</td><td>{e.position}</td><td>{e.employmentStatus}</td><td>{e.payBasis ?? "MONTHLY"}</td><td className="num">{peso(e.basicRate)}</td>
            <td>{e.shift?.code ?? <span className="muted">none</span>}</td><td>{e.manager ? employeeName(e.manager) : <span className="muted">HR</span>}</td><td>{e.userId ? "✓" : ""}</td>
          </tr>
        ))}
        {emps.length === 0 && <tr><td colSpan={10} className="muted">No employees yet. Add them in the <Link href="/masters/employees">employee master list</Link>.</td></tr>}</tbody>
      </table></div>
    </>
  );
}
