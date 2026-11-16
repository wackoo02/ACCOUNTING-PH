// AP invoice inbox. Suppliers email PDF/JPG/PNG invoices to the company's AP address (or staff upload them).
// Each file is read by Claude: supplier, TIN, invoice no., dates, PO no., lines with VAT, EWT and a
// classification (expense, prepayment, fixed asset, inventory) with a proposed account. The supplier and PO
// are matched, duplicates flagged, and accounting staff review and correct everything before a bill is created.
// The bill then goes through the AP approval matrix like any other.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { createHash, randomBytes } from "crypto";
import { z } from "zod/v4";
import { prisma } from "../db";
import { LedgerError, audit } from "../ledger/service";
import { suggestAccountCode } from "../pettycash/compute";
import { findDuplicateBill, normInvoiceNo } from "./bills";
import { cents } from "./common";
import { toCentavos } from "../money";

const MODEL = process.env.AP_INVOICE_MODEL || process.env.RECEIPT_MODEL || "claude-opus-5-5";
export const INBOX_MEDIA = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type Media = (typeof INBOX_MEDIA)[number];
const MAX_BYTES = 20 * 1024 * 1024;

const money = z.string().describe("Amount as digits with 2 decimals, e.g. 1234.50. Use 0.00 when absent.");

export const InvoiceSchema = z.object({
  isInvoice: z.boolean().describe("false if this is not a supplier invoice, billing statement, official receipt or similar"),
  docType: z.enum(["SALES_INVOICE", "SERVICE_INVOICE", "BILLING_STATEMENT", "OFFICIAL_RECEIPT", "STATEMENT_OF_ACCOUNT", "OTHER"]),
  invoiceNo: z.string().describe("Invoice / billing serial number as printed; empty if unreadable"),
  invoiceDate: z.string().describe("YYYY-MM-DD; empty if unreadable"),
  dueDate: z.string().describe("YYYY-MM-DD if printed, else empty"),
  paymentTerms: z.string().describe("e.g. 30 days, COD; empty if none"),
  poNumber: z.string().describe("Our purchase order number if the invoice mentions one; empty if none"),
  currency: z.string().describe("ISO code, PHP unless another currency is shown"),
  vendor: z.object({
    name: z.string().describe("Registered business name of the supplier (the seller, not the buyer)"),
    tin: z.string().describe("Supplier TIN as printed, e.g. 123-456-789-00000; empty if none"),
    address: z.string(),
    vatRegistered: z.boolean().describe("true if VAT REG TIN or 12% VAT is shown; false for NON-VAT"),
    email: z.string().describe("Supplier email if printed; empty if none"),
  }),
  pricesIncludeVat: z.boolean().describe("true if the line amounts include VAT (usual for PH sales invoices)"),
  lines: z.array(z.object({
    description: z.string(),
    quantity: z.string().describe("Digits, 1 if not shown"),
    unitPrice: money,
    amount: money.describe("Line amount as printed"),
    vatType: z.enum(["VATABLE", "ZERO_RATED", "EXEMPT"]),
    classification: z.enum(["EXPENSE", "PREPAYMENT", "FIXED_ASSET", "INVENTORY"]).describe("PREPAYMENT for insurance, rent, subscriptions, licenses or retainers covering future months; FIXED_ASSET for durable equipment, furniture, computers or vehicles at or above the capitalization threshold; INVENTORY for goods bought for resale or production"),
    accountCode: z.string().describe("Best matching account code from the provided chart of accounts"),
    coverageStart: z.string().describe("For a prepayment, the start of the period covered (YYYY-MM-DD), else empty"),
    coverageEnd: z.string().describe("For a prepayment, the end of the period covered (YYYY-MM-DD), else empty"),
    reason: z.string().describe("A few words on the classification and account"),
  })),
  vatableSales: money,
  vatAmount: money,
  vatExemptSales: money,
  zeroRatedSales: money,
  totalAmountDue: money,
  withholdingTaxShown: money.describe("Any withholding tax the invoice already deducts or mentions; 0.00 if none"),
  ewtAtcSuggestion: z.string().describe("Most likely BIR ATC for expanded withholding on this purchase (e.g. WC158 goods, WC160 services, WC100 rent, WC010/WI010 professional fees); empty if none applies"),
  notes: z.string().describe("Anything unclear, handwritten, or that the reviewer must check"),
  confidence: z.enum(["high", "medium", "low"]),
});
export type InvoiceExtraction = z.infer<typeof InvoiceSchema>;

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function mediaOf(fileName: string, declared?: string | null): Media | null {
  const d = (declared ?? "").toLowerCase().split(";")[0].trim();
  if ((INBOX_MEDIA as readonly string[]).includes(d)) return d as Media;
  const ext = fileName.toLowerCase().split(".").pop();
  return ({ pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" } as Record<string, Media>)[ext ?? ""] ?? null;
}

/** Store one incoming file. Returns null for files that are not invoices (signatures, logos, other types). */
export async function addInboxDocument(organizationId: string, input: { source: "EMAIL" | "UPLOAD"; fileName: string; mediaType?: string | null; data: Buffer; fromEmail?: string | null; subject?: string | null; uploadedById?: string | null }) {
  const media = mediaOf(input.fileName, input.mediaType);
  if (!media) {
    if (input.source === "UPLOAD") throw new LedgerError([`${input.fileName}: upload a PDF, JPG or PNG file`]);
    return null;
  }
  if (!input.data.length) throw new LedgerError([`${input.fileName} is empty`]);
  if (input.data.length > MAX_BYTES) throw new LedgerError([`${input.fileName} is larger than 20 MB`]);
  // Email signatures and logos: tiny images are not invoices.
  if (input.source === "EMAIL" && media !== "application/pdf" && input.data.length < 15 * 1024) return null;
  const hash = sha256(input.data);
  const same = await prisma.apInboxDocument.findFirst({ where: { organizationId, sha256: hash, status: { not: "REJECTED" } } });
  const doc = await prisma.apInboxDocument.create({ data: {
    organizationId, source: input.source, fileName: input.fileName.slice(0, 200), mediaType: media, data: new Uint8Array(input.data), sha256: hash,
    fromEmail: input.fromEmail?.slice(0, 200) || null, subject: input.subject?.slice(0, 300) || null, uploadedById: input.uploadedById ?? null,
    duplicateOfId: same?.id ?? null, status: "NEW",
  } });
  await prisma.$transaction((tx) => audit(tx, organizationId, input.uploadedById ?? null, "ap_inbox.receive", doc.id, { source: input.source, file: doc.fileName, from: doc.fromEmail }, null, null, "ap_inbox"));
  return doc;
}

export const aiConfigured = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

/** Read a document with Claude and match the supplier and PO. Safe to call again ("Read again"). */
export async function extractInboxDocument(organizationId: string, id: string) {
  const doc = await prisma.apInboxDocument.findFirst({ where: { id, organizationId } });
  if (!doc) throw new LedgerError(["Document not found"]);
  if (doc.status === "BILLED") throw new LedgerError(["A bill was already created from this document"]);
  if (!aiConfigured()) {
    await prisma.apInboxDocument.update({ where: { id }, data: { status: "READY", error: "Automatic reading is not set up on the server (ANTHROPIC_API_KEY). Enter the details by hand." } });
    return null;
  }
  await prisma.apInboxDocument.update({ where: { id }, data: { status: "READING", error: null } });
  try {
    const [org, accounts] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
      prisma.account.findMany({
        where: { organizationId, isActive: true, isPostable: true, OR: [{ type: "EXPENSE" }, { type: "ASSET", ifrsGroup: { in: ["Property, plant and equipment", "Intangible assets", "Inventories", "Prepayments and other current assets"] } }] },
        orderBy: { code: "asc" },
      }),
    ]);
    const chart = accounts.map((a) => `${a.code} ${a.name} [${a.type === "EXPENSE" ? "expense" : a.ifrsGroup}]`).join("\n");
    const system = [
      `You read Philippine supplier invoices, billing statements and official receipts addressed to ${org.name}${org.tin ? ` (TIN ${org.tin})` : ""} for its accounts payable.`,
      "The supplier is the seller who issued the document, never the buyer. Copy what is printed; never invent a TIN, invoice number, PO number or amount. Leave a field empty when unreadable and say so in notes.",
      "Philippine VAT is 12%. On VAT-inclusive invoices, VAT = VATable sales x 12% and VATable sales + VAT = total.",
      `Classify each line: FIXED_ASSET only for durable items with a unit cost of at least PHP ${org.fixedAssetThreshold.toString()}; PREPAYMENT when it pays for future periods (give the coverage dates); INVENTORY for goods for resale or production; otherwise EXPENSE.`,
      "Choose each line's account only from this chart of accounts:",
      chart,
    ].join("\n\n");
    const b64 = Buffer.from(doc.data).toString("base64");
    const file = doc.mediaType === "application/pdf"
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: b64 } }
      : { type: "image" as const, source: { type: "base64" as const, media_type: doc.mediaType as Exclude<Media, "application/pdf">, data: b64 } };
    const client = new Anthropic();
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(InvoiceSchema) },
      system,
      messages: [{ role: "user", content: [file, { type: "text", text: `Extract this supplier invoice for accounts payable.${doc.subject ? ` Email subject: ${doc.subject}` : ""}` }] }],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error("The document could not be read. Enter the details by hand.");
    const r = res.parsed_output;
    const match = await matchExtraction(organizationId, r, doc.id);
    await prisma.apInboxDocument.update({ where: { id }, data: {
      status: "READY", extraction: { model: res.model, readAt: new Date().toISOString(), result: r }, vendorId: match.vendorId, purchaseOrderId: match.purchaseOrderId,
      error: !r.isInvoice ? "This does not look like a supplier invoice. Check it, then reject it or enter the details." : null,
    } });
    return r;
  } catch (e) {
    const msg = e instanceof LedgerError ? e.errors.join("; ") : e instanceof Error ? e.message : String(e);
    await prisma.apInboxDocument.update({ where: { id }, data: { status: "FAILED", error: msg.slice(0, 500) } });
    return null;
  }
}

