// Email invoices, receipts and statements (PDF attached) to the customer's invoice addresses.
// Uses any SMTP service (Google Workspace, Microsoft 365, Amazon SES, Resend, Brevo...):
// set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM on the server.
import nodemailer from "nodemailer";
import { prisma } from "../db";
import { LedgerError, asDay, audit } from "../ledger/service";
import { isEmail, parseEmails } from "./compute";
import { invoicePdf, receiptPdf, statementPdf } from "./pdf";

export const emailConfigured = () => !!(process.env.SMTP_HOST && process.env.MAIL_FROM);

export type EmailDoc = { docType: "INVOICE" | "CREDIT_MEMO" | "RECEIPT" | "STATEMENT"; id: string; from?: Date; to?: Date };

/** Default recipients: the customer's invoice emails, else its main email. */
export async function defaultRecipients(organizationId: string, customerId: string) {
  const c = await prisma.customer.findFirst({ where: { id: customerId, organizationId } });
  const list = parseEmails(c?.invoiceEmails);
  return list.length ? list : parseEmails(c?.email);
}

export async function emailDocument(organizationId: string, userId: string, doc: EmailDoc, recipients: string[], note?: string | null) {
  const to = [...new Set(recipients.map((r) => r.trim()).filter(Boolean))];
  if (!to.length) throw new LedgerError(["Add at least one email address (set Invoice Emails on the customer to fill this in automatically)"]);
  const bad = to.filter((e) => !isEmail(e));
  if (bad.length) throw new LedgerError([`Not a valid email address: ${bad.join(", ")}`]);
  if (!emailConfigured()) throw new LedgerError(["Email sending is not set up on the server yet. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM in the hosting settings (Vercel → Settings → Environment Variables), then redeploy. Meanwhile, download the PDF and send it yourself."]);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });

  let pdf: { bytes: Uint8Array; fileName: string };
  let subject: string, body: string, entity: string;
  if (doc.docType === "STATEMENT") {
    const c = await prisma.customer.findFirst({ where: { id: doc.id, organizationId } });
    if (!c) throw new LedgerError(["Customer not found"]);
    pdf = await statementPdf(organizationId, c.id, doc.from!, doc.to!);
    subject = `Statement of account as of ${asDay(doc.to!).toISOString().slice(0, 10)} - ${org.name}`;
    body = `Dear ${c.contactPerson || c.name},\n\nAttached is your statement of account as of ${asDay(doc.to!).toISOString().slice(0, 10)}.`;
    entity = "customer";
  } else if (doc.docType === "RECEIPT") {
    const r = await prisma.arReceipt.findFirst({ where: { id: doc.id, organizationId } });
    if (!r || r.status !== "POSTED") throw new LedgerError(["Only a posted collection can be emailed"]);
    pdf = await receiptPdf(organizationId, r.id);
    subject = `Collection receipt ${r.number} - ${org.name}`;
    body = `Dear ${r.customerName},\n\nThank you for your payment. Attached is collection receipt no. ${r.number}.`;
    entity = "ar_receipt";
  } else {
    const inv = await prisma.salesInvoice.findFirst({ where: { id: doc.id, organizationId } });
    if (!inv || inv.status !== "POSTED") throw new LedgerError(["Only an issued invoice or credit memo can be emailed"]);
    pdf = await invoicePdf(organizationId, inv.id);
    const label = inv.kind === "CREDIT_MEMO" ? "Credit memo" : "Sales invoice";
    subject = `${label} ${inv.number} - ${org.name}`;
    body = `Dear ${inv.customerName},\n\nAttached is ${label.toLowerCase()} no. ${inv.number} dated ${inv.date.toISOString().slice(0, 10)}${inv.kind === "INVOICE" ? `, due on ${inv.dueDate.toISOString().slice(0, 10)}` : ""}.`;
    entity = "sales_invoice";
  }
  const text = `${body}${note?.trim() ? `\n\n${note.trim()}` : ""}\n\nThank you,\n${org.name}`;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  let error: string | null = null;
  try {
    await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, text, attachments: [{ filename: pdf.fileName, content: Buffer.from(pdf.bytes), contentType: "application/pdf" }] });
  } catch (e) { error = (e as Error).message; }
  await prisma.documentEmail.create({ data: { organizationId, docType: doc.docType, docId: doc.id, to: to.join(", "), subject, status: error ? "FAILED" : "SENT", error, sentById: userId } });
  if (error) throw new LedgerError([`The email could not be sent: ${error}`]);
  if (entity === "sales_invoice") await prisma.salesInvoice.update({ where: { id: doc.id }, data: { emailedAt: new Date() } });
  if (entity === "ar_receipt") await prisma.arReceipt.update({ where: { id: doc.id }, data: { emailedAt: new Date() } });
  await prisma.$transaction((tx) => audit(tx, organizationId, userId, "ar.email", doc.id, { to: to.join(", ") }, null, null, entity));
  return { to };
}
