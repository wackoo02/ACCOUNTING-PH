"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import type { Permission } from "@/lib/permissions";
import {
  approvePo, approvePurchaseRequest, awardRfq, cancelPurchaseRequest, cancelRfq, closePo, createRfq, deleteQuote, poFromRequest, recordGoodsReceipt,
  returnPo, returnPurchaseRequest, saveQuote, savePurchaseOrder, savePurchaseRequest, submitPurchaseOrder, submitPurchaseRequest, voidGoodsReceipt,
} from "@/lib/purchasing/service";
import { approveBill, returnBill, saveBill, scheduleBills, submitBill, voidBill } from "@/lib/ap/bills";
import { approvePayment, createPaymentRun, returnPayment, savePayment, submitPayment, voidPayment } from "@/lib/ap/payments";
import { addInboxDocument, extractInboxDocument, rejectInboxDocument, rotateInboxToken, saveInboxSettings } from "@/lib/ap/inbox";
import { deleteApprovalRule, saveApprovalRule } from "@/lib/approvals";
import { prisma } from "@/lib/db";

export type FormState = { errors?: string[]; message?: string } | undefined;

function fail(e: unknown): FormState {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const dt = (v: string | null | undefined) => (v ? new Date(v) : null);
type Payload = Record<string, unknown> & { intent?: string; lines?: Record<string, unknown>[] };
const payload = (fd: FormData) => JSON.parse(String(fd.get("payload") ?? "{}")) as Payload;
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const dims = (v: unknown) => Object.fromEntries(Object.entries((v as Record<string, string>) ?? {}).map(([k, x]) => [k, x || null]));

// ---------- Documents with lines ----------

export async function savePrAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const p = payload(fd);
    const ctx = await requireCtx("journal.create");
    const r = await savePurchaseRequest({
      organizationId: ctx.org.id, userId: ctx.user.id, date: new Date(str(p.date)), neededBy: dt(str(p.neededBy)), purpose: str(p.purpose),
      departmentId: str(p.departmentId) || null, costCenterId: str(p.costCenterId) || null, projectId: str(p.projectId) || null, branchId: str(p.branchId) || null,
      lines: (p.lines ?? []).map((l) => ({ productId: str(l.productId) || null, description: str(l.description), quantity: str(l.quantity), unit: str(l.unit), estUnitCost: str(l.unitPrice), category: str(l.category), accountId: str(l.accountId) || null })),
      action: p.intent === "submit" ? "submit" : "draft",
    }, str(p.id) || undefined);
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath("/purchasing/requests");
  redirect(`/purchasing/requests/${id}`);
}

export async function savePoAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const p = payload(fd);
    const ctx = await requireCtx("journal.create");
    const r = await savePurchaseOrder({
      organizationId: ctx.org.id, userId: ctx.user.id, vendorId: str(p.vendorId), poDate: new Date(str(p.date)), description: str(p.purpose),
      deliveryDate: dt(str(p.neededBy)), deliverTo: str(p.deliverTo), paymentTermsDays: p.terms === "" || p.terms === undefined ? null : Number(p.terms),
      currencyCode: str(p.currencyCode) || null, fxRate: str(p.fxRate), vatInclusive: !!p.vatInclusive, notes: str(p.notes),
      requestId: str(p.requestId) || null, rfqId: str(p.rfqId) || null,
      lines: (p.lines ?? []).map((l) => ({ productId: str(l.productId) || null, description: str(l.description), quantity: str(l.quantity), unit: str(l.unit), unitPrice: str(l.unitPrice), vatType: str(l.vatType), category: str(l.category), accountId: str(l.accountId), dims: dims(l.dims) })),
      action: p.intent === "submit" ? "submit" : "draft",
    }, str(p.id) || undefined);
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath("/purchasing/orders");
  redirect(`/purchasing/orders/${id}`);
}

