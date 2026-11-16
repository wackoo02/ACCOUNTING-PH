// Approval matrix shared by purchase requests, purchase orders, supplier bills and payment vouchers.
// A document needs every level whose minimum amount is at or below its total, in level order.
// With no active rules for a document type, one approval by someone who may post entries
// (accountant/admin/owner) within their approval limit is enough.
import { Prisma, type Role } from "@prisma/client";
import { prisma } from "./db";
import { LedgerError } from "./ledger/service";
import { can, ROLE_LABELS } from "./permissions";
import { formatPeso, fromCentavos, toCentavos } from "./money";

type Tx = Prisma.TransactionClient;
export type DocType = "PR" | "PO" | "BILL" | "PAYMENT";
export const DOC_LABELS: Record<DocType, string> = { PR: "Purchase requests", PO: "Purchase orders", BILL: "Supplier bills (AP vouchers)", PAYMENT: "Payment vouchers" };

export type Level = { level: number; name: string; rules: { approverRole: Role | null; approverUserId: string | null }[]; isDefault: boolean };

const cents = (d: Prisma.Decimal | null | undefined) => toCentavos(d?.toString() ?? "0");

/** The levels a document of this type and total must pass, in order. */
export async function requiredLevels(tx: Tx, organizationId: string, docType: DocType, total: bigint): Promise<Level[]> {
  const rules = await tx.approvalRule.findMany({ where: { organizationId, docType, isActive: true }, orderBy: [{ level: "asc" }, { minAmount: "asc" }] });
  if (!rules.length) return [{ level: 1, name: "Accountant / administrator", rules: [], isDefault: true }];
  const applicable = rules.filter((r) => cents(r.minAmount) <= total);
  const byLevel = new Map<number, Level>();
  for (const r of applicable) {
    const l = byLevel.get(r.level) ?? { level: r.level, name: r.name || `Level ${r.level}`, rules: [], isDefault: false };
    l.rules.push({ approverRole: r.approverRole, approverUserId: r.approverUserId });
    byLevel.set(r.level, l);
  }
  // A document below every threshold still needs one approval: use the first level.
  if (!byLevel.size) {
    const first = rules[0].level;
    return [{ level: first, name: rules[0].name || `Level ${first}`, rules: rules.filter((r) => r.level === first).map((r) => ({ approverRole: r.approverRole, approverUserId: r.approverUserId })), isDefault: false }];
  }
  return [...byLevel.values()].sort((a, b) => a.level - b.level);
}

/** Steps of the current approval round (after the latest submission). */
async function currentRound(tx: Tx, organizationId: string, docType: DocType, docId: string) {
  const steps = await tx.approvalStep.findMany({ where: { organizationId, docType, docId }, orderBy: { createdAt: "asc" } });
  let start = 0;
  steps.forEach((s, i) => { if (s.decision === "SUBMITTED" || s.decision === "RETURNED") start = i + 1; });
  return steps.slice(start).filter((s) => s.decision === "APPROVED");
}

export async function recordSubmission(tx: Tx, organizationId: string, docType: DocType, docId: string, userId: string) {
  await tx.approvalStep.create({ data: { organizationId, docType, docId, userId, decision: "SUBMITTED" } });
}

export async function recordReturn(tx: Tx, organizationId: string, docType: DocType, docId: string, userId: string, reason: string, total: bigint) {
  if (!reason.trim()) throw new LedgerError(["Give a reason so the preparer knows what to fix"]);
  await assertMayAct(tx, organizationId, docType, docId, userId, total);
  await tx.approvalStep.create({ data: { organizationId, docType, docId, userId, decision: "RETURNED", comment: reason.trim() } });
}

async function eligible(tx: Tx, organizationId: string, userId: string, level: Level, total: bigint) {
  const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  if (!m) return { ok: false, why: "You are not a member of this company" };
  if (level.isDefault) {
    if (!can(m.role, "journal.post")) return { ok: false, why: "Only an accountant, administrator or owner can approve this" };
    if (m.approvalLimit !== null && total > cents(m.approvalLimit)) return { ok: false, why: `This document (${formatPeso(total)}) is above your approval limit of ${formatPeso(cents(m.approvalLimit))}` };
    return { ok: true, why: "" };
  }
  const ok = level.rules.some((r) => (r.approverUserId ? r.approverUserId === userId : r.approverRole ? r.approverRole === m.role || m.role === "OWNER" : false));
  if (ok) return { ok: true, why: "" };
  const who = level.rules.map((r) => (r.approverRole ? ROLE_LABELS[r.approverRole] : "the named approver")).join(" or ");
  return { ok: false, why: `${level.name} must be approved by ${who}` };
}

export type ApprovalState = { levels: Level[]; approved: { level: number; userId: string; at: Date }[]; next: Level | null };

