import { prisma } from "@/lib/db";
import { DIMENSIONS, type DimKey } from "@/lib/ledger/dimensions";

/** Dimension filter selects for report forms (server component). */
export async function DimFilter({ organizationId, sp }: { organizationId: string; sp: Record<string, string | undefined> }) {
  const vals = await prisma.dimensionValue.findMany({ where: { organizationId }, orderBy: { code: "asc" } });
  const used = DIMENSIONS.filter((d) => vals.some((v) => v.type === d.type));
  return (
    <>
      {used.map((d) => (
        <div key={d.key}><label>{d.label}</label>
          <select name={d.key} defaultValue={sp[d.key] ?? ""}>
            <option value="">All</option>
            {vals.filter((v) => v.type === d.type).map((v) => <option key={v.id} value={v.id}>{v.code} · {v.name}</option>)}
          </select></div>
      ))}
    </>
  );
}

export function dimsFrom(sp: Record<string, string | undefined>) {
  const out: Partial<Record<DimKey, string>> = {};
  for (const d of DIMENSIONS) if (sp[d.key]) out[d.key] = sp[d.key]!;
  return out;
}

export function dimsQs(sp: Record<string, string | undefined>) {
  return DIMENSIONS.filter((d) => sp[d.key]).map((d) => `&${d.key}=${sp[d.key]}`).join("");
}
