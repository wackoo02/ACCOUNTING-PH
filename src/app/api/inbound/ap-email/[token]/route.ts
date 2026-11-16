import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/db";
import { addInboxDocument, extractInboxDocument, parseInboundEmail } from "@/lib/ap/inbox";

export const maxDuration = 300;

// POST /api/inbound/ap-email/<token>
// Inbound-email webhook (Postmark inbound JSON, or the same shape from Cloudflare Email Workers / a relay).
// Each PDF/JPG/PNG attachment becomes an AP inbox document and is read by AI after the response is sent.
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const org = token && token.length >= 16 ? await prisma.organization.findUnique({ where: { apInboxToken: token } }) : null;
  if (!org) return NextResponse.json({ error: "unknown inbox" }, { status: 404 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected JSON" }, { status: 400 }); }
  const mail = parseInboundEmail(body);
  const ids: string[] = [];
  const skipped: string[] = [];
  for (const f of mail.files) {
    try {
      const d = await addInboxDocument(org.id, { source: "EMAIL", fileName: f.name, mediaType: f.type, data: f.data, fromEmail: mail.from, subject: mail.subject });
      if (d) ids.push(d.id); else skipped.push(f.name);
    } catch { skipped.push(f.name); }
  }
  after(async () => { for (const id of ids) await extractInboxDocument(org.id, id); });
  // Always 200 so the email provider does not retry an email without invoices.
  return NextResponse.json({ received: ids.length, skipped });
}
