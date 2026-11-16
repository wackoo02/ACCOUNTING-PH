import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { removeStatement } from "../../bank-actions";
import { UploadStatement } from "./UploadStatement";

export default async function Statements({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const banks = await prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id, isActive: true, kind: { in: ["CURRENT", "SAVINGS", "EWALLET"] } }, orderBy: { code: "asc" } });
  const sts = await prisma.bankStatement.findMany({ where: { organizationId: ctx.org.id, ...(sp.account ? { bankAccountId: sp.account } : {}) }, orderBy: [{ periodTo: "desc" }], include: { _count: { select: { lines: true } } }, take: 100 });
  const matched = await prisma.bankStatementLine.groupBy({ by: ["statementId"], where: { statementId: { in: sts.map((s) => s.id) }, matchId: { not: null } }, _count: true });
  const bank = new Map(banks.map((b) => [b.id, b]));
  return (
    <>
      <div className="top"><h1>Bank Statements</h1><a className="btn secondary" href="/api/bank/template">Download Excel template</a></div>
      <p className="muted">Fill in the template with your statement lines (date, description, check no., withdrawal or deposit, running balance), then upload it. Lines already uploaded are skipped, so overlapping statements are fine.</p>
      {can(ctx.role, "journal.create") && (banks.length ? <UploadStatement banks={banks.map((b) => ({ id: b.id, label: `${b.code} · ${b.name}` }))} defaultBank={sp.account} />
        : <div className="notice">Add a bank account first under <Link href="/masters/banks">Master Lists → Bank and Cash Accounts</Link>.</div>)}
      <div className="table-wrap"><table>
        <thead><tr><th>Bank account</th><th>Period</th><th>File</th><th className="num">Beginning</th><th className="num">Ending</th><th className="num">Lines</th><th className="num">Cleared</th><th>Status</th><th /></tr></thead>
        <tbody>
          {sts.map((s) => {
            const m = matched.find((x) => x.statementId === s.id)?._count ?? 0;
            return (
              <tr key={s.id}>
                <td>{bank.get(s.bankAccountId)?.code ?? "—"}</td><td>{fmtDate(s.periodFrom)} to {fmtDate(s.periodTo)}</td><td className="muted">{s.fileName}</td>
                <td className="num">{formatPeso(toCentavos(s.openingBalance.toString()))}</td><td className="num">{formatPeso(toCentavos(s.closingBalance.toString()))}</td>
                <td className="num">{s._count.lines}</td><td className="num">{m}</td>
                <td><span className={`badge ${s.status}`}>{s.status}</span></td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <Link href={`/bank/reconcile?account=${s.bankAccountId}`}>Match</Link> · <Link href={`/bank/reconcile/${s.id}`}>Reconciliation</Link>
                  {s.status === "OPEN" && m === 0 && can(ctx.role, "journal.post") && <ActionForm action={removeStatement} confirm="Delete this statement and its lines?" style={{ display: "inline" }}><input type="hidden" name="id" value={s.id} /> · <button className="link" style={{ color: "var(--danger)" }}>Delete</button></ActionForm>}
                </td>
              </tr>
            );
          })}
          {sts.length === 0 && <tr><td colSpan={9} className="muted">No statements uploaded yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
