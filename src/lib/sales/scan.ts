// Sales invoice scanning (Veritus Mobility "Sales Invoice" tile): photograph an issued sales invoice,
// let the AI read it, review, and send the sales journal to the GL for approval.
// Full AR (invoice printing in BIR format, collections, aging) comes with the receivables module.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { prisma } from "../db";
import { fromCentavos, toCentavos } from "../money";
import { LedgerError, asDay, recordJournalTx } from "../ledger/service";

const MODEL = process.env.RECEIPT_MODEL || "claude-opus-5-5";
const money = z.string().describe("Amount in pesos as digits with 2 decimals, e.g. 1234.50. Use 0.00 when absent.");

export const SalesInvoiceSchema = z.object({
  isSalesInvoice: z.boolean().describe("false if the photo is not a sales invoice / official receipt issued by the company"),
  docType: z.enum(["SI", "OR", "CHARGE_INVOICE", "CASH_INVOICE", "OTHER"]),
  invoiceNumber: z.string().describe("Serial number printed on the invoice"),
  date: z.string().describe("Invoice date as YYYY-MM-DD"),
  customer: z.object({ name: z.string(), tin: z.string().describe("Customer TIN if written; empty if none"), address: z.string() }),
  terms: z.enum(["CASH", "CHARGE"]).describe("CASH if paid on the spot (cash sales / OR), CHARGE if on account"),
  items: z.array(z.object({ description: z.string(), quantity: z.string(), unitPrice: money, amount: money, isService: z.boolean() })),
  vatableSales: money, vatAmount: money, vatExemptSales: money, zeroRatedSales: money,
  totalAmountDue: money,
  withholdingTax: money.describe("Creditable withholding tax deducted by the customer, if written (BIR 2307)"),
  notes: z.string(), confidence: z.enum(["high", "medium", "low"]),
});
export type ScannedInvoice = z.infer<typeof SalesInvoiceSchema>;

export async function extractSalesInvoice(organizationId: string, imageId: string) {
  const img = await prisma.receiptImage.findFirst({ where: { id: imageId, organizationId } });
  if (!img) throw new LedgerError(["Photo not found"]);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new LedgerError(["Invoice reading is not set up on the server (ANTHROPIC_API_KEY). Enter the details by hand."]);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const res = await new Anthropic().beta.messages.parse({
    model: MODEL, max_tokens: 8000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(SalesInvoiceSchema) },
    system: [
      `You read sales invoices and official receipts that ${org.name} issued to its customers in the Philippines.`,
      "Copy what is printed or handwritten; never invent a serial number, TIN or amount. Leave fields empty when unreadable and say so in notes.",
      "Philippine VAT is 12% and is included in the total: VAT = VATable sales x 12%.",
    ].join("\n\n"),
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: img.mediaType as "image/jpeg", data: Buffer.from(img.data).toString("base64") } },
      { type: "text", text: "Extract this sales invoice." },
    ] }],
  });
  if (!res.parsed_output) throw new LedgerError(["The photo could not be read. Retake it or enter the details by hand."]);
  const r = res.parsed_output;
  const digits = (t: string) => t.replace(/\D/g, "").slice(0, 9);
  const customers = await prisma.customer.findMany({ where: { organizationId, isActive: true } });
  const match = customers.find((c) => (r.customer.tin && c.tin && digits(c.tin) === digits(r.customer.tin)) || c.name.toLowerCase() === r.customer.name.trim().toLowerCase());
  return { imageId, model: res.model, invoice: r, customerMatch: match ? { id: match.id, code: match.code, name: match.name } : null };
}

export type SalesScanInput = {
  invoiceNumber: string; date: string; docType?: string | null; terms: "CASH" | "CHARGE";
  customerId?: string | null; customerName?: string | null; customerTin?: string | null;
  vatableSales?: string | null; vatAmount?: string | null; vatExemptSales?: string | null; zeroRatedSales?: string | null;
  total: string; withholdingTax?: string | null; isService?: boolean | null; memo?: string | null; imageId?: string | null;
};