export async function saveBillAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const p = payload(fd);
    const ctx = await requireCtx("journal.create");
    const r = await saveBill({
      organizationId: ctx.org.id, userId: ctx.user.id, vendorId: str(p.vendorId), supplierInvoiceNo: str(p.invoiceNo), invoiceDate: new Date(str(p.invoiceDate) || str(p.date)),
      date: dt(str(p.date)), dueDate: dt(str(p.dueDate)), purchaseOrderId: str(p.purchaseOrderId) || null, memo: str(p.purpose),
      currencyCode: str(p.currencyCode) || null, fxRate: str(p.fxRate), vatInclusive: !!p.vatInclusive, inboxDocumentId: str(p.inboxDocumentId) || null,
      lines: (p.lines ?? []).map((l) => ({
        description: str(l.description), category: str(l.category), accountId: str(l.accountId), quantity: str(l.quantity), unitPrice: str(l.unitPrice), vatType: str(l.vatType),
        ewtTaxCodeId: str(l.ewtTaxCodeId) || null, poLineId: str(l.poLineId) || null, dims: dims(l.dims), prepaidStart: dt(str(l.prepaidStart)), prepaidEnd: dt(str(l.prepaidEnd)),
      })),
      action: p.intent === "submit" ? "submit" : "draft",
    }, str(p.id) || undefined);
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath("/ap/bills");
  redirect(`/ap/bills/${id}`);
}

export async function savePaymentAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const p = payload(fd);
    const ctx = await requireCtx("journal.create");
    const r = await savePayment({
      organizationId: ctx.org.id, userId: ctx.user.id, vendorId: str(p.vendorId), bankAccountId: str(p.bankAccountId), date: new Date(str(p.date)), method: str(p.method),
      checkNo: str(p.checkNo), checkDate: dt(str(p.checkDate)), reference: str(p.reference), memo: str(p.memo), fxRate: str(p.fxRate),
      lines: (p.lines ?? []).map((l) => ({ billId: str(l.billId), amount: str(l.amount) })), action: p.intent === "submit" ? "submit" : "draft",
    }, str(p.id) || undefined);
    id = r.id;
  } catch (e) { return fail(e); }
  revalidatePath("/ap/payments");
  redirect(`/ap/payments/${id}`);
}

// ---------- Workflow buttons ----------

const PATHS: Record<string, string> = { PR: "/purchasing/requests", PO: "/purchasing/orders", BILL: "/ap/bills", PAYMENT: "/ap/payments", RR: "/purchasing/receipts", RFQ: "/purchasing/rfq" };

