import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso } from "@/lib/money";
import { today } from "@/lib/format";
import { assetRegister } from "@/lib/assets/reports";
import { PrintButton } from "@/components/PrintButton";

type SP = Promise<Record<string, string | undefined>>;
const AUDIT_CLASS: Record<string, string> = { Found: "POSTED", Tagged: "POSTED", Moved: "PENDING_APPROVAL", Missing: "VOID", "Not tagged": "DRAFT" };

export default async function AssetRegister({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = sp.asOf && /^\d{4}-\d{2}-\d{2}$/.test(sp.asOf) ? sp.asOf : today();
  const [reg, cats, locs] = await Promise.all([
    assetRegister(ctx.org.id, asOf, { categoryCode: sp.category || null, location: sp.location || null, status: sp.status || null, q: sp.q || null }),
    prisma.assetCategory.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } }),
    prisma.fixedAsset.findMany({ where: { organizationId: ctx.org.id, location: { not: null } }, distinct: ["location"], select: { location: true } }),
  ]);
  const counts = reg.rows.reduce<Record<string, number>>((m, r) => { if (r.audit) m[r.audit] = (m[r.audit] ?? 0) + 1; return m; }, {});
  const create = can(ctx.role, "journal.post") || can(ctx.role, "masters.manage");
  return (
    <>
      <div className="top">
        <h1>Fixed asset register</h1>
        <div className="row noprint" style={{ gap: 8, flex: "0 0 auto", flexWrap: "nowrap", whiteSpace: "nowrap" }}>
          {create && <Link className="btn" href="/assets/new">New asset</Link>}
          <Link className="btn secondary" href="/assets/depreciation">Depreciation</Link>
          <Link className="btn secondary" href="/masters/assets">Excel upload</Link>
          <PrintButton label="Print" />
        </div>
      </div>
      <p className="print-only"><strong>{ctx.org.name}</strong> · Fixed asset register as of {asOf}</p>
      <form className="card row noprint">
        <div><label>As of</label><input type="date" name="asOf" defaultValue={asOf} /></div>
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="Asset no., description, serial, old tag" /></div>
        <div><label>Category</label><select name="category" defaultValue={sp.category ?? ""}><option value="">All</option>{cats.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
        <div><label>Location</label><select name="location" defaultValue={sp.location ?? ""}><option value="">All</option>{locs.map((l) => l.location!).sort().map((l) => <option key={l}>{l}</option>)}</select></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">In the books</option><option>ACTIVE</option><option>FOR_REPAIR</option><option>MISSING</option><option>DISPOSED</option><option>RETIRED</option><option value="ALL">All, incl. disposed</option></select></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="grid">
        <div className="card stat"><div className="n">{reg.rows.length}</div><div className="l">Assets</div></div>
        <div className="card stat"><div className="n">{formatPeso(reg.totals.cost)}</div><div className="l">Cost</div></div>
        <div className="card stat"><div className="n">{formatPeso(reg.totals.accum)}</div><div className="l">Accumulated depreciation</div></div>
        <div className="card stat"><div className="n">{formatPeso(reg.totals.nbv)}</div><div className="l">Net book value</div></div>
        <div className="card stat"><div className="n">{counts.Missing ?? 0} / {counts.Moved ?? 0} / {counts["Not tagged"] ?? 0}</div><div className="l">Missing / moved / not tagged (last count)</div></div>
      </div>
      <div className="table-wrap"><table>
        <thead><tr><th>Asset no.</th><th>Description</th><th>Category</th><th>Location</th><th>Custodian</th><th>In service</th><th className="num">Life left (mo.)</th><th className="num">Cost</th><th className="num">Accum. depreciation</th><th className="num">Net book value</th><th>Status</th><th>Last count</th></tr></thead>
        <tbody>
          {reg.rows.map((r) => (
            <tr key={r.asset.id}>
              <td style={{ whiteSpace: "nowrap" }}><Link href={`/assets/${r.asset.id}`}>{r.asset.code}</Link></td>
              <td>{r.asset.name}{r.asset.serialNo ? <div className="muted">S/N {r.asset.serialNo}</div> : null}</td>
              <td>{r.asset.category}</td>
              <td>{r.asset.location}</td>
              <td>{r.asset.custodianCode}</td>
              <td style={{ whiteSpace: "nowrap" }}>{(r.asset.inServiceDate ?? r.asset.acquisitionDate)?.toISOString().slice(0, 10)}</td>
              <td className="num">{r.remaining ?? ""}</td>
              <td className="num">{formatPeso(r.cost)}</td>
              <td className="num">{formatPeso(r.accum)}</td>
              <td className="num">{formatPeso(r.nbv)}</td>
              <td><span className={`badge ${r.status === "ACTIVE" ? "POSTED" : r.status === "DISPOSED" || r.status === "RETIRED" ? "VOID" : "PENDING_APPROVAL"}`}>{r.status.replace("_", " ")}</span></td>
              <td>{r.audit && <span className={`badge ${AUDIT_CLASS[r.audit]}`}>{r.audit}</span>}{r.audit === "Moved" && <div className="muted">seen at {r.asset.lastSeenLocation}</div>}</td>
            </tr>
          ))}
          {reg.rows.length === 0 && <tr><td colSpan={12} className="muted">No assets. Add one with New asset, or upload your existing register under Upload / export Excel.</td></tr>}
          {reg.rows.length > 0 && <tr className="total"><td colSpan={7}>Total</td><td className="num">{formatPeso(reg.totals.cost)}</td><td className="num">{formatPeso(reg.totals.accum)}</td><td className="num">{formatPeso(reg.totals.nbv)}</td><td colSpan={2} /></tr>}
        </tbody>
      </table></div>
      <p className="muted noprint">Last count comes from QR scans in the Veritus Mobility app (Asset Audit tile): <b>Found</b> = scanned where the register says, <b>Moved</b> = scanned somewhere else (open the asset to accept the new location), <b>Missing</b> = not scanned when the count closed, <b>Not tagged</b> = sticker never scanned.</p>
    </>
  );
}