const tinKey = (t: string | null | undefined) => (t ?? "").replace(/\D/g, "").slice(0, 9);
const nameKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/\b(INC|CORP|CORPORATION|CO|COMPANY|LTD|OPC|PHILIPPINES|PHILS)\b\.?/g, "").replace(/[^A-Z0-9]/g, "");

/** Supplier by TIN (then name), and the approved PO by number or by open POs of that supplier. */
export async function matchExtraction(organizationId: string, r: InvoiceExtraction, selfDocId?: string) {
  const vendors = await prisma.vendor.findMany({ where: { organizationId, isActive: true } });
  const t = tinKey(r.vendor.tin);
  let vendor = t.length === 9 ? vendors.find((v) => tinKey(v.tin) === t) : undefined;
  vendor ??= vendors.find((v) => nameKey(v.name) && nameKey(v.name) === nameKey(r.vendor.name));
  let po = null;
  if (r.poNumber.trim()) {
    const want = r.poNumber.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const cands = await prisma.purchaseOrder.findMany({ where: { organizationId, status: { in: ["APPROVED", "CLOSED"] }, ...(vendor ? { vendorId: vendor.id } : {}) }, take: 500, orderBy: { poDate: "desc" } });
    po = cands.find((p) => p.number.toUpperCase().replace(/[^A-Z0-9]/g, "") === want) ?? cands.find((p) => p.number.replace(/\D/g, "").replace(/^0+/, "") === want.replace(/\D/g, "").replace(/^0+/, "") && want.replace(/\D/g, "")) ?? null;
  }
  if (!po && vendor) {
    // One approved PO for this supplier with the same total: likely the one.
    let total = 0n;
    try { total = toCentavos(r.totalAmountDue); } catch { /* ignore */ }
    const open = await prisma.purchaseOrder.findMany({ where: { organizationId, vendorId: vendor.id, status: "APPROVED" } });
    const same = open.filter((p) => total > 0n && cents(p.amount) === total);
    if (same.length === 1) po = same[0];
  }
  const dupBill = vendor && r.invoiceNo ? await findDuplicateBill(prisma, organizationId, vendor.id, r.invoiceNo) : null;
  let dupDoc = null;
  if (!dupBill && r.invoiceNo) {
    const others = await prisma.apInboxDocument.findMany({ where: { organizationId, status: { in: ["READY", "BILLED"] }, ...(selfDocId ? { id: { not: selfDocId } } : {}) }, select: { id: true, extraction: true, vendorId: true } });
    dupDoc = others.find((o) => {
      const x = (o.extraction as { result?: InvoiceExtraction } | null)?.result;
      return x && normInvoiceNo(x.invoiceNo) === normInvoiceNo(r.invoiceNo) && (tinKey(x.vendor.tin) === t || nameKey(x.vendor.name) === nameKey(r.vendor.name));
    }) ?? null;
  }
  return { vendorId: vendor?.id ?? null, purchaseOrderId: po?.id ?? null, duplicateBill: dupBill, duplicateDocId: dupDoc?.id ?? null };
}

