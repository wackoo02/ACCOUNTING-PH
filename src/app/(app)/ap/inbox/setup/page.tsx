import { headers } from "next/headers";
import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { aiConfigured, ensureInboxAlias, inboxAddressOf, inboxDomain } from "@/lib/ap/inbox";
import { ActionForm } from "@/components/ActionForm";
import { inboxSettings } from "../../../ap-actions";

// Managed by the company's own administrator: no developer or hosting steps needed.
export default async function InboxSetup() {
  const ctx = await requireCtx("org.manage");
  await ensureInboxAlias(ctx.org.id);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const domain = inboxDomain();
  const veritusAddress = inboxAddressOf(org.apInboxAlias);
  const h = await headers();
  const host = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const ownHook = org.apInboxToken ? `${host}/api/inbound/ap-email/${org.apInboxToken}` : null;
  return (
    <>
      <div className="top">
        <h1>AP Invoice Email</h1>
        <Link className="btn secondary" href="/ap/inbox">Back to inbox</Link>
      </div>
      <p className="muted">Suppliers email their invoices (PDF, JPG or PNG) and they appear in the AP Invoice Inbox for your staff to check. You can change these settings at any time.</p>

      <div className="card">
        <strong>1. Your company&apos;s Veritus inbox address</strong>
        {veritusAddress ? (
          <>
            <p>Anything sent to this address lands in <em>{org.name}</em>&apos;s inbox only.</p>
            <input readOnly value={veritusAddress} style={{ fontSize: 16, fontWeight: 600 }} />
          </>
        ) : (
          <p className="errors">Email receiving has not been switched on for this Veritus service yet, so there is no address to give suppliers. Ask your Veritus provider. Until then, staff can upload invoice files on the inbox page.</p>
        )}
      </div>

      <ActionForm action={inboxSettings} className="card">
        <input type="hidden" name="op" value="save" />
        <strong>2. Settings</strong>
        <div className="row" style={{ marginTop: 8 }}>
          <div style={{ flex: 2 }}>
            <label>Inbox name (the part before the @)</label>
            <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "nowrap" }}>
              <div style={{ flex: 1, minWidth: 0 }}><input name="alias" defaultValue={org.apInboxAlias ?? ""} required pattern="[a-z0-9][a-z0-9.\-]{2,38}[a-z0-9]" /></div>
              {domain && <span className="muted" style={{ whiteSpace: "nowrap" }}>@{domain}</span>}
            </div>
            <p className="muted" style={{ margin: "4px 0 0" }}>Changing it gives you a new address. The old one stops working right away, so tell your suppliers or update your forwarding first.</p>
          </div>
          <div style={{ flex: 2 }}>
            <label>Your own AP email address (optional)</label>
            <input name="address" type="email" defaultValue={org.apInboxAddress ?? ""} placeholder="ap@yourcompany.ph" />
            <p className="muted" style={{ margin: "4px 0 0" }}>If suppliers already email an address of yours, set it to forward to the Veritus address above (see step 3).</p>
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>Only accept invoices from (optional)</label>
          <input name="senders" defaultValue={org.apInboxSenders ?? ""} placeholder="@abcsupply.ph, billing@techhub.ph" />
          <p className="muted" style={{ margin: "4px 0 0" }}>Emails or @domains separated by commas. Leave blank to accept from anyone. Anything else is ignored.</p>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <input type="checkbox" name="enabled" defaultChecked={org.apInboxEnabled} style={{ width: "auto" }} /> Receive invoices by email
        </label>
        <div style={{ marginTop: 10 }}><button>Save settings</button></div>
      </ActionForm>

      <div className="card">
        <strong>3. Forward your own AP mailbox (optional)</strong>
        <p>So suppliers can keep emailing your own domain, set your AP mailbox to forward everything to {veritusAddress ? <code>{veritusAddress}</code> : "your Veritus address"}:</p>
        <ul>
          <li><strong>Google Workspace / Gmail</strong>: Settings → Forwarding and POP/IMAP → Add a forwarding address. For a Google Group, add the Veritus address as a member.</li>
          <li><strong>Microsoft 365 / Outlook</strong>: Settings → Mail → Forwarding → Enable forwarding (or a mail flow rule set up by your IT admin).</li>
        </ul>
        <p className="muted">Only PDF, JPG and PNG attachments are taken; logos and signatures are skipped. The same file sent twice is flagged.</p>
      </div>

      <div className={aiConfigured() ? "notice" : "errors"}><strong>Automatic reading</strong>: {aiConfigured() ? "on. AI reads each invoice and proposes the bill for your staff to check." : "not switched on for this Veritus service. Documents still arrive and staff key in the details."}</div>

      <details className="card">
        <summary><strong>Advanced: use your own inbound-email service</strong></summary>
        <p>Only if your IT team runs its own inbound-email service (Postmark, Cloudflare Email Workers or similar) instead of the Veritus address. It should post each email as JSON to this private address. Keep it secret.</p>
        {ownHook ? <input readOnly value={ownHook} /> : <p className="muted">Not set up.</p>}
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <ActionForm action={inboxSettings}><input type="hidden" name="op" value="rotate" /><button className="secondary">{ownHook ? "Generate a new key (the old address stops working)" : "Create private webhook address"}</button></ActionForm>
          {ownHook && <ActionForm action={inboxSettings}><input type="hidden" name="op" value="token-off" /><button className="secondary">Turn off</button></ActionForm>}
        </div>
      </details>
    </>
  );
}
