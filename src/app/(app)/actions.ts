"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireCtx, switchOrganization, hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  LedgerError, closeFiscalYear, postJournal, recordIntercompany, recordJournal, rejectJournal, reopenFiscalYear,
  reverseIntercompany, revalueForeignCurrency, runAutoReversals, setPeriodStatus, setupIntercompany, submitForApproval, updateDraft, voidOrReverse,
} from "@/lib/ledger/service";
import { formatPeso } from "@/lib/money";
import { MASTERS, isMasterKind, type MasterKind } from "@/lib/masters/config";
import { parseRow } from "@/lib/masters/rows";
import { MasterError, importMasters, saveMaster } from "@/lib/masters/store";
import { parseUpload } from "@/lib/masters/excel";
import { provisionOrganization } from "@/lib/org";
import { importBudget } from "@/lib/budgets";
import { createAllocationRule, createRecurringFromEntry, runAllocation, runRecurring } from "@/lib/ledger/automation";

export type FormState = { errors?: string[]; message?: string } | undefined;

function fail(e: unknown): FormState {
  if (e instanceof LedgerError || e instanceof MasterError) return { errors: e.errors };
  if (e instanceof Error && e.message.startsWith("You do not have permission")) return { errors: [e.message] };
  if (e && typeof e === "object" && "digest" in e) throw e; // let Next.js redirects through
  console.error(e);
  return { errors: ["Something went wrong. Please try again."] };
}

export async function changeCompany(fd: FormData) {
  await switchOrganization(String(fd.get("organizationId")));
  redirect("/dashboard");
}

// ---------- Journal entries ----------

const JournalSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid posting date"),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid transaction date"),
  memo: z.string(),
  reference: z.string().optional(),
  currencyCode: z.string().optional(),
  fxRate: z.string().optional(),
  lines: z.array(z.object({
    accountId: z.string(),
    description: z.string().optional(),
    debit: z.string().optional(),
    credit: z.string().optional(),
    dims: z.record(z.string(), z.string().nullable()).optional(),
  })),
  attachments: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
  intent: z.enum(["draft", "submit", "post"]),
  entryId: z.string().optional(),
  book: z.enum(["STATUTORY", "CONSOLIDATION"]).optional(),
});

export async function saveJournal(_: FormState, fd: FormData): Promise<FormState> {
  let id: string;
  try {
    const raw = JSON.parse(String(fd.get("payload") ?? "{}"));
    const p = JournalSchema.safeParse(raw);
    if (!p.success) return { errors: p.error.issues.map((i) => i.message) };
    const d = p.data;
    const ctx = await requireCtx(d.intent === "post" ? "journal.post" : "journal.create");
    const lines = d.lines.map((l) => ({ ...l, currencyCode: d.currencyCode, fxRate: d.fxRate }));
    const base = {
      organizationId: ctx.org.id, userId: ctx.user.id, date: new Date(d.date), transactionDate: new Date(d.transactionDate),
      memo: d.memo, reference: d.reference, lines, attachments: d.attachments,
    };
    if (d.entryId) {
      await updateDraft(d.entryId, base);
      if (d.intent === "submit") await submitForApproval(ctx.org.id, ctx.user.id, d.entryId);
      if (d.intent === "post") await postJournal(ctx.org.id, ctx.user.id, d.entryId);
      id = d.entryId;
    } else {
      id = (await recordJournal({ ...base, action: d.intent, book: d.book })).id;
    }
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/journals");
  redirect(`/journals/${id}`);
}

export async function workflowAction(_: FormState, fd: FormData): Promise<FormState> {
  const id = String(fd.get("id"));
  const op = String(fd.get("op"));
  try {
    if (op === "submit") {
      const ctx = await requireCtx("journal.create");
      await submitForApproval(ctx.org.id, ctx.user.id, id);
    } else if (op === "approve") {
      const ctx = await requireCtx("journal.post");
      await postJournal(ctx.org.id, ctx.user.id, id);
    } else if (op === "reject") {
      const ctx = await requireCtx("journal.post");
      await rejectJournal(ctx.org.id, ctx.user.id, id, String(fd.get("reason") ?? ""));
    } else return { errors: ["Unknown action"] };
  } catch (e) { return fail(e); }
  revalidatePath(`/journals/${id}`);
  return { message: op === "submit" ? "Submitted for approval." : op === "approve" ? "Approved and posted to the general ledger." : "Returned to the preparer." };
}

export async function reverseEntry(_: FormState, fd: FormData): Promise<FormState> {
  let target = String(fd.get("id"));
  try {
    const ctx = await requireCtx("journal.void");
    const d = String(fd.get("date") ?? "");
    const rev = await voidOrReverse(ctx.org.id, ctx.user.id, target, d ? new Date(d) : undefined);
    if (rev) target = rev.id;
  } catch (e) { return fail(e); }
  revalidatePath("/journals");
  redirect(`/journals/${target}`);
}

// ---------- Periods and fiscal years ----------

export async function togglePeriod(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("period.close");
    const [y, m] = String(fd.get("period")).split("-").map(Number);
    await setPeriodStatus(ctx.org.id, ctx.user.id, y, m, fd.get("status") === "CLOSED" ? "CLOSED" : "OPEN");
  } catch (e) { return fail(e); }
  revalidatePath("/periods");
  return { message: "Saved." };
}

