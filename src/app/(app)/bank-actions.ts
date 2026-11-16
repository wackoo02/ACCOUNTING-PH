"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import { approveCash, rejectCash, releaseCheck, replenishPettyCash, saveCashTransaction, submitCash, voidCash } from "@/lib/bank/cash";
import {
  clearWithoutStatement, confirmMatches, deleteStatement, finalizeStatement, importStatement, postAdjustments, reopenStatement, unmatch,
} from "@/lib/bank/recon";

export type FormState = { errors?: string[]; message?: string } | undefined;

function fail(e: unknown): FormState {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date");
const CashSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["RECEIPT", "DISBURSEMENT", "TRANSFER"]),
  bankAccountId: z.string(),
  toBankAccountId: z.string().optional(),
  date: day,
  payee: z.string().optional(),
  party: z.string().optional(), // "VENDOR:V-0001"
  method: z.string().optional(),
  checkNo: z.string().optional(),
  checkDate: z.string().optional(),
  reference: z.string().optional(),
  memo: z.string(),
  fxRate: z.string().optional(),
  amount: z.string().optional(),
  toAmount: z.string().optional(),
  toFxRate: z.string().optional(),
  withholdingTaxCodeId: z.string().optional(),
  withholdingAmount: z.string().optional(),
  lines: z.array(z.object({ accountId: z.string(), amount: z.string(), description: z.string().optional(), dims: z.record(z.string(), z.string().nullable()).optional() })).optional(),
  intent: z.enum(["draft", "submit", "post"]),
});

export async function saveCash(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const p = CashSchema.safeParse(JSON.parse(String(fd.get("payload") ?? "{}")));
    if (!p.success) return { errors: p.error.issues.map((i) => i.message) };
    const v = p.data;
    const ctx = await requireCtx(v.intent === "post" ? "journal.post" : "journal.create");
    const [partyType, partyId] = v.party ? v.party.split(":") : [null, null];
    const t = await saveCashTransaction({
      organizationId: ctx.org.id, userId: ctx.user.id, type: v.type, bankAccountId: v.bankAccountId, toBankAccountId: v.toBankAccountId || null,
      date: new Date(v.date), payee: v.payee, partyType, partyId, method: v.method, checkNo: v.checkNo, checkDate: v.checkDate ? new Date(v.checkDate) : null,
      reference: v.reference, memo: v.memo, fxRate: v.fxRate, amount: v.amount, toAmount: v.toAmount, toFxRate: v.toFxRate,
      withholdingTaxCodeId: v.withholdingTaxCodeId || null, withholdingAmount: v.withholdingAmount,
      lines: v.lines?.map((l) => ({ ...l, dims: Object.fromEntries(Object.entries(l.dims ?? {}).map(([k, x]) => [k, x || null])) })), action: v.intent,
    }, v.id);
    id = t.id;
  } catch (e) { return fail(e); }
  revalidatePath("/cash");
  redirect(`/cash/${id}`);
}

export async function cashWorkflow(_: FormState, fd: FormData): Promise<FormState> {
  const id = String(fd.get("id"));
  const op = String(fd.get("op"));
  let msg = "";
  try {
    if (op === "submit") { const c = await requireCtx("journal.create"); await submitCash(c.org.id, c.user.id, id); msg = "Submitted for approval."; }
    else if (op === "approve") { const c = await requireCtx("journal.post"); await approveCash(c.org.id, c.user.id, id); msg = "Approved and posted to the general ledger."; }
    else if (op === "reject") { const c = await requireCtx("journal.post"); await rejectCash(c.org.id, c.user.id, id, String(fd.get("reason") ?? "")); msg = "Returned to the preparer."; }
    else if (op === "void") {
      const c = await requireCtx("journal.void");
      const dt = String(fd.get("date") ?? "");
      await voidCash(c.org.id, c.user.id, id, String(fd.get("reason") ?? ""), dt ? new Date(dt) : undefined);
      msg = "Voided. If it was posted, the GL entry was reversed.";
    } else if (op === "release" || op === "unrelease") {
      const c = await requireCtx("journal.create");
      await releaseCheck(c.org.id, c.user.id, id, op === "release" ? new Date(String(fd.get("date"))) : null);
      msg = op === "release" ? "Check marked as released to the payee." : "Check marked as not yet released.";
    } else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath(`/cash/${id}`);
  revalidatePath("/cash/checks");
  return { message: msg };
}

export async function replenishAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const c = await requireCtx("journal.create");
    const t = await replenishPettyCash({
      organizationId: c.org.id, userId: c.user.id, fundId: String(fd.get("fundId")), fromBankAccountId: String(fd.get("fromBankAccountId")),
      date: new Date(String(fd.get("date"))), method: String(fd.get("method") || "CHECK"), checkNo: String(fd.get("checkNo") ?? "") || null, action: "submit",
    });
    id = t.id;
  } catch (e) { return fail(e); }
  revalidatePath("/cash/petty");
  redirect(`/cash/${id}`);
}

