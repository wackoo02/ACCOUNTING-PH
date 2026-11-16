import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";

// GET /api/ap-inbox/<id> -> the supplier's invoice file, for viewing beside the review form.
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx("reports.view");
  const d = await prisma.apInboxDocument.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!d) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(d.data), {
    headers: { "Content-Type": d.mediaType, "Content-Disposition": `inline; filename="${d.fileName.replace(/[^\w.\- ]+/g, "_")}"`, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
  });
}
