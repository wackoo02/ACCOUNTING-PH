// Saved custom reports: who can see, change and delete them. Everything is scoped to one company.
import type { Prisma, ReportVisibility, Role, SavedReport } from "@prisma/client";
import { prisma } from "../db";
import { can } from "../permissions";
import { parseDefinition } from "./definition";

export type Member = { userId: string; organizationId: string; role: Role };

const isAdmin = (role: Role) => role === "OWNER" || role === "ADMIN";

export function canView(r: SavedReport, m: Member) {
  if (r.organizationId !== m.organizationId || !can(m.role, "reports.view")) return false;
  if (r.ownerId === m.userId || isAdmin(m.role)) return true;
  switch (r.visibility) {
    case "COMPANY": return true;
    case "ROLES": return r.sharedRoles.includes(m.role);
    case "USERS": return r.sharedUserIds.includes(m.userId);
    default: return false;
  }
}
export const canEdit = (r: SavedReport, m: Member) => canView(r, m) && (r.ownerId === m.userId || isAdmin(m.role) || r.allowEdit);
export const canDelete = (r: SavedReport, m: Member) => r.organizationId === m.organizationId && (r.ownerId === m.userId || isAdmin(m.role));
export const canShare = canDelete;

/** Reports the member can open: their own first, then shared with them. */
export async function listReports(m: Member) {
  const all = await prisma.savedReport.findMany({ where: { organizationId: m.organizationId }, orderBy: [{ name: "asc" }] });
  const visible = all.filter((r) => canView(r, m));
  const owners = await prisma.user.findMany({ where: { id: { in: [...new Set(visible.map((r) => r.ownerId))] } }, select: { id: true, name: true } });
  const nameOf = new Map(owners.map((u) => [u.id, u.name]));
  return visible.map((r) => ({ ...r, ownerName: nameOf.get(r.ownerId) ?? "Former user", mine: r.ownerId === m.userId, editable: canEdit(r, m), deletable: canDelete(r, m) }));
}

export async function getReport(id: string, m: Member) {
  const r = await prisma.savedReport.findUnique({ where: { id } });
  return r && canView(r, m) ? r : null;
}

export type SaveInput = {
  id?: string | null;
  name: string;
  description?: string | null;
  definition: unknown;
  visibility: ReportVisibility;
  sharedRoles?: Role[];
  sharedUserIds?: string[];
  allowEdit?: boolean;
};

export async function saveReport(m: Member, input: SaveInput): Promise<{ ok: true; id: string } | { ok: false; errors: string[] }> {
  const name = input.name?.trim();
  const errors: string[] = [];
  if (!name) errors.push("Give the report a name");
  if (name && name.length > 120) errors.push("Name is too long (120 characters at most)");
  const parsed = parseDefinition(input.definition);
  if (!parsed.ok) errors.push(...parsed.errors);
  if (!can(m.role, "reports.view")) errors.push("You do not have access to reports");
  if (errors.length || !parsed.ok) return { ok: false, errors };

  // Only members of this company can be shared with.
  let sharedUserIds = [...new Set(input.sharedUserIds ?? [])];
  if (sharedUserIds.length) {
    const members = await prisma.membership.findMany({ where: { organizationId: m.organizationId, userId: { in: sharedUserIds } }, select: { userId: true } });
    sharedUserIds = members.map((x) => x.userId);
  }
  const sharing = {
    visibility: input.visibility,
    sharedRoles: input.visibility === "ROLES" ? [...new Set(input.sharedRoles ?? [])] : [],
    sharedUserIds: input.visibility === "USERS" ? sharedUserIds : [],
    allowEdit: input.visibility === "PRIVATE" ? false : !!input.allowEdit,
  };
  if (sharing.visibility === "ROLES" && !sharing.sharedRoles.length) return { ok: false, errors: ["Pick at least one role to share with"] };
  if (sharing.visibility === "USERS" && !sharing.sharedUserIds.length) return { ok: false, errors: ["Pick at least one person to share with"] };
  const data = { name, description: input.description?.trim() || null, source: parsed.def.source, definition: parsed.def as unknown as Prisma.InputJsonValue, updatedById: m.userId };

  if (input.id) {
    const cur = await prisma.savedReport.findUnique({ where: { id: input.id } });
    if (!cur || !canEdit(cur, m)) return { ok: false, errors: ["You can't change this report. Save it as a copy instead."] };
    // Sharing settings stay with the owner (and admins); editors only change the layout.
    const share = canShare(cur, m) ? sharing : {};
    await prisma.savedReport.update({ where: { id: cur.id }, data: { ...data, ...share } });
    await audit(m, cur.id, "UPDATE", { name: cur.name, visibility: cur.visibility }, { name, ...share });
    return { ok: true, id: cur.id };
  }
  const created = await prisma.savedReport.create({ data: { ...data, ...sharing, organizationId: m.organizationId, ownerId: m.userId } });
  await audit(m, created.id, "CREATE", null, { name, visibility: sharing.visibility });
  return { ok: true, id: created.id };
}

export async function deleteReport(m: Member, id: string): Promise<{ ok: boolean; errors?: string[] }> {
  const cur = await prisma.savedReport.findUnique({ where: { id } });
  if (!cur || !canDelete(cur, m)) return { ok: false, errors: ["Only the owner or an administrator can delete this report"] };
  await prisma.savedReport.delete({ where: { id } });
  await audit(m, id, "DELETE", { name: cur.name }, null);
  return { ok: true };
}

async function audit(m: Member, id: string, action: string, before: unknown, after: unknown) {
  await prisma.auditLog.create({
    data: { organizationId: m.organizationId, userId: m.userId, entity: "SavedReport", entityId: id, action: `report.${action.toLowerCase()}`, before: (before ?? undefined) as Prisma.InputJsonValue | undefined, after: (after ?? undefined) as Prisma.InputJsonValue | undefined },
  }).catch(() => undefined);
}
