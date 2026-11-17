import { prisma } from "@/lib/db";
import { PrintButton } from "@/components/PrintButton";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts, textOpts } from "@/lib/lookup";

/** Warehouse + category filter fields shared by the inventory reports (server component). */
export async function InvFilters({ organizationId, sp, children }: { organizationId: string; sp: Record<string, string | undefined>; children?: React.ReactNode }) {
  const [whs, cats] = await Promise.all([
    prisma.warehouse.findMany({ where: { organizationId }, orderBy: { code: "asc" } }),
    prisma.product.findMany({ where: { organizationId, isStocked: true, category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" } }),
  ]);
  return (
    <form className="card row noprint">
      {children}
      <div><label>Warehouse</label><MasterPicker name="wh" ariaLabel="Warehouse" defaultValue={sp.wh ?? ""} emptyLabel="All" placeholder="All" options={idOpts(whs)} /></div>
      <div><label>Category</label><MasterPicker name="cat" ariaLabel="Category" defaultValue={sp.cat ?? ""} emptyLabel="All" placeholder="All" options={textOpts(cats.map((c) => c.category!))} /></div>
      <div style={{ flex: 0 }}><button>Show</button></div>
      <div style={{ flex: 0 }}><PrintButton /></div>
    </form>
  );
}
