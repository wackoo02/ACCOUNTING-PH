import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/db";
import { extractInboxDocument, parseInboundEmail } from "@/lib/ap/inbox";
import { receiveInboundEmail } from "@/lib/ap/inbound";

export const maxDuration = 300;

// POST /api/inbound/ap-email/<token>
// Private webhook for a company that runs its own inbound-email service (Postmark inbound JSON, or the same
// shape from Cloudflare Email Workers / a relay). Most companies use their Veritus address instead (see ../route.ts).
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const org = token && token.length >= 16 ? await prisma.organization.findUnique({ where: { apInboxToken: token } }) : null;
  if (!org) return NextResponse.json({ error: "unknown inbox" }, { status: 404 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected JSON" }, { status: 400 }); }
  const { ids, skipped } = await receiveInboundEmail(org, parseInboundEmail(body));
  after(async () => { for (const id of ids) await extractInboxDocument(org.id, id); });
  // Always 200 so the email provider does not retry an email without invoices.
  return NextResponse.json({ received: ids.length, skipped });
}
