import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ACTION_LABELS, diffFields } from "@/lib/audit-view";

type SP = Promise<Record<string, string | undefined>>;

export default async function Audit({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("org.manage");
  const sp = await searchParams;
  const where: Prisma.AuditLogWhereInput = { organizationId: ctx.org.id };
  if (sp.entity) where.entity = sp.entity;
  if (sp.user) where.userId = sp.user;
  if (sp.from || sp.to) where.createdAt = { ...(sp.from ? { gte: new Date(sp.from) } : {}), ...(sp.to ? { lte: new Date(sp.to + "T23:59:59Z") } : {}) };
  const [logs, members, entities] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: 300 }),
    prisma.membership.findMany({ where: { organizationId: ctx.org.id }, include: { user: true } }),
    prisma.auditLog.findMany({ where: { organizationId: ctx.org.id }, distinct: ["entity"], select: { entity: true } }),
  ]);
  const who = (id: string | null) => members.find((m) => m.userId === id)?.user.name ?? "System";
  return (
    <>
      <div className="top"><h1>Audit Trail</h1><span className="muted">Every create, edit, approval, reversal and setting change, with before/after values</span></div>
      <form className="card row noprint">
        <div><label>Record type</label><select name="entity" defaultValue={sp.entity ?? ""}><option value="">All</option>{entities.map((e) => <option key={e.entity}>{e.entity}</option>)}</select></div>
        <div><label>User</label><select name="user" defaultValue={sp.user ?? ""}><option value="">All</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.user.name}</option>)}</select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={sp.from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={sp.to} /></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>When (UTC)</th><th>User</th><th>Action</th><th>Record</th><th>Changes (before → after)</th></tr></thead>
        <tbody>
          {logs.map((l) => {
            const ch = diffFields(l.before, l.after).filter((c) => !["lines", "attachments"].includes(c.field)).slice(0, 12);
            return (
              <tr key={l.id}>
                <td style={{ whiteSpace: "nowrap" }}>{l.createdAt.toISOString().slice(0, 19).replace("T", " ")}</td>
                <td>{who(l.userId)}</td><td>{ACTION_LABELS[l.action] ?? l.action}</td>
                <td>{l.entity === "journal" ? <Link href={`/journals/${l.entityId}`}>{(l.details as Record<string, string> | null)?.number ?? "entry"}</Link> : `${l.entity} ${l.entityId}`}</td>
                <td style={{ fontSize: 12 }}>
                  {ch.map((c) => <div key={c.field}><b>{c.field}</b>: <span className="muted">{c.from || "(blank)"}</span> → {c.to || "(blank)"}</div>)}
                  {!ch.length && l.details ? <span className="muted">{JSON.stringify(l.details)}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </>
  );
}
