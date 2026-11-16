import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { deadlines, quarter } from "@/lib/tax/periods";
import { tieOut } from "@/lib/tax/ledger";
import { KIND_LABEL } from "@/lib/tax/types";
import { TaxTabs, currentQuarter, num } from "./ui";

export default async function TaxOverview({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const cur = currentQuarter();
  const year = num(sp.year, cur.year, 2000, 2100);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const list = deadlines(year, org.vatRegistered);
  const filed = await prisma.taxReturn.findMany({ where: { organizationId: org.id, periodFrom: { gte: new Date(Date.UTC(year, 0, 1)) }, periodTo: { lte: new Date(Date.UTC(year, 11, 31)) } } });
  const statusOf = (form: string, from: Date) => filed.find((r) => r.form === form && r.periodFrom.getTime() === from.getTime());
  const now = new Date();
  const q = year === cur.year ? cur.q : 4;
  const qp = quarter(year, q);
  const t = await tieOut(org.id, qp.from, qp.to);
  const missing = [!org.tin && "TIN", !org.rdoCode && "RDO code", !org.registeredAddress && "registered address", !org.zipCode && "ZIP code"].filter(Boolean);
  return (
    <>
      <div className="top"><h1>BIR Tax</h1><span className="muted">{org.name} · {org.vatRegistered ? "VAT-registered" : "Non-VAT (percentage tax)"}</span></div>
      <TaxTabs active="/tax" />
      {missing.length > 0 && <div className="errors">Set the company&apos;s {missing.join(", ")} in <Link href="/settings">Company Settings</Link>. BIR files and certificates need them.</div>}

      <h2>Tax ledger vs general ledger, {qp.label}</h2>
      <div className="grid" style={{ marginBottom: 12 }}>
        {t.kinds.map((k) => (
          <div key={k.kind} className="card stat">
            <div className="l">{KIND_LABEL[k.kind]}</div>
            <div className="n">{formatPeso(k.ledger)}</div>
            <div className={k.difference === 0n ? "diff-ok" : "diff-bad"} style={{ fontSize: 12 }}>{k.difference === 0n ? "Agrees with the GL" : `GL ${formatPeso(k.gl)}: ${formatPeso(k.difference)} not explained`}</div>
          </div>
        ))}
      </div>
      {t.unexplained.length > 0
        ? <div className="notice">{t.unexplained.length} GL line(s) on tax accounts have no tax details yet. <Link href={`/tax/review?year=${year}&n=${q}`}>Review and classify them</Link> so they appear in the returns.</div>
        : <p className="muted">Every tax amount posted to the GL this quarter is in the tax ledger.</p>}

      <div className="top" style={{ marginTop: 18 }}><h2 style={{ margin: 0 }}>Filing calendar {year}</h2>
        <form className="noprint" style={{ display: "flex", gap: 6 }}><select name="year" defaultValue={year}>{[year - 1, year, year + 1].map((y) => <option key={y}>{y}</option>)}</select><button className="secondary">Show</button></form>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Due</th><th>Return / report</th><th>Period</th><th>Status</th><th className="num">Tax due</th><th>Filed</th><th>Reference</th></tr></thead>
        <tbody>
          {list.map((d) => {
            const r = statusOf(d.form, d.period.from);
            const isReturn = ["2550Q", "2551Q", "0619E", "1601EQ", "0619F", "1601FQ"].includes(d.form);
            const st = r?.status === "FILED" ? "FILED" : isReturn && d.due < now ? "OVERDUE" : r ? "DRAFT" : "";
            return (
              <tr key={`${d.form}-${d.period.label}`}>
                <td>{fmtDate(d.due)}</td><td><Link href={d.href}>{d.label}</Link></td><td>{d.period.label}</td>
                <td>{st && <span className={`badge ${st}`}>{st === "FILED" ? "Filed" : st === "OVERDUE" ? "Not filed" : "Draft"}</span>}</td>
                <td className="num">{r ? formatPeso(toCentavos(r.taxDue.toString())) : ""}</td>
                <td>{r?.filedAt ? fmtDate(r.filedAt) : ""}</td><td>{r?.filingRef ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      <p className="muted" style={{ marginTop: 10 }}>
        Deadlines for calendar-year filers. 2550M has been optional since January 2023 (RMC 52-2023) and is available under Returns if you still file it.
        eFPS filers may have staggered 0619 deadlines by industry group. Veritus prepares the figures and files; you file and pay through eFPS or eBIRForms, then record the confirmation number here.
      </p>
      <div className="card noprint">
        <b>Returns:</b>{" "}
        {(["2550Q", "2550M", "2551Q", "0619E", "1601EQ", "0619F", "1601FQ"] as const).map((f, i) => (
          <span key={f}>{i > 0 && " · "}<Link href={`/tax/returns/${f}?year=${year}&n=${f.endsWith("Q") ? q : cur.m}`}>{f}</Link></span>
        ))}
      </div>
    </>
  );
}
