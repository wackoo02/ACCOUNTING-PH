"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import {
  applyCredit, approveInvoice, approveReceipt, rejectInvoice, rejectReceipt, saveInvoice, saveReceipt, saveSeries, submitInvoice, submitReceipt,
  voidInvoice, voidReceipt, type SeriesType,
} from "@/lib/ar/service";
import { billMilestone, runBilling, saveContract, type ContractKind } from "@/lib/ar/billing";
import { emailDocument, type EmailDoc } from "@/lib/ar/email";
import { parseEmails, type VatType } from "@/lib/ar/compute";

export type FormState = { errors?: string[]; message?: string } | undefined;

function fail(e: unknown): FormState {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date");
const optDay = z.string().optional().transform((s) => (s ? new Date(s) : null));
const dims = z.record(z.string(), z.string().nullable()).optional().transform((d) => Object.fromEntries(Object.entries(d ?? {}).map(([k, v]) => [k, v || null])));
const Line = z.object({
  productId: z.string().optional(), description: z.string(), quantity: z.string(), unit: z.string().optional(), unitPrice: z.string(),
  discount: z.string().optional(), vatType: z.enum(["VATABLE", "ZERO_RATED", "EXEMPT"]), accountId: z.string().optional(), dims, lotNo: z.string().optional(),
});
const InvoiceSchema = z.object({
  id: z.string().optional(), kind: z.enum(["INVOICE", "CREDIT_MEMO"]), customerId: z.string(), date: day, termsDays: z.string().optional(), dueDate: z.string().optional(),
  fxRate: z.string().optional(), pricesIncludeVat: z.boolean(), reference: z.string().optional(), memo: z.string().optional(), ewtTaxCodeId: z.string().optional(),
  creditForId: z.string().optional(), reason: z.string().optional(), lines: z.array(Line), intent: z.enum(["draft", "submit", "post"]),
  warehouseId: z.string().optional(),
});

export async function saveInvoiceAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const p = InvoiceSchema.safeParse(JSON.parse(String(fd.get("payload") ?? "{}")));
    if (!p.success) return { errors: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    const v = p.data;
    const ctx = await requireCtx(v.intent === "post" ? "journal.post" : "journal.create");
    const inv = await saveInvoice({
      organizationId: ctx.org.id, userId: ctx.user.id, kind: v.kind, customerId: v.customerId, date: new Date(v.date),
      termsDays: v.termsDays?.trim() ? Number(v.termsDays) : null, dueDate: v.dueDate ? new Date(v.dueDate) : null, fxRate: v.fxRate,
      pricesIncludeVat: v.pricesIncludeVat, reference: v.reference, memo: v.memo, ewtTaxCodeId: v.ewtTaxCodeId || null,
      creditForId: v.creditForId || null, reason: v.reason, action: v.intent, warehouseId: v.warehouseId || null,
      lines: v.lines.map((l) => ({ ...l, productId: l.productId || null, accountId: l.accountId || null, vatType: l.vatType as VatType })),
    }, v.id);
    id = inv.id;
  } catch (e) { return fail(e); }
  revalidatePath("/receivables");
  redirect(`/receivables/${id}`);
}

