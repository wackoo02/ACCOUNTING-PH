import { requireCtx } from "@/lib/auth";
import { runReport } from "@/lib/reporting/run";
import { resultWorkbook } from "@/lib/reporting/excel";

// POST a form with field "definition" (the builder's JSON) to download the report as Excel.
export async function POST(req: Request) {
  const ctx = await requireCtx("reports.view");
  const fd = await req.formData();
  let def: unknown;
  try { def = JSON.parse(String(fd.get("definition") ?? "")); } catch { return new Response("Invalid report", { status: 400 }); }
  const r = await runReport({ userId: ctx.user.id, currentOrgId: ctx.org.id }, def);
  if (!r.ok) return new Response(r.errors.join("\n"), { status: 400 });
  const buf = await resultWorkbook(r.result);
  const name = (r.result.title || "report").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "report";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}.xlsx"`,
    },
  });
}
