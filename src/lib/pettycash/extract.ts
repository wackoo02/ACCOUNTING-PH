// Reads a receipt photo with Claude and proposes the voucher: supplier, TIN, items, VAT,
// tips (including handwritten ones), and an expense account for each item.
// The API key stays on the server; the phone only sends the photo.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { prisma } from "../db";
import { LedgerError } from "../ledger/service";
import { suggestAccountCode } from "./compute";

const MODEL = process.env.RECEIPT_MODEL || "claude-opus-5-5";
const MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type Media = (typeof MEDIA)[number];
const MAX_BYTES = 5 * 1024 * 1024;

const money = z.string().describe("Amount in pesos as digits with 2 decimals, e.g. 1234.50. Use 0.00 when absent.");

export const ReceiptSchema = z.object({
  isReceipt: z.boolean().describe("false if the photo is not a receipt, invoice or other accounting record"),
  docType: z.enum(["OR", "SI", "CASH_INVOICE", "AR", "OTHER"]).describe("OR = official receipt, SI = sales invoice"),
  docNumber: z.string().describe("Receipt / invoice serial number, empty if unreadable"),
  date: z.string().describe("Receipt date as YYYY-MM-DD, empty if unreadable"),
  vendor: z.object({
    name: z.string().describe("Registered business name of the supplier"),
    tin: z.string().describe("Supplier TIN as printed, e.g. 123-456-789-00000; empty if none"),
    address: z.string().describe("Supplier business address as printed"),
    vatRegistered: z.boolean().describe("true if the receipt shows VAT REG TIN, VATable sales or 12% VAT; false for NON-VAT"),
  }),
  items: z.array(z.object({
    description: z.string(),
    quantity: z.string().describe("Quantity as digits, 1 if not shown"),
    unitPrice: money,
    amount: money.describe("Line amount as printed (VAT-inclusive)"),
    accountCode: z.string().describe("Best matching account code from the provided chart of accounts"),
    isPotentialFixedAsset: z.boolean().describe("true for durable equipment, furniture, computers, appliances or vehicles"),
    reason: z.string().describe("A few words on why this account fits"),
  })),
  vatableSales: money,
  vatAmount: money,
  vatExemptSales: money,
  zeroRatedSales: money,
  totalAmountDue: money.describe("Total printed on the receipt, before any tip"),
  tip: money.describe("Tip or service charge paid on top, printed or handwritten"),
  tipHandwritten: z.boolean(),
  amountPaid: money.describe("Total actually paid, including any tip; handwritten totals count"),
  notes: z.string().describe("Anything unclear, crossed out or handwritten that the reviewer should check"),
  confidence: z.enum(["high", "medium", "low"]),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export async function saveReceiptImage(organizationId: string, userId: string, base64: string, mediaType: string) {
  if (!MEDIA.includes(mediaType as Media)) throw new LedgerError(["Upload a JPEG, PNG, WEBP or GIF photo"]);
  const data = Buffer.from(base64 ?? "", "base64");
  if (!data.length) throw new LedgerError(["The photo is empty"]);
  if (data.length > MAX_BYTES) throw new LedgerError(["The photo is larger than 5 MB; take it again at a lower resolution"]);
  return prisma.receiptImage.create({ data: { organizationId, uploadedById: userId, mediaType, data }, select: { id: true } });
}

/** Read a saved photo and propose voucher fields. Needs ANTHROPIC_API_KEY on the server. */
export async function extractReceipt(organizationId: string, imageId: string) {
  const img = await prisma.receiptImage.findFirst({ where: { id: imageId, organizationId } });
  if (!img) throw new LedgerError(["Receipt photo not found"]);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new LedgerError(["Receipt reading is not set up on the server (ANTHROPIC_API_KEY). Enter the details by hand."]);
  }
  const [org, accounts, vendors] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    prisma.account.findMany({
      where: { organizationId, isActive: true, isPostable: true, OR: [{ type: "EXPENSE" }, { type: "ASSET", ifrsGroup: "Property, plant and equipment" }] },
      orderBy: { code: "asc" },
    }),
    prisma.vendor.findMany({ where: { organizationId, isActive: true }, select: { id: true, name: true, tin: true, atcCode: true, vatRegistered: true } }),
  ]);
  const chart = accounts.map((a) => `${a.code} ${a.name}${a.type === "ASSET" ? " (fixed asset)" : ""}`).join("\n");

  const system = [
    "You read Philippine receipts, official receipts and sales invoices for a company's petty cash book.",
    "Copy what is printed or handwritten; never invent a TIN, serial number or amount. Leave a field empty when you cannot read it and say so in notes.",
    "Philippine VAT is 12% and is included in printed prices: VAT = VATable sales x 12%, and VATable sales + VAT = the VAT-inclusive total.",
    "Tips are often handwritten on the slip or added to a card charge; report them separately from the printed total.",
    `Choose each item's account only from this chart of accounts. Use a fixed asset account only for a durable item whose unit price is at least PHP ${org.fixedAssetThreshold.toString()}.`,
    chart,
  ].join("\n\n");

  const client = new Anthropic();
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(ReceiptSchema) },
    system,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: img.mediaType as Media, data: Buffer.from(img.data).toString("base64") } },
        { type: "text", text: "Extract this receipt for the petty cash voucher." },
      ],
    }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) throw new LedgerError(["The photo could not be read. Retake it or enter the details by hand."]);
  const r = res.parsed_output;

  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const tinKey = (t: string | null | undefined) => (t ?? "").replace(/\D/g, "").slice(0, 9);
  const vendor = r.vendor.tin ? vendors.find((v) => tinKey(v.tin) && tinKey(v.tin) === tinKey(r.vendor.tin)) : null;

  return {
    imageId,
    model: res.model,
    receipt: r,
    vendorMatch: vendor ? { id: vendor.id, name: vendor.name, atcCode: vendor.atcCode, vatRegistered: vendor.vatRegistered } : null,
    items: r.items.map((it) => {
      const code = byCode.has(it.accountCode) ? it.accountCode : suggestAccountCode(it.description);
      const a = code ? byCode.get(code) : undefined;
      return { ...it, suggestedAccountId: a?.id ?? null, suggestedAccountCode: a?.code ?? null, suggestedAccountName: a?.name ?? null };
    }),
  };
}

/** Rule-based account suggestion for manual entry (no AI call). */
export async function suggestAccount(organizationId: string, description: string) {
  const code = suggestAccountCode(description ?? "");
  if (!code) return null;
  const a = await prisma.account.findFirst({ where: { organizationId, code, isActive: true, isPostable: true } });
  return a ? { id: a.id, code: a.code, name: a.name } : null;
}