/** Validate and build the journal: Dr cash / AR (+ CWT), Cr sales, Cr output VAT. */
export async function previewSalesScan(organizationId: string, input: SalesScanInput) {
  const errors: string[] = [];
  const c = (v: string | null | undefined, label: string) => { try { return toCentavos(v ?? "0"); } catch { errors.push(`${label}: enter an amount`); return 0n; } };
  const total = c(input.total, "Total"), vatable = c(input.vatableSales, "VATable sales"), exempt = c(input.vatExemptSales, "VAT-exempt sales"), zero = c(input.zeroRatedSales, "Zero-rated sales"), cwt = c(input.withholdingTax, "Withholding tax");
  const vat = input.vatAmount && input.vatAmount.trim() !== "" ? c(input.vatAmount, "VAT") : (vatable * 12n + 50n) / 100n;
  if (!input.invoiceNumber?.trim()) errors.push("Enter the invoice number");
  if (!input.date || Number.isNaN(Date.parse(input.date))) errors.push("Enter the invoice date");
  if (total <= 0n) errors.push("Enter the invoice total");
  const net = total - vat;
  if (vatable && vatable + exempt + zero !== net && vatable + vat + exempt + zero !== total) errors.push("VATable + exempt + zero-rated sales + VAT do not add up to the total");
  if (cwt < 0n || cwt >= total) errors.push("Withholding tax must be less than the total");
  const customer = input.customerId ? await prisma.customer.findFirst({ where: { id: input.customerId, organizationId } }) : null;
  if (input.customerId && !customer) errors.push("Customer not found");
  if (input.terms === "CHARGE" && !customer) errors.push("Charge sales need a customer from the customer list (for receivables and aging)");
  const role = async (r: string) => prisma.account.findFirst({ where: { organizationId, systemRole: r } });
  const [ar, cash, sales, service, outVat, cwtAcct] = await Promise.all([role("AR_CONTROL"), role("CASH_ON_HAND"), role("SALES"), role("SERVICE_INCOME"), role("OUTPUT_VAT"), role("CWT_RECEIVABLE")]);
  const revenue = input.isService ? service ?? sales : sales ?? service;
  const debit = input.terms === "CHARGE" ? ar : cash;
  if (!debit) errors.push(`No account is assigned the role ${input.terms === "CHARGE" ? "AR_CONTROL" : "CASH_ON_HAND"}`);
  if (!revenue) errors.push("No sales / service income account is assigned");
  if (vat > 0n && !outVat) errors.push("No account is assigned the role OUTPUT_VAT");
  if (cwt > 0n && !cwtAcct) errors.push("No account is assigned the role CWT_RECEIVABLE");
  const ref = `SI ${input.invoiceNumber?.trim()}`;
  const dup = input.invoiceNumber?.trim() ? await prisma.journalEntry.findFirst({ where: { organizationId, source: "SALES", reference: ref, status: { not: "VOID" } } }) : null;
  if (dup) errors.push(`Invoice ${input.invoiceNumber} is already recorded in ${dup.number}`);
  const party = customer ? { partyType: "CUSTOMER", partyId: customer.code } : {};
  const who = customer?.name ?? input.customerName?.trim() ?? "walk-in customer";
  const lines = errors.length ? [] : [
    { accountId: debit!.id, debit: fromCentavos(total - cwt), description: `${ref} - ${who}`, ...party },
    ...(cwt > 0n ? [{ accountId: cwtAcct!.id, debit: fromCentavos(cwt), description: `${ref} - creditable withholding tax (BIR 2307)`, ...party }] : []),
    { accountId: revenue!.id, credit: fromCentavos(net), description: `${ref} - ${who}`, ...party },
    ...(vat > 0n ? [{ accountId: outVat!.id, credit: fromCentavos(vat), description: `${ref} - output VAT`, ...party }] : []),
  ];
  return { ok: !errors.length, errors, ref, customer, who, lines, totals: { total: fromCentavos(total), vat: fromCentavos(vat), net: fromCentavos(net), cwt: fromCentavos(cwt), receivable: fromCentavos(total - cwt) } };
}

/** Send the sales journal for approval (it appears under Journal Entries → Approvals). */
export async function postSalesScan(organizationId: string, userId: string, input: SalesScanInput, attachmentBase?: string | null) {
  const p = await previewSalesScan(organizationId, input);
  if (!p.ok) throw new LedgerError(p.errors);
  const entry = await prisma.$transaction((tx) => recordJournalTx(tx, {
    organizationId, userId, date: asDay(input.date), memo: `${input.terms === "CHARGE" ? "Charge" : "Cash"} sale ${p.ref} - ${p.who}${input.memo?.trim() ? `: ${input.memo.trim()}` : ""}`.slice(0, 500),
    reference: p.ref, source: "SALES", action: "submit", lines: p.lines,
    attachments: attachmentBase && input.imageId ? [{ name: `${p.ref} photo`, url: `${attachmentBase}/api/receipts/${input.imageId}` }] : [],
  }));
  return { journal: { id: entry.id, number: entry.number, status: entry.status }, totals: p.totals };
}