export async function fiscalYearAction(_: FormState, fd: FormData): Promise<FormState> {
  const year = Number(fd.get("year"));
  try {
    const ctx = await requireCtx("period.close");
    if (fd.get("op") === "reopen") {
      await reopenFiscalYear(ctx.org.id, ctx.user.id, year);
      revalidatePath("/periods");
      return { message: `FY${year} reopened. Its months are closed (not locked) so you can reopen the ones you need.` };
    }
    const r = await closeFiscalYear(ctx.org.id, ctx.user.id, year);
    revalidatePath("/periods");
    return { message: `FY${year} closed. Net ${r.netProfit >= 0n ? "profit" : "loss"} of ${formatPeso(r.netProfit < 0n ? -r.netProfit : r.netProfit)} moved to retained earnings, and all its months are locked.` };
  } catch (e) { return fail(e); }
}

export async function revalueAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("journal.post");
    const rates: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith("rate_") && String(v).trim()) rates[k.slice(5)] = String(v).trim();
    const asOf = new Date(String(fd.get("asOf")));
    const e = await revalueForeignCurrency(ctx.org.id, ctx.user.id, asOf, rates);
    const rev = await runAutoReversals(ctx.org.id, ctx.user.id, new Date());
    revalidatePath("/fx");
    return { message: e ? `Posted revaluation ${e.number}. It reverses automatically on the 1st of next month.${rev.length ? ` ${rev.length} earlier revaluation(s) auto-reversed.` : ""}` : "Nothing to revalue: balances already match the closing rates." };
  } catch (e) { return fail(e); }
}

// ---------- Entities and intercompany ----------

export async function createEntity(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx();
  const p = z.object({
    name: z.string().trim().min(2, "Enter the entity name"),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, "Company code: 2-12 letters/numbers"),
    tin: z.string().trim().optional(),
    entityType: z.enum(["COMPANY", "SUBSIDIARY", "BRANCH", "DIVISION"]),
    parentId: z.string().optional(),
    ownershipPct: z.string().optional(),
  }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { errors: p.error.issues.map((i) => i.message) };
  if (p.data.parentId) {
    const m = ctx.memberships.find((x) => x.organizationId === p.data.parentId);
    if (!m || !["OWNER", "ADMIN"].includes(m.role)) return { errors: ["You must be an administrator of the parent entity"] };
  }
  if (await prisma.organization.findUnique({ where: { code: p.data.code } })) return { errors: ["That company code is already used"] };
  const org = await provisionOrganization({ name: p.data.name, tin: p.data.tin, ownerUserId: ctx.user.id });
  await prisma.organization.update({ where: { id: org.id }, data: {
    code: p.data.code, entityType: p.data.entityType, parentId: p.data.parentId || null,
    ownershipPct: p.data.ownershipPct ? p.data.ownershipPct : 100,
  } });
  revalidatePath("/entities");
  return { message: `${p.data.name} created. Switch to it from the company menu to set it up.` };
}

