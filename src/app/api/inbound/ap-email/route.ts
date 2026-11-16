import { NextResponse, after } from "next/server";
import { timingSafeEqual } from "crypto";
import { extractInboxDocument, organizationForRecipients, parseInboundEmail } from "@/lib/ap/inbox";
import { receiveInboundEmail } from "@/lib/ap/inbound";

export const maxDuration = 300;

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// POST /api/inbound/ap-email
// The one shared webhook for every company's Veritus inbox address (<alias>@AP_INBOX_DOMAIN). The email service
// (Postmark inbound with a catch-all domain) posts every email here; it is routed to the company by recipient.
// Protected by INBOUND_WEBHOOK_SECRET, sent as HTTP basic auth password (https://veritus:<secret>@host/...) or ?key=.
export async function POST(req: Request) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET ?? "";
  if (secret.length < 16) return NextResponse.json({ error: "inbound email is not configured" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  const basic = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":") : "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!same(basic, secret) && !same(key, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected JSON" }, { status: 400 }); }
  const mail = parseInboundEmail(body);
  const org = await organizationForRecipients(mail.to);
  // 200 even when no company matches, so the email service does not keep retrying.
  if (!org) return NextResponse.json({ received: 0, skipped: ["no company uses this address"] });
  const { ids, skipped } = await receiveInboundEmail(org, mail);
  after(async () => { for (const id of ids) await extractInboxDocument(org.id, id); });
  return NextResponse.json({ received: ids.length, skipped });
}
