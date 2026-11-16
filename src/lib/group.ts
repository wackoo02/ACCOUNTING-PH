import { prisma } from "./db";

/** Entities the user can see, arranged as a tree (root entities first, children indented). */
export async function entityTree(userId: string) {
  const ms = await prisma.membership.findMany({ where: { userId }, include: { organization: true } });
  const orgs = ms.map((m) => ({ ...m.organization, role: m.role }));
  const ids = new Set(orgs.map((o) => o.id));
  const out: ((typeof orgs)[number] & { depth: number })[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const o of orgs.filter((x) => (parentId ? x.parentId === parentId : !x.parentId || !ids.has(x.parentId))).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ ...o, depth });
      walk(o.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The entity plus all its descendants the user belongs to. */
export async function groupOf(userId: string, rootId: string) {
  const tree = await entityTree(userId);
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of tree) if (o.parentId && out.has(o.parentId) && !out.has(o.id)) { out.add(o.id); grew = true; }
  }
  return tree.filter((o) => out.has(o.id));
}