function thresholdOf(v: FormDataEntryValue | null, fallback: string) {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) return fallback;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) throw new LedgerError(["Fixed asset threshold: enter an amount like 5000 or 5000.00"]);
  return s;
}

export async function updateEntity(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("org.manage");
    const code = String(fd.get("code") ?? "").trim().toUpperCase();
    if (code && !/^[A-Z0-9-]{2,12}$/.test(code)) return { errors: ["Company code: 2-12 letters/numbers"] };
    const clash = code ? await prisma.organization.findFirst({ where: { code, id: { not: ctx.org.id } } }) : null;
    if (clash) return { errors: ["That company code is already used"] };
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
    const after = await prisma.organization.update({ where: { id: ctx.org.id }, data: {
      name: String(fd.get("name")).trim() || before.name,
      code: code || null,
      tin: String(fd.get("tin") ?? "").trim() || null,
      rdoCode: String(fd.get("rdoCode") ?? "").trim() || null,
      registeredAddress: String(fd.get("registeredAddress") ?? "").trim() || null,
      vatRegistered: fd.get("vatRegistered") === "on",
      fiscalYearStartMonth: Math.min(12, Math.max(1, Number(fd.get("fiscalYearStartMonth")) || 1)),
      requireApproval: fd.get("requireApproval") === "on",
      segregationOfDuties: fd.get("segregationOfDuties") === "on",
      fixedAssetThreshold: thresholdOf(fd.get("fixedAssetThreshold"), before.fixedAssetThreshold.toString()),
    } });
    await prisma.auditLog.create({ data: { organizationId: ctx.org.id, userId: ctx.user.id, action: "company.update", entity: "company", entityId: ctx.org.id,
      before: JSON.parse(JSON.stringify(before)), after: JSON.parse(JSON.stringify(after)) } });
  } catch (e) { return fail(e); }
  revalidatePath("/", "layout");
  return { message: "Company settings saved." };
}

export async function setupIntercompanyAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("masters.manage");
    await setupIntercompany(ctx.user.id, ctx.org.id, String(fd.get("counterpartyId")));
  } catch (e) { return fail(e); }
  revalidatePath("/entities");
  return { message: "Due from / Due to accounts created in both entities and linked." };
}

export async function intercompanyTxn(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("journal.post");
    const g = (k: string) => String(fd.get(k) ?? "").trim();
    const amount = g("amount");
    const fromSide = g("fromSide"); // "debit" or "credit" for the from-entity's own line
    const toSide = fromSide === "debit" ? "credit" : "debit";
    const r = await recordIntercompany({
      userId: ctx.user.id, date: new Date(g("date")), memo: g("memo"), reference: g("reference"),
      from: { organizationId: ctx.org.id, lines: [{ accountId: g("fromAccountId"), [fromSide]: amount, description: g("memo") }] },
      to: { organizationId: g("toOrgId"), lines: [{ accountId: g("toAccountId"), [toSide]: amount, description: g("memo") }] },
    });
    revalidatePath("/intercompany");
    return { message: `Posted ${r.entries.map((e) => e.number).join(" and ")} in both entities.` };
  } catch (e) { return fail(e); }
}

export async function reverseIntercompanyAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("journal.void");
    await reverseIntercompany(ctx.user.id, String(fd.get("groupId")), fd.get("date") ? new Date(String(fd.get("date"))) : undefined);
  } catch (e) { return fail(e); }
  revalidatePath("/intercompany");
  return { message: "Both sides reversed." };
}

// ---------- Master lists ----------

export async function saveMasterRecord(_: FormState, fd: FormData): Promise<FormState> {
  const kind = String(fd.get("_kind"));
  if (!isMasterKind(kind)) return { errors: ["Unknown list"] };
  const def = MASTERS[kind];
  let savedCode = "", savedType = "";
  try {
    const ctx = await requireCtx("masters.manage");
    const r = parseRow(def, (f) => (f.type === "bool" ? (fd.get(f.key) ? "TRUE" : "FALSE") : fd.get(f.key)));
    if (!r.ok) return { errors: r.errors };
    await saveMaster(kind, ctx.org.id, ctx.user.id, r.data, (fd.get("_original") as string) || undefined);
    savedCode = String(r.data.code);
    savedType = kind === "dimensions" ? String(r.data.type ?? "") : "";
  } catch (e) { return fail(e); }
  revalidatePath(`/masters/${kind}`);
  // Opened from a form's "Add new": hand the record back to that form instead of leaving it.
  if (fd.get("_embed")) redirect(`/embed/masters/${kind}/saved?${new URLSearchParams({ code: savedCode, ...(savedType ? { type: savedType } : {}) })}`);
  redirect(`/masters/${kind}?saved=1`);
}

