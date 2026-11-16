"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import {
  accrueInterest, createLoanPayment, deleteCovenant, modifyLoan, previewModification, reclassify, recordDrawdown, reverseLoanTransaction,
  runPeriodEnd, saveCovenant, saveLoan, type ModificationInput,
} from "@/lib/debt/service";
import { fromCentavos } from "@/lib/money";

export type FormState = { errors?: string[]; message?: string } | undefined;

function fail(e: unknown): FormState {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const date = (fd: FormData, k: string) => { const v = s(fd, k); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new LedgerError(["Enter a valid date"]); return new Date(`${v}T00:00:00.000Z`); };
const optDate = (fd: FormData, k: string) => (s(fd, k) ? date(fd, k) : null);
const peso = (c: bigint) => Number(fromCentavos(c)).toLocaleString("en-PH", { minimumFractionDigits: 2 });

export async function saveLoanAction(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const c = await requireCtx("journal.post");
    const lender = s(fd, "lender");
    const vendor = s(fd, "lenderVendorCode");
    const l = await saveLoan({
      organizationId: c.org.id, userId: c.user.id, number: s(fd, "number"), lender, lenderVendorCode: vendor || null, loanType: s(fd, "loanType"),
      originalPrincipal: s(fd, "originalPrincipal"), interestRate: s(fd, "interestRate"), rateType: s(fd, "rateType"), dayCount: s(fd, "dayCount"),
      startDate: date(fd, "startDate"), maturityDate: date(fd, "maturityDate"), firstPaymentDate: optDate(fd, "firstPaymentDate"),
      paymentFrequency: s(fd, "paymentFrequency"), repaymentType: s(fd, "repaymentType"), graceMonths: Number(s(fd, "graceMonths") || 0),
      stAccountId: s(fd, "stAccountId"), ltAccountId: s(fd, "ltAccountId"), interestExpenseAccountId: s(fd, "interestExpenseAccountId"),
      interestPayableAccountId: s(fd, "interestPayableAccountId"), issueCostAccountId: s(fd, "issueCostAccountId") || null,
      bankAccountId: s(fd, "bankAccountId") || null, notes: s(fd, "notes"),
    }, s(fd, "id") || undefined);
    id = l.id;
  } catch (e) { return fail(e); }
  revalidatePath("/debt");
  redirect(`/debt/${id}`);
}

