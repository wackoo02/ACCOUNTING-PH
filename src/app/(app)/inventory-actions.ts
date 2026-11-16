"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCtx } from "@/lib/auth";
import { LedgerError } from "@/lib/ledger/service";
import { INV_TYPES, approveInventory, needsApproval, rejectInventory, saveInventoryTransaction, submitInventory, voidInventory } from "@/lib/inventory/service";
import { createCount, postCount, rejectCount, saveCountSheet, submitCount, voidCountDraft } from "@/lib/inventory/counts";

export type FormState = { errors?: string[]; message?: string } | undefined;

function fail(e: unknown): FormState {
  if (e instanceof LedgerError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e;
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date");
const DocSchema = z.object({
  id: z.string().optional(),
  type: z.enum(INV_TYPES),
  date: day,
  warehouseId: z.string().min(1, "Choose a warehouse"),
  toWarehouseId: z.string().optional(),
  party: z.string().optional(),
  reference: z.string().optional(),
  memo: z.string(),
  offsetAccountId: z.string().optional(),
  lines: z.array(z.object({
    itemId: z.string(), qty: z.string(), unitCost: z.string().optional(), locationId: z.string().optional(), toLocationId: z.string().optional(),
    lotNo: z.string().optional(), accountId: z.string().optional(), description: z.string().optional(), dims: z.record(z.string(), z.string().nullable()).optional(),
  })),
  intent: z.enum(["draft", "submit", "post"]),
});

export async function saveInventoryDoc(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const p = DocSchema.safeParse(JSON.parse(String(fd.get("payload") ?? "{}")));
    if (!p.success) return { errors: p.error.issues.map((i) => i.message) };
    const v = p.data;
    const ctx = await requireCtx("inventory.transact");
    const [partyType, partyId] = v.party ? v.party.split(":") : [null, null];
    const t = await saveInventoryTransaction({
      organizationId: ctx.org.id, userId: ctx.user.id, type: v.type, date: new Date(v.date), warehouseId: v.warehouseId, toWarehouseId: v.toWarehouseId || null,
      partyType, partyId, reference: v.reference, memo: v.memo, offsetAccountId: v.offsetAccountId || null, action: v.intent,
      lines: v.lines.map((l) => ({ ...l, dims: Object.fromEntries(Object.entries(l.dims ?? {}).map(([k, x]) => [k, x || null])) })),
    }, v.id);
    id = t.id;
  } catch (e) { return fail(e); }
  revalidatePath("/inventory");
  redirect(`/inventory/transactions/${id}`);
}

export async function inventoryWorkflow(_: FormState, fd: FormData): Promise<FormState> {
  const id = String(fd.get("id"));
  const op = String(fd.get("op"));
  const type = String(fd.get("type") ?? "");
  let msg = "";
  try {
    if (op === "submit") { const c = await requireCtx("inventory.transact"); await submitInventory(c.org.id, c.user.id, id); msg = "Submitted for approval."; }
    else if (op === "post") { const c = await requireCtx(needsApproval(type) ? "inventory.approve" : "inventory.transact"); await approveInventory(c.org.id, c.user.id, id); msg = "Posted. Stock and the general ledger are updated."; }
    else if (op === "reject") { const c = await requireCtx("inventory.approve"); await rejectInventory(c.org.id, c.user.id, id, String(fd.get("reason") ?? "")); msg = "Returned to the preparer."; }
    else if (op === "void") {
      const c = await requireCtx("inventory.approve");
      const dt = String(fd.get("date") ?? "");
      await voidInventory(c.org.id, c.user.id, id, String(fd.get("reason") ?? ""), dt ? new Date(dt) : undefined);
      msg = "Voided. Stock was restored and the GL entry reversed.";
    } else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath(`/inventory/transactions/${id}`);
  revalidatePath("/inventory");
  return { message: msg };
}

export async function newCount(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const c = await requireCtx("inventory.transact");
    const type = String(fd.get("type")) === "PHYSICAL" ? "PHYSICAL" : "CYCLE";
    const r = await createCount({
      organizationId: c.org.id, userId: c.user.id, warehouseId: String(fd.get("warehouseId") ?? ""), type, date: new Date(String(fd.get("date"))),
      memo: String(fd.get("memo") ?? ""), category: String(fd.get("category") ?? "") || null, locationId: String(fd.get("locationId") ?? "") || null,
      itemIds: fd.getAll("itemIds").map(String).filter(Boolean),
    });
    id = r.id;
  } catch (e) { return fail(e); }
  redirect(`/inventory/counts/${id}`);
}

export async function countWorkflow(_: FormState, fd: FormData): Promise<FormState> {
  const id = String(fd.get("id"));
  const op = String(fd.get("op"));
  let msg = "";
  try {
    if (op === "save" || op === "save-submit") {
      const c = await requireCtx("inventory.transact");
      const counts = [...fd.keys()].filter((k) => k.startsWith("q_")).map((k) => ({ lineId: k.slice(2), countedQty: String(fd.get(k) ?? ""), note: String(fd.get(`n_${k.slice(2)}`) ?? "") }));
      const added = [0, 1, 2, 3, 4].map((i) => ({ itemId: String(fd.get(`a_item_${i}`) ?? ""), locationId: String(fd.get(`a_loc_${i}`) ?? "") || null, lotNo: String(fd.get(`a_lot_${i}`) ?? "") || null, countedQty: String(fd.get(`a_qty_${i}`) ?? "") }))
        .filter((a) => a.itemId && a.countedQty.trim());
      await saveCountSheet(c.org.id, c.user.id, id, counts, added);
      msg = "Counts saved.";
      if (op === "save-submit") { await submitCount(c.org.id, c.user.id, id); msg = "Counts saved and submitted for approval."; }
    } else if (op === "post") { const c = await requireCtx("inventory.approve"); const r = await postCount(c.org.id, c.user.id, id); msg = r.variances ? `Posted: ${r.variances} variance(s) booked as an adjustment.` : "Posted: no variances."; }
    else if (op === "reject") { const c = await requireCtx("inventory.approve"); await rejectCount(c.org.id, c.user.id, id, String(fd.get("reason") ?? "")); msg = "Returned for recount."; }
    else if (op === "void") { const c = await requireCtx("inventory.transact"); await voidCountDraft(c.org.id, c.user.id, id); msg = "Count cancelled."; }
    else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath(`/inventory/counts/${id}`);
  return { message: msg };
}
