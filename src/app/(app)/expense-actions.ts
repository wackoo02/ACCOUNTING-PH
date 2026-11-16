"use server";
// Server actions for the Expense & Mobility and Asset Audit pages of the web ERP.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import { approveVoucher, financeClear, holdVoucher, payReimbursement, rejectVoucher, returnVoucher } from "@/lib/pettycash/service";
import { autoReconcile, claimFromStatementLine, saveMapping } from "@/lib/expense/service";
import { closeAudit, startAudit } from "@/lib/assets/audit";
import type { ModuleKey } from "@/lib/expense/catalog";

type State = { errors?: string[]; message?: string } | undefined;
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function fail(e: unknown): State {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}

/** Manager / finance decision on a claim: approve, return, reject, clear or hold. */
export async function claimDecisionAction(_: State, fd: FormData): Promise<State> {
  const ctx = await requireCtx();
  const id = s(fd, "id"), op = s(fd, "op"), note = s(fd, "note");
  try {
    if (op === "approve") await approveVoucher(ctx.org.id, ctx.user.id, id);
    else if (op === "return") { if (!note) return { errors: ["Say what the employee needs to fix"] }; await returnVoucher(ctx.org.id, ctx.user.id, id, note); }
    else if (op === "reject") { if (!note) return { errors: ["Give the reason for rejecting"] }; await rejectVoucher(ctx.org.id, ctx.user.id, id, note); }
    else if (op === "hold") { if (!note) return { errors: ["Say why the claim is on hold"] }; await holdVoucher(ctx.org.id, ctx.user.id, id, note); }
    else if (op === "clear") await financeClear(ctx.org.id, ctx.user.id, id, { note: note || null, overrideDuplicates: fd.get("override") === "on" });
    else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath("/expenses", "layout");
  return { message: { approve: "Approved. Sent to finance review.", return: "Returned to the employee.", reject: "Rejected.", hold: "Put on hold.", clear: "Cleared and posted to the ledger." }[op] };
}

export async function payReimbursementAction(_: State, fd: FormData): Promise<State> {
  const ctx = await requireCtx("expense.finance");
  try {
    await payReimbursement(ctx.org.id, ctx.user.id, {
      employeeId: s(fd, "employeeId"), bankAccountId: s(fd, "bankAccountId"), date: s(fd, "date") || null, method: s(fd, "method") || null, checkNo: s(fd, "checkNo") || null,
      voucherIds: fd.getAll("voucherId").map(String).filter(Boolean),
    });
  } catch (e) { return fail(e); }
  revalidatePath("/expenses/reimbursements");
  return { message: "Disbursement voucher created. Approve it in Cash and Bank → Voucher Approvals; the claims show as reimbursed once it is posted." };
}

export async function autoReconcileAction(_: State, fd: FormData): Promise<State> {
  const ctx = await requireCtx("expense.finance");
  let n = 0;
  try { n = await autoReconcile(ctx.org.id, ctx.user.id, s(fd, "bankAccountId")); } catch (e) { return fail(e); }
  revalidatePath("/expenses/reconcile");
  return { message: n ? `Matched ${n} claim${n === 1 ? "" : "s"} to the statement.` : "No clear matches found. Match the rest in Bank Reconciliation." };
}

export async function exceptionToClaimAction(_: State, fd: FormData): Promise<State> {
  const ctx = await requireCtx("expense.finance");
  try {
    const r = await claimFromStatementLine(ctx.org.id, ctx.user.id, { statementLineId: s(fd, "statementLineId"), employeeId: s(fd, "employeeId"), module: s(fd, "module") as ModuleKey, note: s(fd, "note") || null });
    revalidatePath("/expenses/reconcile");
    return { message: `Claim ${r.number} sent to the employee to complete.` };
  } catch (e) { return fail(e); }
}

export async function saveMappingAction(_: State, fd: FormData): Promise<State> {
  const ctx = await requireCtx("masters.manage");
  try { await saveMapping(ctx.org.id, ctx.user.id, s(fd, "transactionType"), s(fd, "accountId") || null); } catch (e) { return fail(e); }
  revalidatePath("/expenses/settings");
  return { message: "Saved." };
}

export async function startAuditAction(_: State, fd: FormData): Promise<State> {
  const ctx = await requireCtx("assets.audit");
  let id: string;
  try { id = (await startAudit(ctx.org.id, ctx.user.id, { name: s(fd, "name") || null, location: s(fd, "location") || null })).id; } catch (e) { return fail(e); }
  redirect(`/assets/audits/${id}`);
}

export async function closeAuditAction(_: State, fd: FormData): Promise<State> {
  const ctx = await requireCtx("journal.post");
  try { await closeAudit(ctx.org.id, ctx.user.id, s(fd, "id"), fd.get("markMissing") === "on"); } catch (e) { return fail(e); }
  revalidatePath("/assets/audits", "layout");
  return { message: "Count closed. Unscanned assets were marked missing in the register." };
}
