import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import Link from "next/link";
import { alphalist, alphalistEmployees, SCHEDULE_LABEL, type EmployeeRow } from "@/lib/tax/lists";
import { issues, issues1604C, nonTaxableTotal, taxableTotal } from "@/lib/tax/dat";
import { dueDate, yearPeriod } from "@/lib/tax/periods";
import { formatTin } from "@/lib/tax/tin";
import { PrintButton } from "@/components/PrintButton";
import { TaxTabs, currentQuarter, num } from "../ui";

export default async function Alphalist({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const year = num(sp.year, currentQuarter().year - 1, 2000, 2100);
  const kind = sp.kind === "1604F" ? "1604F" : sp.kind === "1604C" ? "1604C" : "1604E";
  const form = (
    <form className="card row noprint">
      <div style={{ maxWidth: 120 }}><label>Year</label><input name="year" defaultValue={year} /></div>
      <div style={{ maxWidth: 320 }}><label>Alphalist</label><select name="kind" defaultValue={kind}>
        <option value="1604E">1604-E · payees subject to expanded withholding</option>
        <option value="1604F">1604-F · payees subject to final withholding</option>
        <option value="1604C">1604-C · employees (compensation, BIR 2316)</option>
      </select></div>
      <div style={{ flex: 0 }}><button>Show</button></div>
    </form>
  );
  const head = (dl?: string) => (
    <><div className="top"><h1>Annual Alphalist · {kind.replace("1604", "1604-")} · {year}</h1><div className="noprint" style={{ display: "flex", gap: 8 }}>
      {dl && <><a className="btn" href={`/api/tax/download?type=alpha&kind=${kind}&year=${year}`}>DAT</a><a className="btn secondary" href={`/api/tax/download?type=alpha-csv&kind=${kind}&year=${year}`}>CSV</a></>}<PrintButton /></div></div>
      <TaxTabs active="/tax/alphalist" />{form}
      <p className="muted">Due {fmtDate(dueDate(kind, yearPeriod(year).to))}. Validate with the BIR Alphalist Validation module before emailing to esubmission@bir.gov.ph.</p></>
  );
  if (kind === "1604C") {
    const rows = await alphalistEmployees(ctx.org.id, year);
    if (rows === null) return <>{head()}<div className="notice">Payroll is not connected to the tax engine.</div></>;
    const iss = issues1604C(rows);
    const open = rows.filter((r) => r.formStatus === "DRAFT" || r.formStatus === "NONE").length;
    const p = (v: number | string | undefined) => Number(v ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const tot = (rs: EmployeeRow[], f: (r: EmployeeRow) => number) => rs.reduce((s, r) => s + f(r), 0);
    const schedules = (["7.1", "7.3", "7.4", "7.5"] as const).map((k) => ({ k, rs: rows.filter((r) => r.schedule === k) })).filter((x) => x.rs.length);
    return (
      <>{head("dat")}
        <p className="muted">Built from finalized payroll runs paid in {year}, with the same figures as each employee&apos;s BIR 2316.
          Forms finalized in <Link href={`/payroll/2316?year=${year}`}>Payroll · BIR 2316</Link> are used as issued; the rest are computed live from payslips.</p>
        {open > 0 && <div className="notice">{open} employee(s) have a draft or no 2316 yet for {year}. Review and finalize them in <Link href={`/payroll/2316?year=${year}`}>Payroll · BIR 2316</Link> so the alphalist matches the certificates you give employees.</div>}
        {iss.length > 0 && <div className="errors">Fix before submitting: <ul>{iss.slice(0, 20).map((i) => <li key={i}>{i}</li>)}</ul></div>}
        {rows.length === 0 && <div className="notice">No finalized payroll was paid in {year}.</div>}
        {schedules.map(({ k, rs }) => (
          <div key={k} style={{ marginBottom: 14 }}>
            <h2>{SCHEDULE_LABEL[k]}</h2>
            <div className="table-wrap"><table>
              <thead><tr><th>#</th><th>TIN</th><th>Employee</th>{k === "7.1" && <th>Period</th>}<th className="num">Gross compensation</th><th className="num">Non-taxable</th><th className="num">Taxable</th><th className="num">Tax due</th><th className="num">Tax withheld</th><th className="num">Difference</th>{k !== "7.1" && <th>Substituted filing</th>}<th>2316</th></tr></thead>
              <tbody>
                {rs.map((r, i) => {
                  const withheld = Number(r.taxWithheldPresent) + Number(r.taxWithheldPrevious ?? 0);
                  const diff = Math.round((Number(r.taxDue) - withheld) * 100) / 100;
                  return (
                    <tr key={r.employeeId}><td>{i + 1}</td><td>{formatTin(r.tin) || <span className="diff-bad">no TIN</span>}</td><td>{r.employeeCode} {r.lastName}, {r.firstName}{r.middleName ? ` ${r.middleName}` : ""}</td>
                      {k === "7.1" && <td>{fmtDate(r.periodFrom)} to {fmtDate(r.periodTo)}</td>}
                      <td className="num">{p(r.grossCompensation)}</td><td className="num">{p(nonTaxableTotal(r))}</td><td className="num">{p(taxableTotal(r))}</td>
                      <td className="num">{p(r.taxDue)}</td><td className="num">{p(withheld)}</td><td className={`num ${diff ? "diff-bad" : "diff-ok"}`}>{p(diff)}</td>
                      {k !== "7.1" && <td>{r.substitutedFiling ? "Yes" : "No"}</td>}
                      <td><span className={`badge ${r.formStatus}`}>{r.formStatus === "NONE" ? "not prepared" : r.formStatus}</span></td></tr>
                  );
                })}
                <tr className="total"><td colSpan={k === "7.1" ? 4 : 3}>Total</td><td className="num">{p(tot(rs, (r) => Number(r.grossCompensation)))}</td><td className="num">{p(tot(rs, nonTaxableTotal))}</td><td className="num">{p(tot(rs, taxableTotal))}</td>
                  <td className="num">{p(tot(rs, (r) => Number(r.taxDue)))}</td><td className="num">{p(tot(rs, (r) => Number(r.taxWithheldPresent) + Number(r.taxWithheldPrevious ?? 0)))}</td><td colSpan={k === "7.1" ? 2 : 3}></td></tr>
              </tbody>
            </table></div>
          </div>
        ))}
        <p className="muted">A difference between tax due and tax withheld should be settled in the last payroll of the year (year-end adjustment). Substituted filing means the employee&apos;s 2316 stands in for their own 1700, so it applies only to employees with one employer for the whole year and no under- or over-withholding.</p>
      </>
    );
  }
  const r = await alphalist(ctx.org.id, kind, year);
  const iss = issues(r.rows);
  return (
    <>{head("dat")}
      {iss.length > 0 && <div className="errors">Fix before submitting: <ul>{iss.slice(0, 20).map((i) => <li key={i}>{i}</li>)}</ul></div>}
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>TIN</th><th>Payee</th><th>ATC</th><th className="num">Rate</th><th className="num">Income payments</th><th className="num">Tax withheld</th></tr></thead>
        <tbody>
          {r.rows.map((x, i) => <tr key={`${x.key}-${x.atcCode}-${x.rate}`}><td>{i + 1}</td><td>{formatTin(x.party.tin)}</td><td>{x.party.name}</td><td>{x.atcCode}</td><td className="num">{x.rate.toFixed(2)}%</td><td className="num">{formatPeso(x.base)}</td><td className="num">{formatPeso(x.tax)}</td></tr>)}
          {r.rows.length === 0 && <tr><td colSpan={7} className="muted">No withholding in {year}.</td></tr>}
          <tr className="total"><td colSpan={5}>Total</td><td className="num">{formatPeso(r.rows.reduce((s, x) => s + x.base, 0n))}</td><td className="num">{formatPeso(r.rows.reduce((s, x) => s + x.tax, 0n))}</td></tr>
        </tbody>
      </table></div>
    </>
  );
}
