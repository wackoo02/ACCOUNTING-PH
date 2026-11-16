import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { MASTERS, isMasterKind } from "@/lib/masters/config";
import { buildWorkbook } from "@/lib/masters/excel";
import { listMasters } from "@/lib/masters/query";

// GET /api/masters/<kind>/template  -> blank template
// GET /api/masters/<kind>/export    -> template filled with current records (edit and re-upload)
export async function GET(_: Request, { params }: { params: Promise<{ kind: string; file: string }> }) {
  const { kind, file } = await params;
  if (!isMasterKind(kind) || !["template", "export"].includes(file)) return new NextResponse("Not found", { status: 404 });
  const ctx = await requireCtx("reports.view");
  const records = file === "export" ? await listMasters(kind, ctx.org.id) : [];
  const buf = await buildWorkbook(kind, records);
  const name = `${MASTERS[kind].title.replace(/[^A-Za-z]+/g, "-")}-${file}.xlsx`;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
