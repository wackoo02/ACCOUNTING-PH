import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { formatPeso } from "@/lib/money";
import { qap, sawt, slsp, type PayeeRow } from "@/lib/tax/lists";
import { issues } from "@/lib/tax/dat";
import { dueDate, month, quarter } from "@/lib/tax/periods";
import { formatTin } from "@/lib/tax/tin";
import { fmtDate } from "@/lib/format";
import { PrintButton } from "@/components/PrintButton";
import { PeriodPicker, TaxTabs, currentQuarter, num } from "../../ui";

const name = (p: { name: string | null; lastName?: string | null; firstName?: string | null }) => p.lastName ? `${p.lastName}, ${p.firstName ?? ""}` : p.name ?? "";

function Issues({ list }: { list: string[] }) {
  if (!list.length) return null;
  return <div className="errors">Fix these before submitting (BIR validation rejects them): <ul>{list.slice(0, 20).map((i) => <li key={i}>{i}</li>)}</ul></div>;
}

function PayeeTable({ rows, who }: { rows: PayeeRow[]; who: string }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>#</th><th>TIN</th><th>{who}</th><th>ATC</th><th className="num">Rate</th><th className="num">Income payment / tax base</th><th className="num">Tax withheld</th></tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={`${r.key}-${r.atcCode}-${r.rate}`}><td>{i + 1}</td><td>{formatTin(r.party.tin)}</td><td>{name(r.party)}</td><td>{r.atcCode}</td><td className="num">{r.rate.toFixed(2)}%</td><td className="num">{formatPeso(r.base)}</td><td className="num">{formatPeso(r.tax)}</td></tr>)}
        {rows.length === 0 && <tr><td colSpan={7} className="muted">Nothing for this period.</td></tr>}
        <tr className="total"><td colSpan={5}>Total</td><td className="num">{formatPeso(rows.reduce((s, r) => s + r.base, 0n))}</td><td className="num">{formatPeso(rows.reduce((s, r) => s + r.tax, 0n))}</td></tr>
      </tbody>
    </table></div>
  );
}

