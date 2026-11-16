import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { budgetWorkbook } from "@/lib/budgets";

export async function GET(_: Request, { params }: { params: Promise<{ year: string }> }) {
  const ctx = await requireCtx("reports.view");
  const year = Number((await params).year);
  if (!Number.isInteger(year)) return new NextResponse("Bad year", { status: 400 });
  const buf = await budgetWorkbook(ctx.org.id, year);
  return new NextResponse(new Uint8Array(buf), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="Budget-FY${year}.xlsx"`,
  } });
}