export async function invoiceWorkflow(_: FormState, fd: FormData): Promise<FormState> {
  const id = String(fd.get("id"));
  const op = String(fd.get("op"));
  let msg = "";
  try {
    if (op === "submit") { const c = await requireCtx("journal.create"); await submitInvoice(c.org.id, c.user.id, id); msg = "Submitted for approval."; }
    else if (op === "approve") { const c = await requireCtx("journal.post"); await approveInvoice(c.org.id, c.user.id, id); msg = "Approved and issued. The serial number is assigned and the GL entry is posted."; }
    else if (op === "reject") { const c = await requireCtx("journal.post"); await rejectInvoice(c.org.id, c.user.id, id, String(fd.get("reason") ?? "")); msg = "Returned to the preparer."; }
    else if (op === "void") {
      const c = await requireCtx("journal.void");
      const dt = String(fd.get("date") ?? "");
      await voidInvoice(c.org.id, c.user.id, id, String(fd.get("reason") ?? ""), dt ? new Date(dt) : undefined);
      msg = "Voided. The serial stays in the series as cancelled, and the GL entry was reversed.";
    } else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath(`/receivables/${id}`);
  revalidatePath("/receivables");
  return { message: msg };
}

const ReceiptSchema = z.object({
  id: z.string().optional(), customerId: z.string(), date: day, bankAccountId: z.string(), method: z.string(), checkNo: z.string().optional(), checkDate: z.string().optional(),
  checkBank: z.string().optional(), reference: z.string().optional(), memo: z.string().optional(), fxRate: z.string().optional(), cashAmount: z.string(),
  withholdingTaxCodeId: z.string().optional(), withholdingAmount: z.string().optional(), applications: z.array(z.object({ invoiceId: z.string(), amount: z.string() })),
  intent: z.enum(["draft", "submit", "post"]),
});

export async function saveReceiptAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const p = ReceiptSchema.safeParse(JSON.parse(String(fd.get("payload") ?? "{}")));
    if (!p.success) return { errors: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    const v = p.data;
    const ctx = await requireCtx(v.intent === "post" ? "journal.post" : "journal.create");
    const r = await saveReceipt({
      organizationId: ctx.org.id, userId: ctx.user.id, customerId: v.customerId, date: new Date(v.date), bankAccountId: v.bankAccountId, method: v.method,
      checkNo: v.checkNo, checkDate: v.checkDate ? new Date(v.checkDate) : null, checkBank: v.checkBank, reference: v.reference, memo: v.memo, fxRate: v.fxRate,
      cashAmount: v.cashAmount || "0", withholdingTaxCodeId: v.withholdingTaxCodeId || null, withholdingAmount: v.withholdingAmount,
      applications: v.applications.filter((a) => a.amount.trim()), action: v.intent,
    }, v.id);
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath("/receivables/collections");
  redirect(`/receivables/collections/${id}`);
}

export async function receiptWorkflow(_: FormState, fd: FormData): Promise<FormState> {
  const id = String(fd.get("id"));
  const op = String(fd.get("op"));
  let msg = "";
  try {
    if (op === "submit") { const c = await requireCtx("journal.create"); await submitReceipt(c.org.id, c.user.id, id); msg = "Submitted for approval."; }
    else if (op === "approve") { const c = await requireCtx("journal.post"); await approveReceipt(c.org.id, c.user.id, id); msg = "Approved and posted. The invoices are updated."; }
    else if (op === "reject") { const c = await requireCtx("journal.post"); await rejectReceipt(c.org.id, c.user.id, id, String(fd.get("reason") ?? "")); msg = "Returned to the preparer."; }
    else if (op === "void") {
      const c = await requireCtx("journal.void");
      const dt = String(fd.get("date") ?? "");
      await voidReceipt(c.org.id, c.user.id, id, String(fd.get("reason") ?? ""), dt ? new Date(dt) : undefined);
      msg = "Voided. The invoices it paid are open again and the GL entry was reversed.";
    } else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath(`/receivables/collections/${id}`);
  revalidatePath("/receivables/collections");
  return { message: msg };
}

/** Apply an unapplied payment or credit memo. Fields: source (RECEIPT:id | CREDIT_MEMO:id), date, amt_<invoiceId>. */
export async function applyCreditAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.post");
    const [type, id] = String(fd.get("source")).split(":");
    const allocs = [...fd.entries()].filter(([k, v]) => k.startsWith("amt_") && String(v).trim()).map(([k, v]) => ({ invoiceId: k.slice(4), amount: String(v) }));
    await applyCredit(c.org.id, c.user.id, type === "RECEIPT" ? { receiptId: id } : { creditMemoId: id }, allocs, new Date(String(fd.get("date"))));
    revalidatePath(type === "RECEIPT" ? `/receivables/collections/${id}` : `/receivables/${id}`);
    return { message: "Applied to the invoices." };
  } catch (e) { return fail(e); }
}