/** Proposed bill lines from an extraction, with accounts resolved to ids. */
export async function proposedLines(organizationId: string, r: InvoiceExtraction, vendorAtc?: string | null) {
  const [accounts, taxCodes] = await Promise.all([
    prisma.account.findMany({ where: { organizationId, isActive: true, isPostable: true } }),
    prisma.taxCode.findMany({ where: { organizationId, taxType: "EWT", isActive: true } }),
  ]);
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const atc = (vendorAtc || r.ewtAtcSuggestion || "").toUpperCase();
  const ewt = atc ? taxCodes.find((t) => (t.atcCode ?? t.code).toUpperCase() === atc) : undefined;
  return r.lines.map((l) => {
    const code = byCode.has(l.accountCode) ? l.accountCode : suggestAccountCode(l.description);
    const a = code ? byCode.get(code) : undefined;
    return {
      description: l.description, category: l.classification, accountId: a?.id ?? "", quantity: l.quantity || "1",
      unitPrice: l.unitPrice && l.unitPrice !== "0.00" ? l.unitPrice : l.amount, vatType: l.vatType, ewtTaxCodeId: ewt?.id ?? "",
      prepaidStart: l.coverageStart || "", prepaidEnd: l.coverageEnd || "", reason: l.reason, poLineId: "",
    };
  });
}

