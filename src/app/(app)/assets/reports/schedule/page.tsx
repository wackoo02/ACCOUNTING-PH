import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatPeso } from "@/lib/money";
import { depreciationSchedule } from "@/lib/assets/reports";
import { PrintButton } from "@/components/PrintButton";
import { MasterPicker } from "@/components/MasterPicker";
import { codeOpts } from "@/lib/lookup";

type SP = Promise<Record<string, string | undefined>>;

export default async function Schedule({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const year = Number(sp.year) || new Date().getUTCFullYear();
  const cats = await prisma.assetCategory.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } });
  const s = await depreciationSchedule(ctx.org.id, year, org.fiscalYearStartMonth ?? 1, { categoryCode: sp.category || null });
  return (
    <>
      <div className="top"><h1>Depreciation schedule {year}</h1><PrintButton label="Print" /></div>
      <p className="print-only"><strong>{ctx.org.name}</strong></p>
      <form className="card row noprint">
        <div><label>Fiscal year</label><input name="year" type="number" defaultValue={year} /></div>
        <div><label>Category</label><MasterPicker name="category" ariaLabel="Category" defaultValue={sp.category ?? ""} emptyLabel="All" placeholder="All" options={codeOpts(cats)} /></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <p className="muted">Posted months in normal type; <i>projected months in italics</i> (from the current cost, life and method).</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Asset</th><th>Description</th>{s.months.map((m) => <th key={m} className="num">{m}</th>)}<th className="num">Total</th></tr></thead>
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.asset.id}>
              <td><Link href={`/assets/${r.asset.id}`}>{r.asset.code}</Link></td><td>{r.asset.name}</td>
              {r.cells.map((c) => <td key={c.idx} className="num" style={c.projected ? { fontStyle: "italic", color: "var(--muted, #6b6480)" } : undefined}>{formatPeso(c.amount, { blankZero: true })}</td>)}
              <td className="num">{formatPeso(r.total)}</td>
            </tr>
          ))}
          {s.rows.length === 0 && <tr><td colSpan={15} className="muted">No depreciation in this year.</td></tr>}
          {s.rows.length > 0 && <tr className="total"><td colSpan={2}>Total</td>{s.monthTotals.map((t, i) => <td key={i} className="num">{formatPeso(t)}</td>)}<td className="num">{formatPeso(s.total)}</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
