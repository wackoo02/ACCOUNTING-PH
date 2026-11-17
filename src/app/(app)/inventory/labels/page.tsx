import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { barcodeSvg } from "@/lib/inventory/barcode";
import { PrintButton } from "@/components/PrintButton";
import { MultiPicker } from "@/components/Multi";
import { MasterPicker } from "@/components/MasterPicker";
import { textOpts } from "@/lib/lookup";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Labels({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const ids = ([] as string[]).concat(sp.items ?? []).flatMap((s) => s.split(",")).filter(Boolean);
  const cat = typeof sp.cat === "string" ? sp.cat : "";
  const copies = Math.min(50, Math.max(1, Number(sp.copies) || 1));
  const [all, cats] = await Promise.all([
    prisma.product.findMany({ where: { organizationId: ctx.org.id, isStocked: true, isActive: true }, orderBy: { code: "asc" } }),
    prisma.product.findMany({ where: { organizationId: ctx.org.id, isStocked: true, category: { not: null } }, distinct: ["category"], select: { category: true } }),
  ]);
  const picked = all.filter((i) => ids.includes(i.id) || (cat && i.category === cat));
  return (
    <>
      <div className="top"><h1>Barcode Labels</h1></div>
      <form className="card row noprint">
        <div style={{ flex: 3 }}><label>Items</label><MultiPicker name="items" placeholder="Type to search and tick items…" defaultValue={ids} options={all.map((i) => ({ value: i.id, label: `${i.code} · ${i.name}` }))} /></div>
        <div><label>or whole category</label><MasterPicker name="cat" ariaLabel="Category" defaultValue={cat} emptyLabel="—" placeholder="—" options={textOpts(cats.map((c) => c.category!))} /></div>
        <div><label>Copies each</label><input type="number" name="copies" min={1} max={50} defaultValue={copies} /></div>
        <div style={{ flex: 0 }}><button>Show labels</button></div>
        <div style={{ flex: 0 }}><PrintButton label="Print labels" /></div>
      </form>
      <p className="muted noprint">Code 128 barcodes of the item&apos;s Barcode (or its item code when blank). Any USB or Bluetooth scanner can read them into the Scan box on inventory documents and count sheets.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {picked.flatMap((i) => Array.from({ length: copies }, (_, k) => (
          <div key={`${i.id}-${k}`} style={{ border: "1px dashed #bbb", padding: 8, width: 230, textAlign: "center", breakInside: "avoid", background: "#fff" }}>
            <div style={{ fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.name}</div>
            <div style={{ overflow: "hidden" }} className="barcode" dangerouslySetInnerHTML={{ __html: barcodeSvg(i.barcode || i.code, { height: 44, module: 1.2 }) }} />
            <div style={{ fontFamily: "monospace", fontSize: 12 }}>{i.barcode || i.code}</div>
            <div className="muted" style={{ fontSize: 11 }}>{i.code}{i.unit ? ` · ${i.unit}` : ""}</div>
          </div>
        )))}
        {picked.length === 0 && <p className="muted">Choose items or a category.</p>}
      </div>
    </>
  );
}
