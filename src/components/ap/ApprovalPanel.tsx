// Server component: the approval route of a document and who has approved so far.
import { approvalHistory, canApproveNow, type DocType } from "@/lib/approvals";
import { ROLE_LABELS } from "@/lib/permissions";
import { prisma } from "@/lib/db";

export async function approvalInfo(organizationId: string, docType: DocType, docId: string, userId: string, total: bigint, preparerIds: (string | null)[]) {
  const r = await canApproveNow(organizationId, docType, docId, userId, total, preparerIds);
  return r;
}

export async function ApprovalPanel({ organizationId, docType, docId, total, preparerIds, userId, status }: { organizationId: string; docType: DocType; docId: string; total: bigint; preparerIds: (string | null)[]; userId: string; status: string }) {
  const [info, history] = await Promise.all([canApproveNow(organizationId, docType, docId, userId, total, preparerIds), approvalHistory(organizationId, docType, docId)]);
  const userIds = info.state.levels.flatMap((l) => l.rules.map((r) => r.approverUserId)).filter(Boolean) as string[];
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...userIds, ...info.state.approved.map((a) => a.userId)] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const waiting = status === "PENDING_APPROVAL";
  return (
    <div className="card noprint">
      <strong>Approval route</strong>
      <ol style={{ margin: "6px 0 0", paddingLeft: 20 }}>
        {info.state.levels.map((l) => {
          const done = info.state.approved.find((a) => a.level === l.level);
          const who = l.isDefault ? "an accountant, administrator or owner (within approval limit)" : l.rules.map((r) => (r.approverUserId ? users.get(r.approverUserId) ?? "named person" : r.approverRole ? ROLE_LABELS[r.approverRole] : "")).join(" or ");
          return <li key={l.level}>{l.name}: {who} — {done ? <span className="diff-ok">approved by {users.get(done.userId)} {done.at.toISOString().slice(0, 10)}</span> : waiting && info.state.next?.level === l.level ? <strong>waiting</strong> : <span className="muted">pending</span>}</li>;
        })}
      </ol>
      {waiting && !info.ok && <div className="muted" style={{ marginTop: 6 }}>You cannot approve the current level: {info.why}.</div>}
      {history.some((h) => h.decision === "RETURNED") && <div className="muted" style={{ marginTop: 6 }}>Returned before: {history.filter((h) => h.decision === "RETURNED").map((h) => `${h.userName} (${h.comment})`).join("; ")}</div>}
    </div>
  );
}