export async function apWorkflow(_: FormState, fd: FormData): Promise<FormState> {
  const doc = s(fd, "doc"), op = s(fd, "op"), id = s(fd, "id"), reason = s(fd, "reason"), comment = s(fd, "comment");
  const need: Permission = op === "void" || op === "cancel" || op === "close" ? "journal.void" : "journal.create";
  let msg = "";
  try {
    const c = await requireCtx(op === "approve" || op === "return" ? "reports.view" : need);
    const o = c.org.id, u = c.user.id;
    const k = `${doc}:${op}`;
    if (k === "PR:submit") { await submitPurchaseRequest(o, u, id); msg = "Submitted for approval."; }
    else if (k === "PR:approve") msg = (await approvePurchaseRequest(o, u, id, comment)) ? "Approved. You can now canvass suppliers or order directly." : "Approved at your level; it moves to the next approver.";
    else if (k === "PR:return") { await returnPurchaseRequest(o, u, id, reason); msg = "Returned to the requester."; }
    else if (k === "PR:cancel") { await cancelPurchaseRequest(o, u, id, reason); msg = "Cancelled."; }
    else if (k === "PO:submit") { await submitPurchaseOrder(o, u, id); msg = "Submitted for approval."; }
    else if (k === "PO:approve") msg = (await approvePo(o, u, id, comment)) ? "PO approved. Send it to the supplier; receive the items when they arrive." : "Approved at your level; it moves to the next approver.";
    else if (k === "PO:return") { await returnPo(o, u, id, reason); msg = "Returned to the preparer."; }
    else if (k === "PO:close" || k === "PO:cancel") { await closePo(o, u, id, reason, op === "cancel"); msg = op === "cancel" ? "PO cancelled." : "PO closed."; }
    else if (k === "BILL:submit") { await submitBill(o, u, id); msg = "Submitted for approval."; }
    else if (k === "BILL:approve") msg = (await approveBill(o, u, id, comment)) ? "Approved and posted to the AP ledger and the GL." : "Approved at your level; it moves to the next approver.";
    else if (k === "BILL:return") { await returnBill(o, u, id, reason); msg = "Returned to the preparer."; }
    else if (k === "BILL:void") { await voidBill(o, u, id, reason, dt(s(fd, "date")) ?? undefined); msg = "Voided. If it was posted, the GL entry was reversed."; }
    else if (k === "PAYMENT:submit") { await submitPayment(o, u, id); msg = "Submitted for approval."; }
    else if (k === "PAYMENT:approve") msg = (await approvePayment(o, u, id, comment)) ? "Approved and released: the disbursement is posted and the check is in check monitoring." : "Approved at your level; it moves to the next approver.";
    else if (k === "PAYMENT:return") { await returnPayment(o, u, id, reason); msg = "Returned to the preparer."; }
    else if (k === "PAYMENT:void") { await voidPayment(o, u, id, reason, dt(s(fd, "date")) ?? undefined); msg = "Voided. The disbursement was reversed and the bills are open again."; }
    else if (k === "RR:void") { await voidGoodsReceipt(o, u, id, reason); msg = "Receiving report voided and its GL entry reversed."; }
    else if (k === "RFQ:cancel") { await cancelRfq(o, u, id); msg = "RFQ cancelled."; }
    else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath(PATHS[doc] ?? "/ap/bills", "layout");
  revalidatePath("/ap/approvals");
  return { message: msg };
}

// ---------- Purchasing steps ----------

export async function prNextStep(_: FormState, fd: FormData): Promise<FormState> {
  let to: string;
  try {
    const c = await requireCtx("journal.create");
    if (s(fd, "op") === "rfq") to = `/purchasing/rfq/${(await createRfq(c.org.id, c.user.id, { requestId: s(fd, "id"), date: new Date(), dueDate: dt(s(fd, "dueDate")), notes: s(fd, "notes") })).id}`;
    else to = `/purchasing/orders/${(await poFromRequest(c.org.id, c.user.id, s(fd, "id"), s(fd, "vendorId"))).id}`;
  } catch (e) { return fail(e); }
  redirect(to);
}

export async function quoteAction(_: FormState, fd: FormData): Promise<FormState> {
  const rfqId = s(fd, "rfqId");
  try {
    const c = await requireCtx("journal.create");
    if (s(fd, "op") === "delete") await deleteQuote(c.org.id, rfqId, s(fd, "quoteId"));
    else {
      const prices = [...fd.keys()].filter((k) => k.startsWith("price_")).map((k) => ({ lineNo: Number(k.slice(6)), unitPrice: s(fd, k) }));
      await saveQuote(c.org.id, c.user.id, rfqId, {
        vendorId: s(fd, "vendorId"), quoteRef: s(fd, "quoteRef"), quoteDate: dt(s(fd, "quoteDate")), validUntil: dt(s(fd, "validUntil")),
        leadTimeDays: s(fd, "leadTimeDays") ? Number(s(fd, "leadTimeDays")) : null, paymentTermsDays: s(fd, "paymentTermsDays") ? Number(s(fd, "paymentTermsDays")) : null,
        vatInclusive: fd.get("vatInclusive") === "on", prices, remarks: s(fd, "remarks"),
      });
    }
  } catch (e) { return fail(e); }
  revalidatePath(`/purchasing/rfq/${rfqId}`);
  return { message: "Saved." };
}

export async function awardAction(_: FormState, fd: FormData): Promise<FormState> {
  let to: string;
  try {
    const c = await requireCtx("journal.create");
    to = `/purchasing/orders/${(await awardRfq(c.org.id, c.user.id, s(fd, "rfqId"), s(fd, "quoteId"), s(fd, "reason"))).id}`;
  } catch (e) { return fail(e); }
  redirect(to);
}

export async function receiveAction(_: FormState, fd: FormData): Promise<FormState> {
  const poId = s(fd, "purchaseOrderId");
  try {
    const c = await requireCtx("journal.create");
    const lines = [...fd.keys()].filter((k) => k.startsWith("qty_")).map((k) => ({ poLineId: k.slice(4), quantity: s(fd, k), remarks: s(fd, `rem_${k.slice(4)}`), lotNo: s(fd, `lot_${k.slice(4)}`) || null }));
    await recordGoodsReceipt(c.org.id, c.user.id, { purchaseOrderId: poId, date: new Date(s(fd, "date")), deliveryRef: s(fd, "deliveryRef"), notes: s(fd, "notes"), warehouseId: s(fd, "warehouseId") || null, lines });
  } catch (e) { return fail(e); }
  revalidatePath(`/purchasing/orders/${poId}`);
  return { message: "Receiving report posted: the items are in the books as received, not yet invoiced." };
}

// ---------- Payment schedule ----------

export async function scheduleAction(_: FormState, fd: FormData): Promise<FormState> {
  const ids = fd.getAll("bill").map(String);
  let to: string | null = null;
  try {
    const c = await requireCtx("journal.create");
    if (!ids.length) return { errors: ["Tick the bills first"] };
    const op = s(fd, "op");
    if (op === "schedule") await scheduleBills(c.org.id, c.user.id, ids, { scheduledPayDate: dt(s(fd, "payDate")) });
    else if (op === "hold" || op === "release") await scheduleBills(c.org.id, c.user.id, ids, { onHold: op === "hold" });
    else if (op === "run") {
      const r = await createPaymentRun(c.org.id, c.user.id, { bankAccountId: s(fd, "bankAccountId"), date: new Date(s(fd, "payDate") || new Date().toISOString().slice(0, 10)), method: s(fd, "method"), fxRate: s(fd, "fxRate"), billIds: ids, submit: fd.get("submit") === "on" });
      to = r.length === 1 ? `/ap/payments/${r[0].id}` : "/ap/payments?status=" + (fd.get("submit") === "on" ? "PENDING_APPROVAL" : "DRAFT");
    }
  } catch (e) { return fail(e); }
  revalidatePath("/ap/schedule");
  if (to) redirect(to);
  return { message: "Updated." };
}

// ---------- AP inbox ----------

export async function inboxUpload(_: FormState, fd: FormData): Promise<FormState> {
  let n = 0;
  try {
    const c = await requireCtx("journal.create");
    const files = fd.getAll("files").filter((f): f is File => typeof f === "object" && "arrayBuffer" in f && f.size > 0);
    if (!files.length) return { errors: ["Choose one or more PDF, JPG or PNG files"] };
    const ids: string[] = [];
    for (const f of files) {
      const d = await addInboxDocument(c.org.id, { source: "UPLOAD", fileName: f.name, mediaType: f.type, data: Buffer.from(await f.arrayBuffer()), uploadedById: c.user.id });
      if (d) ids.push(d.id);
    }
    n = ids.length;
    const org = c.org.id;
    after(async () => { for (const id of ids) await extractInboxDocument(org, id); });
  } catch (e) { return fail(e); }
  revalidatePath("/ap/inbox");
  return { message: `${n} file(s) added. Reading them now; refresh in a moment.` };
}

export async function inboxAction(_: FormState, fd: FormData): Promise<FormState> {
  const id = s(fd, "id");
  try {
    const c = await requireCtx("journal.create");
    if (s(fd, "op") === "reject") await rejectInboxDocument(c.org.id, c.user.id, id, s(fd, "reason"));
    else await extractInboxDocument(c.org.id, id);
  } catch (e) { return fail(e); }
  revalidatePath("/ap/inbox", "layout");
  return { message: s(fd, "op") === "reject" ? "Rejected." : "Read again." };
}

export async function inboxSettings(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("org.manage");
    if (s(fd, "op") === "rotate") await rotateInboxToken(c.org.id, c.user.id);
    else if (s(fd, "op") === "token-off") await prisma.organization.update({ where: { id: c.org.id }, data: { apInboxToken: null } });
    else await saveInboxSettings(c.org.id, c.user.id, { alias: s(fd, "alias"), address: s(fd, "address"), senders: s(fd, "senders"), enabled: fd.get("enabled") === "on" });
  } catch (e) { return fail(e); }
  revalidatePath("/ap/inbox/setup");
  return { message: "Saved." };
}

// ---------- Approval matrix ----------

export async function approvalRuleAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("org.manage");
    if (s(fd, "op") === "delete") await deleteApprovalRule(c.org.id, s(fd, "id"));
    else {
      const who = s(fd, "who");
      await saveApprovalRule(c.org.id, { docType: s(fd, "docType"), level: Number(s(fd, "level")), name: s(fd, "name"), minAmount: s(fd, "minAmount"), approverRole: who.startsWith("ROLE:") ? who.slice(5) : null, approverUserId: who.startsWith("USER:") ? who.slice(5) : null });
    }
  } catch (e) { return fail(e); }
  revalidatePath("/settings/approvals");
  return { message: "Saved." };
}
