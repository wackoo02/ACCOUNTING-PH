import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { previewDepreciation } from "@/lib/assets/service";
import { idxLabel } from "@/lib/assets/depreciation";
import { ActionForm } from "@/components/ActionForm";
import { depreciationAction } from "../../asset-actions";

type SP = Promise<Record<string, string | undefined>>;

export default async function Depreciation({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const runs = await prisma.depreciationRun.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ year: "desc" }, { month: "desc" }, { createdAt: "desc" }], take: 36 });
  const lastPosted = runs.find((r) => r.status === "POSTED");
  const now = new Date();
  const nextIdx = lastPosted ? lastPosted.year * 12 + lastPosted.month : now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
  const period = sp.period && /^\d{4}-\d{2}$/.test(sp.period) ? sp.period : idxLabel(nextIdx);
  const [y, m] = period.split("-").map(Number);
  const pv = await previewDepreciation(ctx.org.id, y, m);
  const jes = new Map((await prisma.journalEntry.findMany({ where: { id: { in: runs.map((r) => r.journalEntryId).filter(Boolean) as string[] } }, select: { id: true, number: true } })).map((j) => [j.id, j.number]));
  const post = can(ctx.role, "journal.post");
  const already = lastPosted && lastPosted.year * 12 + lastPosted.month - 1 >= y * 12 + m - 1;
  return (
    <>
      <div className="top"><h1>Monthly depreciation</h1></div>
      <p className="muted">Run once a month, after the month&apos;s additions and disposals are in. It posts one journal (source Fixed Assets) dated the last day of the month: Dr depreciation expense by department and cost center, Cr accumulated depreciation. Months an asset missed (for example, added late with an earlier date) are caught up in the same run.</p>
      <form className="card row noprint" style={{ alignItems: "end" }}>
        <div><label>Month</label><input type="month" name="period" defaultValue={period} /></div>
        <div style={{ flex: 0 }}><button className="secondary">Preview</button></div>
        {lastPosted && <div className="muted">Last run: {idxLabel(lastPosted.year * 12 + lastPosted.month - 1)} ({lastPosted.number})</div>}
      </form>

      <div className="card">
        <div className="top" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>{period}: {pv.rows.length} asset{pv.rows.length === 1 ? "" : "s"}, total {formatPeso(pv.total)}</h3>
          {post && !already && pv.rows.length > 0 && (
            <ActionForm action={depreciationAction} confirm={`Post depreciation of ${formatPeso(pv.total)} for ${period}?`}>
              <input type="hidden" name="op" value="run" /><input type="hidden" name="period" value={period} />
              <button>Post depreciation for {period}</button>
            </ActionForm>
          )}
        </div>
        {already && <div className="notice">Depreciation already ran for {period} or a later month.</div>}
        <div className="table-wrap"><table>
          <thead><tr><th>Asset</th><th>Description</th><th>Department / cost center</th><th>Expense / accum. account</th><th>Months</th><th className="num">Depreciation</th></tr></thead>
          <tbody>
            {pv.rows.map((r) => (
              <tr key={r.asset.id}>
                <td><Link href={`/assets/${r.asset.id}`}>{r.asset.code}</Link></td><td>{r.asset.name}</td>
                <td>{r.asset.departmentCode ?? "—"} / {r.asset.costCenterCode ?? "—"}</td>
                <td>{r.asset.depExpenseAccountCode} / {r.asset.accumDepAccountCode}</td>
                <td>{r.months.length > 1 ? `${r.months[0].period} to ${r.months.at(-1)!.period} (catch-up)` : r.months[0]?.period}</td>
                <td className="num">{formatPeso(r.amount)}</td>
              </tr>
            ))}
            {pv.rows.length === 0 && <tr><td colSpan={6} className="muted">Nothing to depreciate for this month.</td></tr>}
            {pv.rows.length > 0 && <tr className="total"><td colSpan={5}>Total</td><td className="num">{formatPeso(pv.total)}</td></tr>}
          </tbody>
        </table></div>
      </div>

      {pv.skipped.length > 0 && <div className="card">
        <h3 style={{ marginTop: 0 }}>Not depreciated: setup incomplete ({pv.skipped.length})</h3>
        <ul>{pv.skipped.map((s) => <li key={s.asset.id}><Link href={`/assets/${s.asset.id}`}>{s.asset.code}</Link> {s.asset.name}: {s.reason}</li>)}</ul>
        <p className="muted">Fix these under <Link href="/masters/assets">Master Lists → Fixed Asset Register</Link> (set a category, or the life and accounts).</p>
      </div>}

      <h2>Runs</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Run</th><th>Month</th><th className="num">Assets</th><th className="num">Total</th><th>Journal</th><th>Status</th><th /></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{r.number}</td><td>{idxLabel(r.year * 12 + r.month - 1)}</td><td className="num">{r.assetCount}</td><td className="num">{formatPeso(toCentavos(r.total.toString()))}</td>
              <td>{r.journalEntryId ? <Link href={`/journals/${r.journalEntryId}`}>{jes.get(r.journalEntryId)}</Link> : ""}</td>
              <td><span className={`badge ${r.status === "POSTED" ? "POSTED" : "VOID"}`}>{r.status}</span></td>
              <td>{post && r.id === lastPosted?.id && (
                <ActionForm action={depreciationAction} confirm={`Undo ${r.number}? Its journal is reversed and the assets go back to their previous balances.`}>
                  <input type="hidden" name="op" value="undo" /><input type="hidden" name="runId" value={r.id} /><button className="secondary">Undo</button>
                </ActionForm>
              )}</td>
            </tr>
          ))}
          {runs.length === 0 && <tr><td colSpan={7} className="muted">No runs yet.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