export async function loanAction(_: FormState, fd: FormData): Promise<FormState> {
  const loanId = s(fd, "loanId");
  const op = s(fd, "op");
  let msg = "";
  let go: string | null = null;
  try {
    if (op === "drawdown") {
      const c = await requireCtx("journal.post");
      await recordDrawdown({ organizationId: c.org.id, userId: c.user.id, loanId, date: date(fd, "date"), amount: s(fd, "amount"), fees: s(fd, "fees"), bankAccountId: s(fd, "bankAccountId") || null, memo: s(fd, "memo") });
      msg = "Drawdown posted to the general ledger and the repayment schedule was generated.";
    } else if (op === "accrue") {
      const c = await requireCtx("journal.post");
      const t = await accrueInterest(c.org.id, c.user.id, loanId, date(fd, "date"));
      msg = t ? "Interest accrued and posted." : "No interest to accrue for that period.";
    } else if (op === "pay") {
      const c = await requireCtx("journal.create");
      const intent = s(fd, "intent") as "draft" | "submit" | "post";
      if (intent === "post") await requireCtx("journal.post");
      const v = await createLoanPayment({
        organizationId: c.org.id, userId: c.user.id, loanId, date: date(fd, "date"), bankAccountId: s(fd, "bankAccountId") || null,
        principal: s(fd, "principal") || "0", interest: s(fd, "interest") || "0", method: s(fd, "method"), checkNo: s(fd, "checkNo") || null,
        reference: s(fd, "reference") || null, action: intent || "submit",
      });
      go = `/cash/${v.id}`;
    } else if (op === "undo") {
      const c = await requireCtx("journal.void");
      await reverseLoanTransaction(c.org.id, c.user.id, loanId, s(fd, "txnId"));
      msg = "Undone. The GL entry was reversed.";
    } else if (op === "covenant") {
      const c = await requireCtx("journal.post");
      await saveCovenant({
        organizationId: c.org.id, userId: c.user.id, loanId, name: s(fd, "name"), metric: s(fd, "metric"), operator: s(fd, "operator"), threshold: s(fd, "threshold"),
        frequency: s(fd, "frequency"), manualValue: s(fd, "manualValue") || null, waiverUntil: optDate(fd, "waiverUntil"), notes: s(fd, "notes"),
      }, s(fd, "covenantId") || undefined);
      msg = "Covenant saved.";
    } else if (op === "covenant_remove") {
      const c = await requireCtx("journal.post");
      await deleteCovenant(c.org.id, c.user.id, s(fd, "covenantId"));
      msg = "Covenant removed.";
    } else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath(`/debt/${loanId}`);
  revalidatePath("/debt");
  if (go) redirect(go);
  return { message: msg };
}

function modInput(c: { org: { id: string }; user: { id: string } }, fd: FormData): ModificationInput {
  return {
    organizationId: c.org.id, userId: c.user.id, loanId: s(fd, "loanId"), date: date(fd, "date"), kind: s(fd, "kind") === "REPRICING" ? "REPRICING" : "TERMS",
    interestRate: s(fd, "interestRate"), maturityDate: date(fd, "maturityDate"), paymentFrequency: s(fd, "paymentFrequency"), repaymentType: s(fd, "repaymentType"),
    firstPaymentDate: optDate(fd, "firstPaymentDate"), fees: s(fd, "fees"), bankAccountId: s(fd, "bankAccountId") || null,
    gainLossAccountId: s(fd, "gainLossAccountId") || null, reason: s(fd, "reason"),
  };
}

export async function modifyAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.post");
    const input = modInput(c, fd);
    if (s(fd, "intent") !== "post") {
      const p = await previewModification(input);
      const verdict = input.kind === "REPRICING"
        ? "Rate reset / re-amortization: no gain or loss; the effective rate changes from now on."
        : p.substantial
          ? `Substantial modification (${p.pct}% change, 10% or more): the old loan is derecognized. Unamortized costs and fees of ${peso(p.gainLossAmt)} go to profit or loss.`
          : `Non-substantial modification (${p.pct}% change, under 10%): the carrying amount is adjusted to ${peso(p.pvNew)} (new cash flows at the original effective rate), a ${p.gainLossAmt >= 0n ? "loss" : "gain"} of ${peso(p.gainLossAmt < 0n ? -p.gainLossAmt : p.gainLossAmt)}.`;
      return { message: `Preview as of ${input.date.toISOString().slice(0, 10)}: carrying amount ${peso(p.oldCarrying)}. ${verdict} New effective rate ${p.newEir.toFixed(4)}%, ${p.rows.length} payments of about ${peso(p.rows[0]?.payment ?? 0n)}. Interest is accrued to the modification date when you post.` };
    }
    await modifyLoan(input);
    revalidatePath(`/debt/${input.loanId}`);
  } catch (e) { return fail(e); }
  redirect(`/debt/${s(fd, "loanId")}`);
}

export async function periodEndAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const c = await requireCtx("journal.post");
    const d = date(fd, "date");
    if (s(fd, "op") === "reclass") {
      const r = await reclassify(c.org.id, c.user.id, d, true);
      revalidatePath("/debt");
      return { message: `Reclassification posted for ${r.filter((x) => x.change !== 0n).length} loan(s).` };
    }
    const r = await runPeriodEnd(c.org.id, c.user.id, d);
    revalidatePath("/debt");
    return { message: `Done: interest accrued on ${r.accrued} loan(s), current portion trued up on ${r.reclassified} loan(s).` };
  } catch (e) { return fail(e); }
}
