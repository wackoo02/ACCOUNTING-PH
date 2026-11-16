import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import type { Form2316Data } from "@/lib/payroll/bir2316";
import { manilaToday } from "@/lib/payroll/attendance";
import { form2316Action } from "../../payroll-actions";

const peso = (n: unknown) => Number(n ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function Bir2316({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const ctx = await requireCtx("payroll.approve");
  const year = Number((await searchParams).year ?? manilaToday().slice(0, 4));
  const forms = await prisma.form2316.findMany({ where: { organizationId: ctx.org.id, year }, orderBy: { employeeId: "asc" } });
  const emps = new Map((await prisma.employee.findMany({ where: { id: { in: forms.map((f) => f.employeeId) } } })).map((e) => [e.id, e]));
  return (
    <>
      <div className="top"><h1>BIR Form 2316 - {year}</h1>
        <form className="row noprint" style={{ flex: 0, flexWrap: "nowrap" }}><div><input name="year" type="number" defaultValue={year} style={{ width: 100 }} /></div><div style={{ flex: 0 }}><button className="secondary">Show</button></div></form></div>
      <div className="card noprint">
        <p style={{ marginTop: 0 }}>Prepare drafts from finalized payrolls, review each one (open the PDF), then finalize. Only <b>released</b> forms appear in the employee portal.</p>
        <ActionForm action={form2316Action}><input type="hidden" name="op" value="generate" /><input type="hidden" name="year" value={year} /><button>Prepare / refresh drafts</button></ActionForm>
      </div>
      <ActionForm action={form2316Action}>
        <div className="table-wrap"><table>
          <thead><tr><th className="check"></th><th>Employee</th><th>TIN</th><th className="num">Gross compensation</th><th className="num">Non-taxable</th><th className="num">Taxable</th><th className="num">Tax due</th><th className="num">Tax withheld</th><th className="num">Difference</th><th>Status</th><th></th></tr></thead>
          <tbody>{forms.map((f) => {
            const d = f.data as unknown as Form2316Data;
            const e = emps.get(f.employeeId);
            const diff = Math.round((d.i24_taxDue - d.i26_totalWithheld) * 100) / 100;
            return (
              <tr key={f.id}><td className="check"><input type="checkbox" name="formId" value={f.id} /></td><td>{e?.code} {d.employee.name}</td><td>{d.employee.tin}</td>
                <td className="num">{peso(d.i19_gross)}</td><td className="num">{peso(d.i36_totalNonTax)}</td><td className="num">{peso(d.i50_totalTaxable)}</td><td className="num">{peso(d.i24_taxDue)}</td><td className="num">{peso(d.i26_totalWithheld)}</td>
                <td className={`num ${diff ? "diff-bad" : "diff-ok"}`}>{peso(diff)}</td><td><span className={`badge ${f.status}`}>{f.status}</span></td>
                <td><a href={`/api/payroll/pdf?doc=2316&employee=${f.employeeId}&year=${year}`} target="_blank">PDF</a></td></tr>
            );
          })}
          {forms.length === 0 && <tr><td colSpan={11} className="muted">No forms yet for {year}.</td></tr>}</tbody>
        </table></div>
        {forms.length > 0 && <div className="row noprint" style={{ marginTop: 10, gap: 8 }}>
          <div style={{ flex: 0 }}><button name="op" value="finalize">Finalize selected</button></div>
          <div style={{ flex: 0 }}><button name="op" value="release" className="secondary">Release selected to employees</button></div>
          <div style={{ flex: 0 }}><button name="op" value="reopen" className="secondary">Reopen selected</button></div>
        </div>}
      </ActionForm>
      <p className="muted">A non-zero difference means tax still due (or over-withheld). Run the last payroll of the year with "Year-end tax adjustment" ticked to settle it.</p>
    </>
  );
}