// ---------- Bank reconciliation ----------

export async function uploadStatement(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.create");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { errors: ["Choose the statement file (.xlsx)"] };
    if (file.size > 5 * 1024 * 1024) return { errors: ["The file is larger than 5 MB"] };
    const r = await importStatement({
      organizationId: c.org.id, userId: c.user.id, bankAccountId: String(fd.get("bankAccountId")), buf: await file.arrayBuffer(), fileName: file.name,
      openingBalance: String(fd.get("openingBalance") ?? ""), closingBalance: String(fd.get("closingBalance") ?? ""),
    });
    revalidatePath("/bank");
    return { message: `Uploaded ${r.imported} line(s)${r.skipped ? `, skipped ${r.skipped} already uploaded` : ""}. Open Match and clear to review the suggested matches.` };
  } catch (e) { return fail(e); }
}

export async function removeStatement(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.post");
    await deleteStatement(c.org.id, c.user.id, String(fd.get("id")));
  } catch (e) { return fail(e); }
  revalidatePath("/bank/statements");
  return { message: "Statement deleted." };
}

/** Clear the ticked suggestions. Each checkbox value is "bankId,bankId|bookId,bookId". */
export async function acceptSuggestions(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.create");
    const groups = fd.getAll("s").map(String).map((v) => { const [b, k] = v.split("|"); return { bankIds: b.split(","), bookIds: k.split(",") }; });
    if (!groups.length) return { errors: ["Tick the suggestions you want to clear"] };
    const n = await confirmMatches(c.org.id, c.user.id, String(fd.get("bankAccountId")), groups, "SUGGESTED");
    revalidatePath("/bank/reconcile");
    return { message: `Cleared ${n} match(es).` };
  } catch (e) { return fail(e); }
}

export async function manualMatch(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.create");
    const bankAccountId = String(fd.get("bankAccountId"));
    const bankIds = fd.getAll("bank").map(String), bookIds = fd.getAll("book").map(String);
    const op = String(fd.get("op"));
    if (op === "adjust") return bookAdjustments(_, fd);
    if (op === "nostatement") {
      if (bankIds.length) return { errors: ["Untick the bank lines: this option clears book lines only"] };
      const pc = await requireCtx("journal.post");
      await clearWithoutStatement(pc.org.id, pc.user.id, bankAccountId, bookIds, String(fd.get("note") ?? ""));
      revalidatePath("/bank/reconcile");
      return { message: `Cleared ${bookIds.length} book line(s) without a statement line.` };
    }
    await confirmMatches(c.org.id, c.user.id, bankAccountId, [{ bankIds, bookIds }], "MANUAL");
    revalidatePath("/bank/reconcile");
    return { message: "Matched and cleared." };
  } catch (e) { return fail(e); }
}

export async function bookAdjustments(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.post");
    const ids = fd.getAll("adj").map(String);
    if (!ids.length) return { errors: ["Tick the bank lines to record in the books"] };
    const override = String(fd.get("accountId") ?? "");
    const items = ids.map((id) => ({ bankLineId: id, accountId: override || String(fd.get(`acct_${id}`) ?? "") }));
    const es = await postAdjustments(c.org.id, c.user.id, String(fd.get("bankAccountId")), items);
    revalidatePath("/bank/reconcile");
    return { message: `Posted ${es.map((e) => e.number).join(", ")} and cleared them against the statement.` };
  } catch (e) { return fail(e); }
}

export async function undoMatch(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.create");
    const m = String(fd.get("id"));
    if (fd.get("method") === "ADJUSTMENT" || fd.get("method") === "NO_STATEMENT") {
      const pc = await requireCtx("journal.post");
      await unmatch(pc.org.id, pc.user.id, m);
    } else await unmatch(c.org.id, c.user.id, m);
  } catch (e) { return fail(e); }
  revalidatePath("/bank/reconcile");
  return { message: "Match undone." };
}

export async function finalizeRecon(_: FormState, fd: FormData): Promise<FormState> {
  const id = String(fd.get("id"));
  try {
    if (fd.get("op") === "reopen") {
      const c = await requireCtx("org.manage");
      await reopenStatement(c.org.id, c.user.id, id);
    } else {
      const c = await requireCtx("journal.post");
      await finalizeStatement(c.org.id, c.user.id, id);
    }
  } catch (e) { return fail(e); }
  revalidatePath(`/bank/reconcile/${id}`);
  return { message: fd.get("op") === "reopen" ? "Reopened. Matches can be changed again." : "Reconciliation finalized and locked." };
}
