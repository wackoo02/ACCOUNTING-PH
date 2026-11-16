import { prisma } from "@/lib/db";
import { PrintButton } from "@/components/PrintButton";

/** Warehouse + category filter fields shared by the inventory reports (server component). */
export async function InvFilters({ organizationId, sp, children }: { organizationId: string; sp: Record<string, string | undefined>; children?: React.ReactNode }) {
  const [whs, cats] = await Promise.all([
    prisma.warehouse.findMany({ where: { organizationId }, orderBy: { code: "asc" } }),
    prisma.product.findMany({ where: { organizationId, isStocked: true, category: { not: null } }, distinct: ["category"], select: { category: true }, orderBy: { category: "asc" } }),
  ]);
  return (
    <form className="card row noprint">
      {children}
      <div><label>Warehouse</label><select name="wh" defaultValue={sp.wh ?? ""}><option value="">All</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></div>
      <div><label>Category</label><select name="cat" defaultValue={sp.cat ?? ""}><option value="">All</option>{cats.map((c) => <option key={c.category} value={c.category!}>{c.category}</option>)}</select></div>
      <div style={{ flex: 0 }}><button>Show</button></div>
      <div style={{ flex: 0 }}><PrintButton /></div>
    </form>
  );
}
