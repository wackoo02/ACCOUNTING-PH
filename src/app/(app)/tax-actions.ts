"use server";
import { revalidatePath } from "next/cache";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import { classifyJournalLine, unclassifyJournalLine } from "@/lib/tax/feed";
import { fileReturn, reopenReturn, saveReturnInputs } from "@/lib/tax/filing";
import { isForm } from "@/lib/tax/periods";
import { isTaxKind } from "@/lib/tax/feed";

export type FormState = { errors?: string[]; message?: string } | undefined;

function fail(e: unknown): FormState {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}

function formArgs(fd: FormData) {
  const form = String(fd.get("form"));
  if (!isForm(form)) throw new LedgerError(["Unknown return"]);
  return { form, year: Number(fd.get("year")), n: Number(fd.get("n")) };
}

export async function saveReturnAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("period.close");
    const { form, year, n } = formArgs(fd);
    const inputs: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith("in.")) inputs[k.slice(3)] = String(v);
    await saveReturnInputs(ctx.org.id, ctx.user.id, form, year, n, inputs);
  } catch (e) { return fail(e); }
  revalidatePath("/tax");
  return { message: "Draft saved." };
}

export async function fileReturnAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("period.close");
    const { form, year, n } = formArgs(fd);
    const filedAt = String(fd.get("filedAt") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(filedAt)) return { errors: ["Enter the date you filed the return"] };
    await fileReturn(ctx.org.id, ctx.user.id, form, year, n, {
      filedAt: new Date(filedAt), filingRef: String(fd.get("filingRef") ?? ""), amountPaid: String(fd.get("amountPaid") ?? ""),
      paymentRef: String(fd.get("paymentRef") ?? ""), postClosing: fd.get("postClosing") === "on",
    });
  } catch (e) { return fail(e); }
  revalidatePath("/tax");
  return { message: "Recorded as filed." };
}

export async function reopenReturnAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("org.manage");
    await reopenReturn(ctx.org.id, ctx.user.id, String(fd.get("id")));
  } catch (e) { return fail(e); }
  revalidatePath("/tax");
  return { message: "Reopened. Any VAT closing entry was reversed." };
}

export async function classifyAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("period.close");
    const lineId = String(fd.get("lineId"));
    const kind = String(fd.get("kind"));
    if (kind === "EXCLUDED") await classifyJournalLine(ctx.org.id, ctx.user.id, lineId, { kind: "EXCLUDED", description: String(fd.get("description") ?? "") || null });
    else {
      if (!isTaxKind(kind)) return { errors: ["Choose what this tax line is"] };
      const party = String(fd.get("party") ?? "");
      const [ptype, pid] = party.includes(":") ? party.split(":") : [null, null];
      const name = String(fd.get("partyName") ?? "").trim();
      const tin = String(fd.get("partyTin") ?? "").trim();
      await classifyJournalLine(ctx.org.id, ctx.user.id, lineId, {
        kind, taxBase: String(fd.get("taxBase") ?? "0"), taxAmount: String(fd.get("taxAmount") ?? "0"), rate: String(fd.get("rate") ?? "0") || 0,
        vatClass: (String(fd.get("vatClass") ?? "") || null) as never, atcCode: String(fd.get("atcCode") ?? "") || null,
        docNumber: String(fd.get("docNumber") ?? "") || null,
        party: ptype ? { type: ptype, id: pid, tin: tin || null, name: name || null } : name || tin ? { type: "OTHER", name: name || null, tin: tin || null } : null,
      });
    }
  } catch (e) { return fail(e); }
  revalidatePath("/tax/review");
  return { message: "Saved." };
}

export async function unclassifyAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("period.close");
    await unclassifyJournalLine(ctx.org.id, ctx.user.id, String(fd.get("lineId")));
  } catch (e) { return fail(e); }
  revalidatePath("/tax/review");
  return { message: "Classification removed." };
}