export async function emailAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.create");
    const doc: EmailDoc = {
      docType: String(fd.get("docType")) as EmailDoc["docType"], id: String(fd.get("id")),
      from: fd.get("from") ? new Date(String(fd.get("from"))) : undefined, to: fd.get("to") ? new Date(String(fd.get("to"))) : undefined,
    };
    const r = await emailDocument(c.org.id, c.user.id, doc, parseEmails(String(fd.get("recipients") ?? "")), String(fd.get("note") ?? ""));
    return { message: `Sent to ${r.to.join(", ")}.` };
  } catch (e) { return fail(e); }
}

export async function saveSeriesAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("masters.manage");
    const s = (k: string) => String(fd.get(k) ?? "").trim();
    const n = (k: string) => (s(k) ? Number(s(k)) : null);
    const dt = (k: string) => (s(k) ? new Date(s(k)) : null);
    await saveSeries(c.org.id, c.user.id, {
      docType: s("docType") as SeriesType, name: s("name"), prefix: s("prefix"), startNo: n("startNo") ?? 1, endNo: n("endNo"), nextNo: n("nextNo"), padding: n("padding"),
      branchCode: s("branchCode"), authorityType: s("authorityType"), authorityNo: s("authorityNo"), authorityDate: dt("authorityDate"), validUntil: dt("validUntil"),
      printerName: s("printerName"), printerTin: s("printerTin"), printerAddress: s("printerAddress"), printerAccreditationNo: s("printerAccreditationNo"),
      printerAccreditationDate: dt("printerAccreditationDate"), isDefault: fd.get("isDefault") === "on", isActive: fd.get("isActive") !== "off",
    }, s("id") || undefined);
  } catch (e) { return fail(e); }
  revalidatePath("/receivables/series");
  return { message: "Saved." };
}

const ContractSchema = z.object({
  id: z.string().optional(), kind: z.enum(["SUBSCRIPTION", "CONTRACT", "PROJECT"]), name: z.string(), customerId: z.string(), startDate: day, endDate: optDay,
  frequency: z.string().optional(), nextBillDate: optDay, termsDays: z.string().optional(), contractValue: z.string().optional(), pricesIncludeVat: z.boolean(),
  ewtTaxCodeId: z.string().optional(), lines: z.array(Line), autoSubmit: z.boolean(), status: z.string().optional(), memo: z.string().optional(),
  milestones: z.array(z.object({ id: z.string().optional(), description: z.string(), percent: z.string().optional(), amount: z.string().optional(), dueDate: optDay, vatType: z.enum(["VATABLE", "ZERO_RATED", "EXEMPT"]).optional() })),
});

export async function saveContractAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const p = ContractSchema.safeParse(JSON.parse(String(fd.get("payload") ?? "{}")));
    if (!p.success) return { errors: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    const v = p.data;
    const ctx = await requireCtx("journal.create");
    const c = await saveContract({
      ...v, organizationId: ctx.org.id, userId: ctx.user.id, kind: v.kind as ContractKind, startDate: new Date(v.startDate), termsDays: v.termsDays?.trim() ? Number(v.termsDays) : null,
      ewtTaxCodeId: v.ewtTaxCodeId || null, lines: v.lines.map((l) => ({ ...l, productId: l.productId || null, accountId: l.accountId || null })),
    }, v.id);
    id = c.id;
  } catch (e) { return fail(e); }
  revalidatePath("/receivables/billing");
  redirect(`/receivables/billing/${id}`);
}

export async function runBillingAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.create");
    const r = await runBilling(c.org.id, c.user.id, new Date(String(fd.get("asOf"))), String(fd.get("contractId") ?? "") || undefined);
    revalidatePath("/receivables/billing");
    revalidatePath("/receivables");
    if (r.errors.length) return { errors: [`Created ${r.created.length} invoice(s). Some contracts could not be billed:`, ...r.errors] };
    return { message: r.created.length ? `Created ${r.created.length} invoice(s). Review and approve them under Sales Invoices.` : "Nothing is due for billing." };
  } catch (e) { return fail(e); }
}

export async function billMilestoneAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const c = await requireCtx("journal.create");
    const inv = await billMilestone(c.org.id, c.user.id, String(fd.get("milestoneId")), new Date(String(fd.get("date"))));
    id = inv.id;
  } catch (e) { return fail(e); }
  redirect(`/receivables/${id}`);
}
