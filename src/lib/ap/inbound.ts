// Shared handling of an inbound supplier email for the AP invoice inbox (used by both webhook routes).
import type { Organization } from "@prisma/client";
import { addInboxDocument, parseInboundEmail, senderAllowed } from "./inbox";

/** Store each PDF/JPG/PNG attachment as an inbox document. Returns the new document ids and what was skipped. */
export async function receiveInboundEmail(org: Organization, mail: ReturnType<typeof parseInboundEmail>) {
  const ids: string[] = [];
  const skipped: string[] = [];
  if (!org.apInboxEnabled) return { ids, skipped: ["inbox turned off by the company"] };
  if (!senderAllowed(org.apInboxSenders, mail.from)) return { ids, skipped: [`sender ${mail.from || "(unknown)"} is not on the company's allowed list`] };
  for (const f of mail.files) {
    try {
      const d = await addInboxDocument(org.id, { source: "EMAIL", fileName: f.name, mediaType: f.type, data: f.data, fromEmail: mail.from, subject: mail.subject });
      if (d) ids.push(d.id); else skipped.push(f.name);
    } catch { skipped.push(f.name); }
  }
  return { ids, skipped };
}
