import { headers } from "next/headers";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { aiConfigured } from "@/lib/ap/inbox";
import { ActionForm } from "@/components/ActionForm";
import { inboxSettings } from "../../../ap-actions";

export default async function InboxSetup() {
  const ctx = await requireCtx("org.manage");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const h = await headers();
  const host = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const url = org.apInboxToken ? `${host}/api/inbound/ap-email/${org.apInboxToken}` : null;
  return (
    <>
      <div className="top"><h1>AP Inbox · Email Set-up</h1></div>
      <div className="card">
        <strong>1. Webhook address</strong>
        <p>Emails are received by an inbound-email service, which posts each email to Veritus. The address below contains a secret key: keep it private.</p>
        {url ? <input readOnly value={url} onFocus={undefined} /> : <p className="muted">No address yet.</p>}
        <ActionForm action={inboxSettings} style={{ marginTop: 8 }}><input type="hidden" name="op" value="rotate" /><button className="secondary">{url ? "Generate a new key (the old address stops working)" : "Create webhook address"}</button></ActionForm>
      </div>
      <div className="card">
        <strong>2. Connect an inbound-email service (one-time)</strong>
        <ol>
          <li><strong>Postmark</strong> (recommended): create a free account and a Server, open <em>Default Inbound Stream → Settings</em>, paste the webhook address above as the inbound webhook URL, and tick &quot;Include raw email content&quot; off. Postmark gives you an address like <code>abc123@inbound.postmarkapp.com</code>.</li>
          <li>In your company email (Google Workspace or Microsoft 365), create <code>ap@yourcompany.ph</code> (or a group) and set it to <strong>forward</strong> all mail to the Postmark address. Suppliers keep emailing your own domain.</li>
          <li>Alternatives that send the same JSON: Cloudflare Email Routing with an Email Worker, or Mailgun/SendGrid inbound parse through a small relay.</li>
        </ol>
        <p className="muted">Only PDF, JPG and PNG attachments are taken; logos and signatures are skipped. The same file sent twice is flagged.</p>
      </div>
      <div className="card">
        <strong>3. Address shown to staff and suppliers</strong>
        <ActionForm action={inboxSettings} className="row" style={{ marginTop: 8 }}>
          <input type="hidden" name="op" value="address" />
          <div style={{ flex: 3 }}><input name="address" defaultValue={org.apInboxAddress ?? ""} placeholder="ap@yourcompany.ph" /></div>
          <div style={{ flex: 0 }}><button>Save</button></div>
        </ActionForm>
      </div>
      <div className={aiConfigured() ? "notice" : "errors"}><strong>4. Automatic reading</strong>: {aiConfigured() ? "set up (ANTHROPIC_API_KEY is configured)." : "add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables, then redeploy. Without it, documents still arrive and staff key in the details."}</div>
    </>
  );
}