export default async function TaxList({ params, searchParams }: { params: Promise<{ list: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { list } = await params;
  if (!["slsp", "qap", "sawt"].includes(list)) notFound();
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const cur = currentQuarter();
  const year = num(sp.year, cur.year, 2000, 2100);
  const n = num(sp.n, cur.q, 1, 4);
  const p = quarter(year, n);
  const dl = (type: string, extra = "") => `/api/tax/download?type=${type}&year=${year}&n=${n}${extra}`;

  if (list === "slsp") {
    const r = await slsp(ctx.org.id, p);
    return (
      <>
        <div className="top"><h1>Summary List of Sales and Purchases (RELIEF)</h1><div className="noprint" style={{ display: "flex", gap: 8 }}>
          <a className="btn" href={dl("relief-s")}>Sales DAT</a><a className="btn" href={dl("relief-p")}>Purchases DAT</a><a className="btn secondary" href={dl("slsp-csv")}>CSV</a><PrintButton /></div></div>
        <TaxTabs active="/tax/lists/slsp" />
        <PeriodPicker year={year} n={n} freq="Q" />
        <p className="muted">Quarterly SLSP under RR 1-2017, due {fmtDate(dueDate("SLSP", p.to))}. Open the DAT files in the BIR RELIEF validation module, then email them to esubmission@bir.gov.ph. Amounts are net of VAT.</p>
        <Issues list={[...issues(r.sales), ...issues(r.purchases)]} />
        {r.importations.length > 0 && <div className="notice">{r.importations.length} importation(s) are left out: BIR lists importations separately (RELIEF importation file).</div>}
        <h2>Sales ({p.label})</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>TIN</th><th>Customer</th><th>Address</th><th className="num">Exempt</th><th className="num">Zero-rated</th><th className="num">Taxable (net of VAT)</th><th className="num">Output tax</th><th className="num">Gross</th></tr></thead>
          <tbody>
            {r.sales.map((s) => <tr key={s.key}><td>{formatTin(s.party.tin)}</td><td>{name(s.party)}</td><td>{s.party.address}</td><td className="num">{formatPeso(s.exempt)}</td><td className="num">{formatPeso(s.zeroRated)}</td><td className="num">{formatPeso(s.taxable)}</td><td className="num">{formatPeso(s.outputTax)}</td><td className="num">{formatPeso(s.gross)}</td></tr>)}
            {r.sales.length === 0 && <tr><td colSpan={8} className="muted">No sales in the tax ledger for this quarter.</td></tr>}
            <tr className="total"><td colSpan={3}>Total</td>{(["exempt", "zeroRated", "taxable", "outputTax", "gross"] as const).map((k) => <td key={k} className="num">{formatPeso(r.sales.reduce((t, s) => t + s[k], 0n))}</td>)}</tr>
          </tbody>
        </table></div>
        <h2>Purchases ({p.label})</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>TIN</th><th>Supplier</th><th className="num">Exempt</th><th className="num">Zero-rated</th><th className="num">Services</th><th className="num">Capital goods</th><th className="num">Goods other than capital</th><th className="num">Input tax</th><th className="num">Gross taxable</th></tr></thead>
          <tbody>
            {r.purchases.map((s) => <tr key={s.key}><td>{formatTin(s.party.tin)}</td><td>{name(s.party)}</td><td className="num">{formatPeso(s.exempt)}</td><td className="num">{formatPeso(s.zeroRated)}</td><td className="num">{formatPeso(s.services)}</td><td className="num">{formatPeso(s.capitalGoods)}</td><td className="num">{formatPeso(s.goods)}</td><td className="num">{formatPeso(s.inputTax)}</td><td className="num">{formatPeso(s.grossTaxable)}</td></tr>)}
            {r.purchases.length === 0 && <tr><td colSpan={9} className="muted">No purchases in the tax ledger for this quarter.</td></tr>}
            <tr className="total"><td colSpan={2}>Total</td>{(["exempt", "zeroRated", "services", "capitalGoods", "goods", "inputTax", "grossTaxable"] as const).map((k) => <td key={k} className="num">{formatPeso(r.purchases.reduce((t, s) => t + s[k], 0n))}</td>)}</tr>
          </tbody>
        </table></div>
      </>
    );
  }

  if (list === "qap") {
    const form = sp.form === "1601FQ" ? "1601FQ" : "1601EQ";
    const r = await qap(ctx.org.id, form, year, n);
    return (
      <>
        <div className="top"><h1>Quarterly Alphalist of Payees · {form}</h1><div className="noprint" style={{ display: "flex", gap: 8 }}>
          <a className="btn" href={dl("qap", `&form=${form}`)}>QAP DAT</a><a className="btn secondary" href={dl("qap-csv", `&form=${form}`)}>CSV</a><PrintButton /></div></div>
        <TaxTabs active="/tax/lists/qap" />
        <PeriodPicker year={year} n={n} freq="Q" extra={<div style={{ maxWidth: 160 }}><label>Return</label><select name="form" defaultValue={form}><option value="1601EQ">1601-EQ (expanded)</option><option value="1601FQ">1601-FQ (final)</option></select></div>} />
        <p className="muted">Attachment to {form} for {p.label}, due {fmtDate(dueDate("QAP", p.to))}. Validate the DAT with the BIR Alphalist Validation module and email it to esubmission@bir.gov.ph.</p>
        <Issues list={issues(r.rows)} />
        <PayeeTable rows={r.rows} who="Payee" />
      </>
    );
  }

  const form = (["2550Q", "2551Q", "1702Q", "1701Q", "2550M"] as const).find((f) => f === sp.form) ?? "2550Q";
  const pm = form === "2550M" ? month(year, num(sp.m, (n - 1) * 3 + 1, 1, 12)) : p;
  const r = await sawt(ctx.org.id, pm, form);
  return (
    <>
      <div className="top"><h1>Summary Alphalist of Withholding Taxes (SAWT)</h1><div className="noprint" style={{ display: "flex", gap: 8 }}>
        <a className="btn" href={dl("sawt", `&form=${form}`)}>SAWT DAT</a><a className="btn secondary" href={dl("sawt-csv", `&form=${form}`)}>CSV</a><PrintButton /></div></div>
      <TaxTabs active="/tax/lists/sawt" />
      <PeriodPicker year={year} n={n} freq="Q" extra={<div style={{ maxWidth: 220 }}><label>Attach to</label><select name="form" defaultValue={form}>
        <option value="2550Q">2550Q (VAT withheld)</option><option value="2551Q">2551Q (percentage tax withheld)</option><option value="1702Q">1702Q (income tax withheld, corporations)</option><option value="1701Q">1701Q (income tax withheld, individuals)</option></select></div>} />
      <p className="muted">Taxes customers withheld from {ctx.org.name}, per the BIR 2307 certificates received, for {pm.label}. Record them on cash receipts (withholding tax) or through the sales module.</p>
      <Issues list={issues(r.rows)} />
      <PayeeTable rows={r.rows} who="Withholding agent (customer)" />
    </>
  );
}
