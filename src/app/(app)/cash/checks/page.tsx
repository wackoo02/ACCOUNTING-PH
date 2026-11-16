import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, parseDateParam, today } from "@/lib/format";

// A check is stale after six months from its date (PH banking practice).
const STALE_DAYS = 180;

export default async function Checks({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const asOf = new Date(parseDateParam(sp.asOf, today()));
  const banks = await prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id, kind: { in: ["CURRENT", "SAVINGS"] } }, orderBy: { code: "asc" } });
  const checks = await prisma.cashTransaction.findMany({
    where: { organizationId: ctx.org.id, method: "CHECK", type: { not: "RECEIPT" }, ...(sp.bank ? { bankAccountId: sp.bank } : {}) },
    orderBy: [{ bankAccountId: "asc" }, { checkNo: "asc" }],
  });
  const lines = await prisma.journalLine.findMany({ where: { journalEntryId: { in: checks.map((c) => c.journalEntryId).filter(Boolean) as string[] }, accountId: { in: banks.map((b) => b.glAccountId) } } });
  const clearedOf = (c: (typeof checks)[number]) => lines.find((l) => l.journalEntryId === c.journalEntryId)?.clearedAt ?? null;
  const status = (c: (typeof checks)[number]) => {
    if (c.status === "VOID") return "Void";
    if (c.status !== "POSTED") return c.status === "DRAFT" ? "Draft" : "For approval";
    const cl = clearedOf(c);
    if (cl && cl <= asOf) return "Cleared";
    const age = Math.round((asOf.getTime() - (c.checkDate ?? c.date).getTime()) / 86_400_000);
    if (age > STALE_DAYS) return "Stale";
    return c.checkReleasedAt ? "Outstanding" : "Unreleased";
  };
  const want = sp.status ?? "";
  const rows = checks.map((c) => ({ c, s: status(c), cl: clearedOf(c) })).filter((r) => !want || r.s === want);
  const bank = new Map(banks.map((b) => [b.id, b]));
  const total = (s: string) => checks.filter((c) => status(c) === s).reduce((t, c) => t + toCentavos(c.amount.toString()), 0n);
  return (
    <>
      <div className="top"><h1>Check Monitoring</h1></div>
      <p className="muted">Every check issued, by number. <b>Unreleased</b>: approved but still with the company. <b>Outstanding</b>: released, not yet cleared by the bank. <b>Stale</b>: more than six months old and not cleared; consider voiding and re-issuing. Clearing comes from the bank reconciliation.</p>
      <div className="grid" style={{ marginBottom: 12 }}>
        {["Unreleased", "Outstanding", "Stale", "Cleared"].map((s) => <div key={s} className="card stat"><div className="l">{s}</div><div className="n">{formatPeso(total(s))}</div></div>)}
      </div>
      <form className="card row noprint">
        <div><label>Bank account</label><select name="bank" defaultValue={sp.bank ?? ""}><option value="">All</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</select></div>
        <div><label>Status</label><select name="status" defaultValue={want}><option value="">All</option>{["Draft", "For approval", "Unreleased", "Outstanding", "Stale", "Cleared", "Void"].map((s) => <option key={s}>{s}</option>)}</select></div>
        <div><label>As of</label><input type="date" name="asOf" defaultValue={fmtDate(asOf)} /></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Bank</th><th>Check no.</th><th>Check date</th><th>Voucher</th><th>Payee</th><th>Particulars</th><th>Released</th><th>Cleared</th><th>Status</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {rows.map(({ c, s, cl }) => (
            <tr key={c.id}>
              <td>{bank.get(c.bankAccountId)?.code}</td><td>{c.checkNo}</td><td>{fmtDate(c.checkDate ?? c.date)}</td><td><Link href={`/cash/${c.id}`}>{c.number}</Link></td>
              <td>{c.payee}</td><td>{c.memo}</td><td>{c.checkReleasedAt ? fmtDate(c.checkReleasedAt) : ""}</td><td>{cl ? fmtDate(cl) : ""}</td>
              <td><span className={`badge ${s === "Cleared" ? "POSTED" : s === "Void" ? "VOID" : s === "Stale" ? "DRAFT" : "PENDING_APPROVAL"}`}>{s}</span></td>
              <td className="num">{formatPeso(toCentavos(c.amount.toString()))}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={10} className="muted">No checks.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
