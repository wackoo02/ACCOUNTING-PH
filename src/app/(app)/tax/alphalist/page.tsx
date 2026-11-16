import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { alphalist, alphalistEmployees } from "@/lib/tax/lists";
import { issues } from "@/lib/tax/dat";
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
    return (
      <>{head()}
        {rows === null
          ? <div className="notice">The 1604-C alphalist of employees and BIR 2316 certificates come from payroll. They will appear here once the payroll module is live (it plugs into the tax engine through the compensation feed).</div>
          : <div className="table-wrap"><table>
            <thead><tr><th>TIN</th><th>Employee</th><th className="num">Gross compensation</th><th className="num">Tax due</th><th className="num">Tax withheld</th><th>MWE</th><th>Substituted filing</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.employeeId}><td>{formatTin(r.tin)}</td><td>{r.lastName}, {r.firstName}</td><td className="num">{r.grossCompensation}</td><td className="num">{r.taxDue}</td><td className="num">{r.taxWithheldPresent}</td><td>{r.minimumWageEarner ? "Yes" : ""}</td><td>{r.substitutedFiling ? "Yes" : ""}</td></tr>)}</tbody>
          </table></div>}
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
