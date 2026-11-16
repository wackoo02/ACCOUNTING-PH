import Link from "next/link";
import QRCode from "qrcode";
import { requireCtx } from "@/lib/auth";
import { listAssets, qrPayload } from "@/lib/assets/audit";
import { PrintButton } from "@/components/PrintButton";

type SP = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Stickers({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const location = one(sp.location), q = one(sp.q), untagged = one(sp.untagged) === "1";
  let assets = await listAssets(ctx.org.id, { location: location || null, q: q || null });
  if (untagged) assets = assets.filter((a) => !a.taggedAt);
  const all = await listAssets(ctx.org.id);
  const locations = [...new Set(all.map((a) => a.location).filter(Boolean) as string[])].sort();
  const svgs = await Promise.all(assets.map((a) => QRCode.toString(qrPayload(a.code), { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#1E1338", light: "#ffffff" } })));
  return (
    <>
      <div className="top noprint">
        <h1>Asset QR stickers</h1>
        <PrintButton label={`Print ${assets.length} sticker${assets.length === 1 ? "" : "s"}`} />
      </div>
      <form className="row noprint" style={{ alignItems: "end", marginBottom: 12 }}>
        <div><label>Location</label><select name="location" defaultValue={location}><option value="">All</option>{locations.map((l) => <option key={l}>{l}</option>)}</select></div>
        <div><label>Search</label><input name="q" defaultValue={q} placeholder="Asset no. or name" /></div>
        <div><label>Show</label><select name="untagged" defaultValue={untagged ? "1" : ""}><option value="">All assets</option><option value="1">Not yet tagged</option></select></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <p className="muted noprint">Each sticker holds the asset number. Stick it on the asset, then scan it in the Veritus Mobility app (Asset Audit tile): the first scan marks the asset as tagged in the register. Prints 3 across on A4 / Letter sticker paper.</p>
      {assets.length === 0 && <div className="notice">No assets match. Add assets in <Link href="/masters/assets">Master Lists → Fixed Asset Register</Link>.</div>}
      <div className="stickers">
        {assets.map((a, i) => (
          <div className="sticker" key={a.id}>
            <span dangerouslySetInnerHTML={{ __html: svgs[i] }} />
            <div><div className="no">{a.code}</div><div className="nm">{a.name}</div><div className="co">{ctx.org.name}{a.location ? ` · ${a.location}` : ""}</div></div>
          </div>
        ))}
      </div>
    </>
  );
}
