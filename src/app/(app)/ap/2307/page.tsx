import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { certificateForQuarter } from "@/lib/ap/payments";
import { Cert2307View } from "@/components/ap/Cert2307";
import { PrintButton } from "@/components/PrintButton";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

export default async function Quarterly2307({ searchParams }: { searchParams: Promise<{ vendor?: string; year?: string; q?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const now = new Date();
  const year = Number(sp.year) || now.getUTCFullYear();
  const q = Number(sp.q) || Math.floor(now.getUTCMonth() / 3) + 1;
  const [org, vendors] = await Promise.all([prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } }), prisma.vendor.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: "asc" } })]);
  const picked = sp.vendor === "ALL" ? vendors : vendors.filter((v) => v.id === sp.vendor);
  const certs = await Promise.all(picked.map(async (v) => ({ v, c: await certificateForQuarter(ctx.org.id, v.id, year, q) })));
  return (<>
    <div className="top noprint"><h1>BIR Form 2307 by Quarter</h1><PrintButton /></div>
    <form className="card row noprint">
      <div style={{ flex: 2 }}><label>Supplier</label><MasterPicker name="vendor" ariaLabel="Supplier" defaultValue={sp.vendor ?? ""} placeholder="Type to search…" options={[{ value: "ALL", label: "All suppliers with tax withheld" }, ...idOpts(vendors)]} /></div>
      <div><label>Year</label><input name="year" className="num" defaultValue={year} /></div>
      <div><label>Quarter</label><select name="q" defaultValue={q}>{[1, 2, 3, 4].map((x) => <option key={x} value={x}>Q{x}</option>)}</select></div>
      <div style={{ flex: 0 }}><button>Show</button></div>
    </form>
    <p className="muted noprint">Income payments (net of VAT) and tax withheld on posted supplier bills, by the month the tax was withheld. Use these figures for the 1601-EQ Quarterly Alphalist of Payees (QAP) as well.</p>
    {certs.filter((x) => x.c.rows.length).map(({ v, c }) => <Cert2307View key={v.id} cert={c} org={org} vendor={v} />)}
    {sp.vendor && !certs.some((x) => x.c.rows.length) && <div className="notice">No tax withheld for this selection.</div>}
  </>);
}
