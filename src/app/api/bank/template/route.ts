import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { statementTemplate } from "@/lib/bank/recon";

// GET /api/bank/template -> blank bank statement upload template
export async function GET() {
  await requireCtx("reports.view");
  const buf = await statementTemplate();
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="Bank-Statement-template.xlsx"',
    },
  });
}
