"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import { DIM_KEYS } from "@/lib/ledger/dimensions";
import { commenceLease, deleteLease, modifyLease, postLeasePeriods, saveLease, terminateLease, undoLastLeaseEvent, type LeaseInput } from "@/lib/leases/service";

export type FormState = { errors?: string[]; message?: string } | undefined;

function fail(e: unknown): FormState {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}
const s = (fd: FormData, k: string) => { const v = fd.get(k); return v === null ? null : String(v).trim(); };

export async function saveLeaseAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const ctx = await requireCtx("journal.create");
    const fields = ["number", "lessorName", "lessorVendorCode", "leaseType", "assetDescription", "location", "commencementDate", "endDate", "paymentAmount", "paymentFrequency", "paymentTiming",
      "escalationPct", "escalationEveryMonths", "incrementalBorrowingRate", "discountRate", "currencyCode", "fxRate", "exemption", "usefulLifeMonths", "initialDirectCosts",
      "prepaidLeasePayments", "leaseIncentives", "restorationCost", "ewtTaxCodeId", "rouAccountId", "accumDepAccountId", "liabilityAccountId", "currentLiabilityAccountId",
      "interestAccountId", "depreciationAccountId", "rentExpenseAccountId", "paymentAccountId", "gainLossAccountId", "initialCostsAccountId", "restorationAccountId",
      "takeUpDate", "takeUpOffsetAccountId", "notes"] as const;
    const input = Object.fromEntries(fields.map((k) => [k, s(fd, k)])) as unknown as LeaseInput;
    const l = await saveLease({
      ...input, organizationId: ctx.org.id, userId: ctx.user.id,
      transfersOwnership: fd.get("transfersOwnership") === "on", vatable: fd.get("vatable") === "on",
      dims: Object.fromEntries(DIM_KEYS.map((k) => [k, s(fd, `dim_${k}`) || null])),
    }, s(fd, "id") || undefined);
    id = l.id;
  } catch (e) { return fail(e); }
  revalidatePath("/leases");
  redirect(`/leases/${id}`);
}

export async function leaseWorkflow(_: FormState, fd: FormData): Promise<FormState> {
  const id = String(fd.get("id"));
  const op = String(fd.get("op"));
  let msg = "";
  try {
    if (op === "commence") { const c = await requireCtx("journal.post"); await commenceLease(c.org.id, c.user.id, id); msg = "Approved. The lease is active and its opening entry is posted."; }
    else if (op === "undo") { const c = await requireCtx("journal.void"); const ev = await undoLastLeaseEvent(c.org.id, c.user.id, id); msg = `Undone (${ev.type.toLowerCase().replace("_", " ")}). Its GL entry was reversed.`; }
    else if (op === "post") {
      const c = await requireCtx("journal.post");
      const r = await postLeasePeriods(c.org.id, c.user.id, new Date(String(fd.get("through"))), id);
      if (r.errors.length) return { errors: r.errors };
      msg = r.posted ? `Posted ${r.posted} month(s).` : "Nothing to post up to that date.";
    } else if (op === "delete") {
      const c = await requireCtx("journal.create"); await deleteLease(c.org.id, c.user.id, id);
      revalidatePath("/leases"); redirect("/leases");
    } else if (op === "modify") {
      const c = await requireCtx("journal.post");
      await modifyLease(c.org.id, c.user.id, id, {
        effectiveDate: String(fd.get("effectiveDate")), newEndDate: String(fd.get("newEndDate")), newPaymentAmount: String(fd.get("newPaymentAmount")),
        newEscalationPct: s(fd, "newEscalationPct"), newDiscountRate: s(fd, "newDiscountRate"), scopeReductionPct: s(fd, "scopeReductionPct"), memo: String(fd.get("memo") ?? ""),
      });
      msg = "Modification posted. The schedule from the effective date was recalculated.";
    } else if (op === "terminate") {
      const c = await requireCtx("journal.post");
      await terminateLease(c.org.id, c.user.id, id, { date: String(fd.get("date")), penalty: s(fd, "penalty"), reason: String(fd.get("reason") ?? "") });
      msg = "Lease terminated. The ROU asset and lease liability were taken off the books.";
    } else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath(`/leases/${id}`);
  revalidatePath("/leases");
  return { message: msg };
}

export async function postLeasesAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.post");
    const through = String(fd.get("through") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(through)) return { errors: ["Enter the date to post through (usually the month-end)"] };
    const r = await postLeasePeriods(c.org.id, c.user.id, new Date(through));
    revalidatePath("/leases");
    revalidatePath("/leases/post");
    if (r.errors.length) return { errors: [`Posted ${r.posted} month(s). These leases could not be posted:`, ...r.errors] };
    return { message: r.posted ? `Posted ${r.posted} lease month(s) through ${through}.` : `Nothing left to post through ${through}.` };
  } catch (e) { return fail(e); }
}