export async function uploadMasters(_: FormState, fd: FormData): Promise<FormState> {
  const kind = String(fd.get("_kind")) as MasterKind;
  if (!isMasterKind(kind)) return { errors: ["Unknown list"] };
  try {
    const ctx = await requireCtx("masters.manage");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { errors: ["Choose the Excel file to upload"] };
    if (file.size > 10 * 1024 * 1024) return { errors: ["File is larger than 10 MB"] };
    const parsed = await parseUpload(kind, await file.arrayBuffer());
    if (parsed.errors.length) return { errors: ["Nothing was saved. Please fix these and upload again:", ...parsed.errors] };
    const res = await importMasters(kind, ctx.org.id, ctx.user.id, parsed.rows);
    revalidatePath(`/masters/${kind}`);
    return { message: `Upload complete: ${res.created} added, ${res.updated} updated.` };
  } catch (e) { return fail(e); }
}

// ---------- Users ----------

const RoleEnum = z.enum(["ADMIN", "ACCOUNTANT", "BOOKKEEPER", "VIEWER"]);

export async function addUser(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("users.manage");
    const p = z.object({
      name: z.string().trim().min(2, "Enter the person's name"),
      email: z.string().trim().toLowerCase().email("Enter a valid email"),
      role: RoleEnum,
      password: z.string().min(8, "Temporary password must be at least 8 characters"),
    }).safeParse(Object.fromEntries(fd));
    if (!p.success) return { errors: p.error.issues.map((i) => i.message) };
    let user = await prisma.user.findUnique({ where: { email: p.data.email } });
    if (!user) user = await prisma.user.create({ data: { email: p.data.email, name: p.data.name, passwordHash: await hashPassword(p.data.password) } });
    const exists = await prisma.membership.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: ctx.org.id } } });
    if (exists) return { errors: ["That person already has access to this company"] };
    await prisma.membership.create({ data: { userId: user.id, organizationId: ctx.org.id, role: p.data.role } });
    await prisma.auditLog.create({ data: { organizationId: ctx.org.id, userId: ctx.user.id, action: "user.add", entity: "user", entityId: user.id, after: { email: p.data.email, role: p.data.role } } });
    revalidatePath("/users");
    return { message: `${p.data.name} can now sign in with ${p.data.email}.` };
  } catch (e) { return fail(e); }
}

export async function changeRole(fd: FormData) {
  const ctx = await requireCtx("users.manage");
  const id = String(fd.get("membershipId"));
  const m = await prisma.membership.findFirst({ where: { id, organizationId: ctx.org.id } });
  if (!m || m.role === "OWNER") return;
  if (fd.get("remove")) await prisma.membership.delete({ where: { id } });
  else await prisma.membership.update({ where: { id }, data: { role: RoleEnum.parse(fd.get("role")) } });
  await prisma.auditLog.create({ data: { organizationId: ctx.org.id, userId: ctx.user.id, action: fd.get("remove") ? "user.remove" : "user.role", entity: "user", entityId: m.userId,
    before: { role: m.role }, after: fd.get("remove") ? { removed: true } : { role: String(fd.get("role")) } } });
  revalidatePath("/users");
}

export async function addCompany(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx();
  const name = String(fd.get("name") ?? "").trim();
  if (name.length < 2) return { errors: ["Enter the company name"] };
  const org = await provisionOrganization({ name, tin: String(fd.get("tin") ?? ""), ownerUserId: ctx.user.id });
  await switchOrganization(org.id);
  redirect("/dashboard");
}

// ---------- Budgets ----------

