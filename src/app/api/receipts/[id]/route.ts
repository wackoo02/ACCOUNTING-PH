import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";

// Receipt photo for a petty cash voucher, opened from the journal's supporting documents (web login).
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireCtx("reports.view");
  const img = await prisma.receiptImage.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!img) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(img.data), { headers: { "Content-Type": img.mediaType, "Cache-Control": "private, max-age=86400" } });
}