export async function approvalState(tx: Tx, organizationId: string, docType: DocType, docId: string, total: bigint): Promise<ApprovalState> {
  const levels = await requiredLevels(tx, organizationId, docType, total);
  const round = await currentRound(tx, organizationId, docType, docId);
  const done = new Set(round.map((s) => s.level));
  return { levels, approved: round.map((s) => ({ level: s.level, userId: s.userId, at: s.createdAt })), next: levels.find((l) => !done.has(l.level)) ?? null };
}

/** Returning a document: whoever may approve its next level, or anyone who may post entries. */
async function assertMayAct(tx: Tx, organizationId: string, docType: DocType, docId: string, userId: string, total: bigint) {
  const st = await approvalState(tx, organizationId, docType, docId, total);
  const m = await tx.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  if (m && can(m.role, "journal.post")) return;
  if (st.next && (await eligible(tx, organizationId, userId, st.next, total)).ok) return;
  throw new LedgerError(["You are not an approver of this document"]);
}

/**
 * Record one approval. Returns true when this was the last level (the caller then finalizes:
 * approves the PO, posts the bill, releases the payment).
 * Segregation of duties: the preparer cannot approve, and one person approves one level only.
 */
export async function approveLevel(tx: Tx, input: { organizationId: string; docType: DocType; docId: string; userId: string; total: bigint; preparerIds: (string | null)[]; comment?: string | null }) {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: input.organizationId } });
  const st = await approvalState(tx, input.organizationId, input.docType, input.docId, input.total);
  if (!st.next) return true;
  if (org.segregationOfDuties && input.preparerIds.includes(input.userId)) throw new LedgerError(["Segregation of duties: someone other than the preparer must approve this"]);
  if (org.segregationOfDuties && st.approved.some((a) => a.userId === input.userId)) throw new LedgerError(["You already approved an earlier level; the next level needs a different approver"]);
  const e = await eligible(tx, input.organizationId, input.userId, st.next, input.total);
  if (!e.ok) throw new LedgerError([e.why]);
  await tx.approvalStep.create({ data: { organizationId: input.organizationId, docType: input.docType, docId: input.docId, userId: input.userId, level: st.next.level, decision: "APPROVED", comment: input.comment?.trim() || null } });
  return st.levels[st.levels.length - 1].level === st.next.level;
}

/** Whether this user can approve the next level now (for showing the button and the approvals inbox). */
export async function canApproveNow(organizationId: string, docType: DocType, docId: string, userId: string, total: bigint, preparerIds: (string | null)[]) {
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const st = await approvalState(tx, organizationId, docType, docId, total);
    if (!st.next) return { ok: false, why: "Fully approved", state: st };
    if (org.segregationOfDuties && preparerIds.includes(userId)) return { ok: false, why: "You prepared this document", state: st };
    if (org.segregationOfDuties && st.approved.some((a) => a.userId === userId)) return { ok: false, why: "You already approved an earlier level", state: st };
    const e = await eligible(tx, organizationId, userId, st.next, total);
    return { ok: e.ok, why: e.why, state: st };
  });
}

export async function approvalHistory(organizationId: string, docType: DocType, docId: string) {
  const steps = await prisma.approvalStep.findMany({ where: { organizationId, docType, docId }, orderBy: { createdAt: "asc" } });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(steps.map((s) => s.userId))] } }, select: { id: true, name: true } });
  const name = new Map(users.map((u) => [u.id, u.name]));
  return steps.map((s) => ({ ...s, userName: name.get(s.userId) ?? "?" }));
}

// ---------- Matrix maintenance (Settings → Approval Matrix) ----------

export async function saveApprovalRule(organizationId: string, input: { docType: string; level: number; name?: string | null; minAmount: string; approverRole?: string | null; approverUserId?: string | null }) {
  const errors: string[] = [];
  if (!(input.docType in DOC_LABELS)) errors.push("Choose a document type");
  if (!(input.level >= 1 && input.level <= 9)) errors.push("Level must be 1 to 9");
  let min = 0n;
  try { min = toCentavos(input.minAmount || "0"); } catch (e) { errors.push((e as Error).message); }
  if (min < 0n) errors.push("Minimum amount cannot be negative");
  const role = input.approverRole || null;
  const user = input.approverUserId || null;
  if (!role && !user) errors.push("Choose who approves: a role or a person");
  if (role && user) errors.push("Choose a role or a person, not both");
  if (role && !(role in ROLE_LABELS)) errors.push("Unknown role");
  if (user && !(await prisma.membership.findUnique({ where: { userId_organizationId: { userId: user, organizationId } } }))) errors.push("That person is not a user of this company");
  if (errors.length) throw new LedgerError(errors);
  return prisma.approvalRule.create({ data: { organizationId, docType: input.docType, level: input.level, name: input.name?.trim() || null, minAmount: new Prisma.Decimal(fromCentavos(min)), approverRole: role as Role | null, approverUserId: user } });
}

export async function deleteApprovalRule(organizationId: string, id: string) {
  await prisma.approvalRule.deleteMany({ where: { id, organizationId } });
}
