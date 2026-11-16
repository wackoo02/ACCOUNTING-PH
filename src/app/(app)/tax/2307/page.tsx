import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatPeso } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { certificates2307 } from "@/lib/tax/lists";
import { dueDate, month } from "@/lib/tax/periods";
import { formatTin } from "@/lib/tax/tin";
import { PrintButton } from "@/components/PrintButton";
import { PeriodPicker, TaxTabs, currentQuarter, num } from "../ui";

export default async function Certificates({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const cur = currentQuarter();
  const year = num(sp.year, cur.year, 2000, 2100);
  const q = num(sp.q ?? sp.n, cur.q, 1, 4);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const c = await certificates2307(org.id, year, q);
  const months = [1, 2, 3].map((k) => month(year, (q - 1) * 3 + k).label.split(" ")[0]);
  const pick = sp.payee ? c.payees.filter((p) => p.key === sp.payee) : sp.all ? c.payees : [];
  return (
    <>
      <div className="top"><h1>BIR Form 2307 · Certificate of Creditable Tax Withheld at Source</h1>
        <div className="noprint" style={{ display: "flex", gap: 8 }}><a className="btn secondary" href={`/api/tax/download?type=2307-csv&year=${year}&n=${q}`}>CSV (all payees)</a>{pick.length > 0 && <PrintButton label="Print certificates" />}</div></div>
      <TaxTabs active="/tax/2307" />
      <form className="card row noprint">
        <div style={{ maxWidth: 120 }}><label>Year</label><input name="year" defaultValue={year} /></div>
        <div style={{ maxWidth: 120 }}><label>Quarter</label><select name="q" defaultValue={q}>{[1, 2, 3, 4].map((x) => <option key={x} value={x}>Q{x}</option>)}</select></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <p className="muted noprint">Give each payee their 2307 within 20 days after the quarter (due {fmtDate(dueDate("2307", c.period.to))}), or with the payment if they ask. The same figures go to the QAP of 1601-EQ.</p>
      <div className="table-wrap noprint"><table>
        <thead><tr><th>Payee</th><th>TIN</th><th>ATCs</th><th className="num">Income payments</th><th className="num">Tax withheld</th><th></th></tr></thead>
        <tbody>
          {c.payees.map((p) => <tr key={p.key}><td>{p.party.name}</td><td>{formatTin(p.party.tin) || <span className="diff-bad">no TIN</span>}</td><td>{p.rows.map((r) => r.atcCode).join(", ")}</td>
            <td className="num">{formatPeso(p.base)}</td><td className="num">{formatPeso(p.tax)}</td><td><Link href={`/tax/2307?year=${year}&q=${q}&payee=${encodeURIComponent(p.key)}`}>Certificate</Link></td></tr>)}
          {c.payees.length === 0 && <tr><td colSpan={6} className="muted">No expanded withholding tax in this quarter.</td></tr>}
        </tbody>
      </table></div>
      {c.payees.length > 0 && !pick.length && <p className="noprint"><Link href={`/tax/2307?year=${year}&q=${q}&all=1`}>Show all certificates for printing</Link></p>}

      {pick.map((p) => (
        <div key={p.key} className="cert" style={{ margin: "16px 0", breakAfter: "page" }}>
          <div className="muted" style={{ fontSize: 11 }}>BIR Form No. 2307 (January 2018 ENCS) · data for the certificate; sign and issue on the official form or a BIR-approved computer-generated copy</div>
          <h3>Certificate of Creditable Tax Withheld at Source</h3>
          <p style={{ textAlign: "center", margin: 0 }}>For the period {fmtDate(c.period.from)} to {fmtDate(c.period.to)}</p>
          <h4>Part I · Payee information</h4>
          <div className="row"><div><label>TIN</label>{formatTin(p.party.tin)}</div><div style={{ flex: 2 }}><label>Payee&apos;s name</label>{p.party.name}</div><div style={{ flex: 2 }}><label>Registered address</label>{p.party.address ?? ""}</div></div>
          <h4>Part II · Payor information</h4>
          <div className="row"><div><label>TIN</label>{formatTin(org.tin)}</div><div style={{ flex: 2 }}><label>Payor&apos;s name</label>{org.name}</div><div style={{ flex: 2 }}><label>Registered address</label>{[org.registeredAddress, org.zipCode].filter(Boolean).join(" ")}</div></div>
          <h4>Part III · Details of monthly income payments and taxes withheld</h4>
          <table>
            <thead><tr><th>Income payments subject to expanded withholding tax</th><th>ATC</th>{months.map((m) => <th key={m} className="num">{m}</th>)}<th className="num">Total</th><th className="num">Tax withheld for the quarter</th></tr></thead>
            <tbody>
              {p.rows.map((r) => <tr key={r.atcCode + r.rate}><td>{r.lines[0].description ?? ""} ({r.rate}%)</td><td>{r.atcCode}</td>{r.months.map((m, i) => <td key={i} className="num">{formatPeso(m, { blankZero: true })}</td>)}<td className="num">{formatPeso(r.base)}</td><td className="num">{formatPeso(r.tax)}</td></tr>)}
              <tr className="total"><td colSpan={2}>Total</td>{[0, 1, 2].map((i) => <td key={i} className="num">{formatPeso(p.rows.reduce((s, r) => s + r.months[i], 0n))}</td>)}<td className="num">{formatPeso(p.base)}</td><td className="num">{formatPeso(p.tax)}</td></tr>
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 28 }}>
            <div style={{ borderTop: "1px solid var(--ink)", paddingTop: 4 }}>Signature over printed name of payor / authorized representative, TIN, designation</div>
            <div style={{ borderTop: "1px solid var(--ink)", paddingTop: 4 }}>Conforme: signature over printed name of payee / authorized representative, TIN</div>
          </div>
        </div>
      ))}
    </>
  );
}