export async function uploadBudget(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("masters.manage");
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { errors: ["Choose the Excel file to upload"] };
    const r = await importBudget(ctx.org.id, ctx.user.id, Number(fd.get("year")), await file.arrayBuffer());
    if (r.errors.length) return { errors: ["Nothing was saved. Please fix these and upload again:", ...r.errors] };
    revalidatePath("/budgets");
    return { message: `Budget saved for ${r.saved} line(s).` };
  } catch (e) { return fail(e); }
}

// ---------- Approval limits ----------

export async function setApprovalLimit(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("users.manage");
    const id = String(fd.get("membershipId"));
    const raw = String(fd.get("limit") ?? "").replace(/,/g, "").trim();
    if (raw && !/^\d+(\.\d{1,2})?$/.test(raw)) return { errors: ["Approval limit must be an amount, or blank for no limit"] };
    const m = await prisma.membership.findFirst({ where: { id, organizationId: ctx.org.id } });
    if (!m) return { errors: ["User not found"] };
    const after = await prisma.membership.update({ where: { id }, data: { approvalLimit: raw || null } });
    await prisma.auditLog.create({ data: { organizationId: ctx.org.id, userId: ctx.user.id, action: "user.approval_limit", entity: "user", entityId: m.userId,
      before: { approvalLimit: m.approvalLimit?.toString() ?? null }, after: { approvalLimit: after.approvalLimit?.toString() ?? null } } });
  } catch (e) { return fail(e); }
  revalidatePath("/users");
  return { message: "Saved." };
}

// ---------- Recurring entries and allocations ----------

export async function makeRecurring(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("journal.create");
    const g = (k: string) => String(fd.get(k) ?? "").trim();
    await createRecurringFromEntry(ctx.org.id, ctx.user.id, g("entryId"), {
      name: g("name"), frequency: g("frequency"), nextRunDate: new Date(g("nextRunDate")), endDate: g("endDate") ? new Date(g("endDate")) : null, autoSubmit: fd.get("autoSubmit") === "on",
    });
  } catch (e) { return fail(e); }
  revalidatePath("/recurring");
  return { message: "Saved as a recurring entry. See General Ledger → Recurring Entries." };
}

export async function runRecurringAction(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("journal.create");
    const created = await runRecurring(ctx.org.id, ctx.user.id, new Date(String(fd.get("asOf"))));
    revalidatePath("/recurring");
    return { message: created.length ? `Created ${created.length} entr${created.length === 1 ? "y" : "ies"}: ${created.map((c) => c.number).join(", ")}` : "Nothing due." };
  } catch (e) { return fail(e); }
}

export async function toggleRecurring(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireCtx("journal.create");
  const r = await prisma.recurringJournal.findFirst({ where: { id: String(fd.get("id")), organizationId: ctx.org.id } });
  if (!r) return { errors: ["Not found"] };
  await prisma.recurringJournal.update({ where: { id: r.id }, data: { isActive: !r.isActive } });
  await prisma.auditLog.create({ data: { organizationId: ctx.org.id, userId: ctx.user.id, action: r.isActive ? "recurring.pause" : "recurring.resume", entity: "recurring", entityId: r.id } });
  revalidatePath("/recurring");
  return { message: r.isActive ? "Paused." : "Resumed." };
}

export async function saveAllocationRule(_: FormState, fd: FormData): Promise<FormState> {
  try {
    const ctx = await requireCtx("journal.post");
    const splits = JSON.parse(String(fd.get("splits") ?? "[]"));
    await createAllocationRule(ctx.org.id, ctx.user.id, {
      name: String(fd.get("name") ?? ""), sourceAccountId: String(fd.get("sourceAccountId")), targetAccountId: String(fd.get("targetAccountId") ?? "") || null,
      dimensionType: String(fd.get("dimensionType")) as never, splits,
    });
  } catch (e) { return fail(e); }
  revalidatePath("/allocations");
  return { message: "Allocation rule saved." };
}

export async function runAllocationAction(_: FormState, fd: FormData): Promise<FormState> {
  let id = "";
  try {
    const ctx = await requireCtx("journal.create");
    const g = (k: string) => String(fd.get(k) ?? "");
    id = (await runAllocation(ctx.org.id, ctx.user.id, g("ruleId"), new Date(g("from")), new Date(g("to")), new Date(g("date")))).id;
  } catch (e) { return fail(e); }
  redirect(`/journals/${id}`);
}
