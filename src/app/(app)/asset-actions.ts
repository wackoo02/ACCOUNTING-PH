"use server";
// Server actions for the Fixed Assets pages.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import { acceptSeenLocation, addAsset, disposeAsset, improveAsset, runDepreciation, transferAsset, undoDepreciationRun, voidAssetTxn } from "@/lib/assets/service";

type State = { errors?: string[]; message?: string } | undefined;
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const opt = (fd: FormData, k: string) => s(fd, k) || null;
const date = (fd: FormData, k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s(fd, k)) ? new Date(s(fd, k) + "T00:00:00Z") : null);
const int = (fd: FormData, k: string) => (s(fd, k) ? parseInt(s(fd, k), 10) : null);

function fail(e: unknown): State {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}
const refresh = () => revalidatePath("/assets", "layout");

export async function addAssetAction(_: State, fd: FormData): Promise<State> {
  const postToGl = s(fd, "postToGl") === "yes";
  const ctx = await requireCtx(postToGl || s(fd, "apBillLineId") ? "journal.post" : "masters.manage");
  let id: string;
  try {
    const acq = date(fd, "acquisitionDate");
    if (!acq) return { errors: ["Enter the purchase date"] };
    const a = await addAsset(ctx.org.id, ctx.user.id, {
      code: opt(fd, "code"), name: s(fd, "name"), categoryCode: opt(fd, "categoryCode"), serialNo: opt(fd, "serialNo"), location: opt(fd, "location"),
      departmentCode: opt(fd, "departmentCode"), costCenterCode: opt(fd, "costCenterCode"), custodianCode: opt(fd, "custodianCode"),
      vendorCode: opt(fd, "vendorCode"), poNumber: opt(fd, "poNumber"), acquisitionDate: acq, inServiceDate: date(fd, "inServiceDate"),
      cost: s(fd, "cost"), salvageValue: opt(fd, "salvageValue"), usefulLifeMonths: int(fd, "usefulLifeMonths"), depreciationMethod: opt(fd, "depreciationMethod"),
      accountCode: opt(fd, "accountCode"), accumDepAccountCode: opt(fd, "accumDepAccountCode"), depExpenseAccountCode: opt(fd, "depExpenseAccountCode"),
      postToGl, apBillLineId: opt(fd, "apBillLineId"), offsetAccountCode: opt(fd, "offsetAccountCode"), reference: opt(fd, "reference"), memo: opt(fd, "memo"),
      openingAccum: postToGl ? null : opt(fd, "openingAccum"), depreciatedThrough: postToGl ? null : date(fd, "depreciatedThrough"), strict: true,
    });
    id = a.id;
  } catch (e) { return fail(e); }
  refresh();
  redirect(`/assets/${id}?saved=1`);
}

export async function assetTxnAction(_: State, fd: FormData): Promise<State> {
  const op = s(fd, "op");
  const ctx = await requireCtx(op === "transfer" || op === "accept-location" ? "journal.create" : "journal.post");
  const assetId = s(fd, "assetId");
  const d = date(fd, "date") ?? new Date();
  let message = "Saved.";
  try {
    if (op === "improve") {
      await improveAsset(ctx.org.id, ctx.user.id, { assetId, date: d, amount: s(fd, "amount"), extendLifeMonths: int(fd, "extendLifeMonths"), postToGl: s(fd, "postToGl") === "yes", offsetAccountCode: opt(fd, "offsetAccountCode"), vendorCode: opt(fd, "vendorCode"), reference: opt(fd, "reference"), memo: s(fd, "memo") });
      message = "Improvement capitalized.";
    } else if (op === "transfer") {
      await transferAsset(ctx.org.id, ctx.user.id, { assetId, date: d, location: opt(fd, "location"), custodianCode: opt(fd, "custodianCode"), departmentCode: opt(fd, "departmentCode"), costCenterCode: opt(fd, "costCenterCode"), reference: opt(fd, "reference"), memo: opt(fd, "memo") });
      message = "Transfer recorded.";
    } else if (op === "dispose" || op === "retire") {
      await disposeAsset(ctx.org.id, ctx.user.id, {
        assetId, type: op === "dispose" ? "DISPOSAL" : "RETIREMENT", date: d, proceeds: opt(fd, "proceeds"), outputVat: opt(fd, "outputVat"), proceedsAccountCode: opt(fd, "proceedsAccountCode"),
        gainLossAccountCode: opt(fd, "gainLossAccountCode"), buyer: opt(fd, "buyer"), customerCode: opt(fd, "customerCode"), reference: opt(fd, "reference"), memo: s(fd, "memo"),
      });
      message = op === "dispose" ? "Sale posted to the GL." : "Retirement posted to the GL.";
    } else if (op === "void") {
      await voidAssetTxn(ctx.org.id, ctx.user.id, s(fd, "txnId"), s(fd, "reason"));
      message = "Transaction undone.";
    } else if (op === "accept-location") {
      await acceptSeenLocation(ctx.org.id, ctx.user.id, assetId);
      message = "Location updated from the asset count.";
    } else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  refresh();
  return { message };
}

export async function depreciationAction(_: State, fd: FormData): Promise<State> {
  const ctx = await requireCtx("journal.post");
  try {
    if (s(fd, "op") === "undo") {
      await undoDepreciationRun(ctx.org.id, ctx.user.id, s(fd, "runId"));
      refresh();
      return { message: "Run undone and its journal reversed." };
    }
    const [y, m] = s(fd, "period").split("-").map(Number);
    if (!y || !m) return { errors: ["Pick the month"] };
    const r = await runDepreciation(ctx.org.id, ctx.user.id, y, m);
    refresh();
    return { message: `${r.number} posted: ${r.assetCount} asset(s).` };
  } catch (e) { return fail(e); }
}