export async function rejectInboxDocument(organizationId: string, userId: string, id: string, reason: string) {
  const doc = await prisma.apInboxDocument.findFirst({ where: { id, organizationId } });
  if (!doc) throw new LedgerError(["Document not found"]);
  if (doc.status === "BILLED") throw new LedgerError(["A bill was already created from this document; void the bill instead"]);
  if (!reason.trim()) throw new LedgerError(["Give a reason (e.g. not an invoice, duplicate, not ours)"]);
  await prisma.apInboxDocument.update({ where: { id }, data: { status: "REJECTED", rejectReason: reason.trim(), reviewedById: userId, reviewedAt: new Date() } });
  await prisma.$transaction((tx) => audit(tx, organizationId, userId, "ap_inbox.reject", id, { reason }, null, null, "ap_inbox"));
}

// ---------- Email address set-up ----------

/** Create (or rotate) the secret token in the inbound-email webhook URL. */
export async function rotateInboxToken(organizationId: string, userId: string) {
  const token = randomBytes(18).toString("base64url");
  await prisma.organization.update({ where: { id: organizationId }, data: { apInboxToken: token } });
  await prisma.$transaction((tx) => audit(tx, organizationId, userId, "ap_inbox.token", organizationId, null, null, null, "organization"));
  return token;
}

/**
 * Parse an inbound-email webhook. Accepts Postmark's inbound JSON (Attachments[].Name/Content/ContentType)
 * and the same shape in lower case (Cloudflare Email Workers, custom relays).
 */
export function parseInboundEmail(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const get = (k: string) => b[k] ?? b[k.charAt(0).toLowerCase() + k.slice(1)];
  const fromFull = get("FromFull") as { Email?: string } | undefined;
  const from = String(fromFull?.Email ?? get("From") ?? "");
  const subject = String(get("Subject") ?? "");
  const atts = (get("Attachments") as unknown[] | undefined) ?? [];
  const files = atts.map((a) => {
    const x = a as Record<string, unknown>;
    const name = String(x.Name ?? x.name ?? x.filename ?? "attachment");
    const content = String(x.Content ?? x.content ?? "");
    const type = String(x.ContentType ?? x.contentType ?? x.content_type ?? "");
    return { name, type, data: Buffer.from(content, "base64") };
  });
  return { from, subject, files };
}
