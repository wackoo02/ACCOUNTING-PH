import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { ActionForm } from "@/components/ActionForm";
import { intercompanyTxn, reverseIntercompanyAction } from "../actions";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

export default async function Intercompany() {
  const ctx = await requireCtx("reports.view");
  const links = await prisma.intercompanyLink.findMany({ where: { organizationId: ctx.org.id }, include: { counterparty: true } });
  const cps = links.map((l) => l.counterparty).filter((o) => ctx.memberships.some((m) => m.organizationId === o.id));
  const [myAccts, theirAccts, entries] = await Promise.all([
    prisma.account.findMany({ where: { organizationId: ctx.org.id, isPostable: true, isActive: true }, orderBy: { code: "asc" } }),
    prisma.account.findMany({ where: { organizationId: { in: cps.map((o) => o.id) }, isPostable: true, isActive: true }, orderBy: { code: "asc" } }),
    prisma.journalEntry.findMany({ where: { organizationId: ctx.org.id, source: "INTERCOMPANY" }, orderBy: { date: "desc" }, take: 50, include: { reversedBy: true, lines: true } }),
  ]);
  // Reconciliation: my due from/to each counterparty vs their due to/from me.
  const recon = [];
  for (const l of links) {
    const theirs = await prisma.intercompanyLink.findUnique({ where: { organizationId_counterpartyOrgId: { organizationId: l.counterpartyOrgId, counterpartyOrgId: ctx.org.id } } });
    const bal = async (orgId: string, ids: string[]) => {
      const a = await prisma.journalLine.aggregate({ where: { organizationId: orgId, accountId: { in: ids }, journalEntry: { status: "POSTED" } }, _sum: { debit: true, credit: true } });
      return toCentavos(a._sum.debit?.toString() ?? "0") - toCentavos(a._sum.credit?.toString() ?? "0");
    };
    const mine = await bal(ctx.org.id, [l.dueFromAccountId, l.dueToAccountId]);
    const other = theirs ? await bal(l.counterpartyOrgId, [theirs.dueFromAccountId, theirs.dueToAccountId]) : 0n;
    recon.push({ name: l.counterparty.name, mine, other, diff: mine + other });
  }
  const opt = (a: { id: string; code: string; name: string }) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>;
  return (
    <>
      <div className="top"><h1>Intercompany Transactions</h1></div>
      {links.length === 0 ? (
        <div className="notice">Set up intercompany accounts first under <Link href="/entities">Entities and Intercompany</Link>.</div>
      ) : can(ctx.role, "journal.post") && (
        <ActionForm action={intercompanyTxn} className="card">
          <p style={{ marginTop: 0 }}>Records one transaction in both entities at once. The system adds the Due from / Due to lines and tags them for consolidation elimination.</p>
          <div className="row">
            <div><label>Posting date</label><input type="date" name="date" defaultValue={today()} required /></div>
            <div><label>Reference</label><input name="reference" /></div>
            <div style={{ flex: 3 }}><label>Description</label><input name="memo" required placeholder="e.g. Rent charged by parent for November" /></div>
            <div><label>Amount ({"PHP"})</label><input name="amount" className="num" required /></div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div><label>{ctx.org.name}: this entity&apos;s line is a</label><select name="fromSide" defaultValue="credit"><option value="credit">Credit (e.g. income earned / cash paid out)</option><option value="debit">Debit (e.g. expense / cash received)</option></select></div>
            <div style={{ flex: 2 }}><label>{ctx.org.name}: account</label><MasterPicker name="fromAccountId" ariaLabel="Account" required options={idOpts(myAccts.filter((a) => !a.ifrsGroup.startsWith("Due ")))} add={{ kind: "accounts" }} /></div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <div><label>Counterparty entity</label><MasterPicker name="toOrgId" ariaLabel="Counterparty entity" required options={cps.map((o) => ({ value: o.id, label: o.name }))} defaultValue={cps[0]?.id} /></div>
            <div style={{ flex: 2 }}><label>Counterparty&apos;s account (opposite side)</label><MasterPicker name="toAccountId" ariaLabel="Counterparty account" required options={cps.flatMap((o) => theirAccts.filter((a) => a.organizationId === o.id && !a.ifrsGroup.startsWith("Due ")).map((a) => ({ value: a.id, code: a.code, label: a.name, group: o.name })))} /></div>
            <div style={{ flex: 0 }}><button>Post in both entities</button></div>
          </div>
        </ActionForm>
      )}
      <h2>Intercompany reconciliation</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Counterparty</th><th className="num">Net per {ctx.org.name}</th><th className="num">Net per counterparty</th><th className="num">Difference</th></tr></thead>
        <tbody>{recon.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num">{formatPeso(r.mine)}</td><td className="num">{formatPeso(r.other)}</td><td className={`num ${r.diff === 0n ? "diff-ok" : "diff-bad"}`}>{r.diff === 0n ? "Matched ✓" : formatPeso(r.diff)}</td></tr>)}</tbody>
      </table></div>
      <h2>Recent intercompany entries</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Description</th><th className="num">Amount</th><th /></tr></thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}><td>{fmtDate(e.date)}</td><td><Link href={`/journals/${e.id}`}>{e.number}</Link></td><td>{e.memo}</td><td className="num">{formatPeso(toCentavos(e.totalDebit.toString()))}</td>
              <td>{e.reversedBy ? <span className="muted">Reversed</span> : can(ctx.role, "journal.void") && (
                <ActionForm action={reverseIntercompanyAction} confirm="Reverse this transaction in both entities?"><input type="hidden" name="groupId" value={e.intercompanyGroupId ?? ""} /><button className="danger">Reverse both sides</button></ActionForm>
              )}</td></tr>
          ))}
          {entries.length === 0 && <tr><td colSpan={5} className="muted">None yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
