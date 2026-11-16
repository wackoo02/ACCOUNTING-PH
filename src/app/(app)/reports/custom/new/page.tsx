import { requireCtx } from "@/lib/auth";
import { definitionSchema } from "@/lib/reporting/definition";
import { templateById } from "@/lib/reporting/templates";
import { builderLookups } from "@/lib/reporting/lookups";
import { ReportBuilder } from "@/components/reporting/ReportBuilder";
import { DIMENSIONS } from "@/lib/ledger/dimensions";
import { prisma } from "@/lib/db";
import { runReportAction } from "../actions";

type SP = Promise<Record<string, string | undefined>>;
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Opens the builder from a template. Standard report pages link here with their current dates and filters.
export default async function NewCustomReport({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const t = templateById(sp.template ?? "") ?? templateById("trial_balance")!;
  const input = structuredClone(t.def);
  if (isDate(sp.to)) {
    input.periods = [{ id: "p1", kind: "custom", from: isDate(sp.from) ? sp.from : `${sp.to!.slice(0, 4)}-01-01`, to: sp.to }, ...(input.periods ?? []).slice(1)];
    input.comparisons = (input.comparisons ?? []).filter((c) => input.periods!.some((p) => p.id === c.base) && input.periods!.some((p) => p.id === c.against));
  }
  // Carry dimension filters (ids on standard pages) over as codes.
  const dimIds = DIMENSIONS.map((d) => [d.key, sp[d.key]] as const).filter(([, v]) => v);
  if (dimIds.length) {
    const vals = await prisma.dimensionValue.findMany({ where: { organizationId: ctx.org.id, id: { in: dimIds.map(([, v]) => v!) } } });
    input.filters = { ...(input.filters ?? {}), dims: Object.fromEntries(dimIds.map(([k, v]) => [k, vals.filter((x) => x.id === v).map((x) => x.code)])) };
  }
  const def = definitionSchema.parse(input);
  const [lookups, first] = await Promise.all([builderLookups(ctx.user.id, ctx.org.id), runReportAction(def)]);
  return <ReportBuilder key={t.id} initialDef={def} initialResult={first} lookups={lookups} saved={null} startOpen={sp.open !== "0"} />;
}
