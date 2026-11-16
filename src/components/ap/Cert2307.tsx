// Printable BIR Form 2307 (Certificate of Creditable Tax Withheld at Source). Layout follows the form's
// parts; companies still sign it and, where required, use the BIR's own PDF form with these figures.
import type { Cert2307 } from "@/lib/ap/payments";
import { formatPeso } from "@/lib/money";

type Party = { name: string; tin: string | null; address?: string | null; registeredAddress?: string | null };
const md = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
const box: React.CSSProperties = { border: "1px solid #333", padding: "6px 8px" };

export function Cert2307View({ cert, org, vendor }: { cert: Cert2307; org: Party; vendor: Party }) {
  return (
    <div className="card" style={{ breakAfter: "page", fontSize: 12 }}>
      <div style={{ textAlign: "center" }}><div>Republic of the Philippines · Department of Finance · Bureau of Internal Revenue</div>
        <h2 style={{ margin: "4px 0" }}>BIR Form No. 2307 · Certificate of Creditable Tax Withheld at Source</h2></div>
      <div style={box}><strong>1 For the period</strong> From {md(cert.from)} To {md(cert.to)} (Q{cert.quarter} {cert.year})</div>
      <div style={box}><strong>Part I · Payee information</strong><br />2 TIN: {vendor.tin || "________"}<br />3 Payee&apos;s name: {vendor.name}<br />4 Registered address: {vendor.address || ""}</div>
      <div style={box}><strong>Part II · Payor information</strong><br />6 TIN: {org.tin || "________"}<br />7 Payor&apos;s name: {org.name}<br />8 Registered address: {org.registeredAddress || ""}</div>
      <div style={box}><strong>Part III · Details of monthly income payments and taxes withheld</strong>
        <table style={{ marginTop: 6 }}>
          <thead><tr><th>Income payments subject to expanded withholding tax</th><th>ATC</th><th className="num">1st month of the quarter</th><th className="num">2nd month</th><th className="num">3rd month</th><th className="num">Total</th><th className="num">Tax withheld for the quarter</th></tr></thead>
          <tbody>
            {cert.rows.map((r) => <tr key={r.atc}><td>{r.nature}</td><td>{r.atc}</td>{r.months.map((m, i) => <td key={i} className="num">{formatPeso(m, { blankZero: true })}</td>)}<td className="num">{formatPeso(r.total)}</td><td className="num">{formatPeso(r.tax)}</td></tr>)}
            <tr className="total"><td colSpan={5}>Total</td><td className="num">{formatPeso(cert.totalIncome)}</td><td className="num">{formatPeso(cert.totalTax)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 24 }}>
        <div style={{ borderTop: "1px solid #333", paddingTop: 4 }}>Payor / authorized representative (signature over printed name, TIN, title)</div>
        <div style={{ borderTop: "1px solid #333", paddingTop: 4 }}>Conforme: payee / authorized representative</div>
      </div>
    </div>
  );
}
