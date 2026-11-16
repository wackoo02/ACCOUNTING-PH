import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fiscalYearOf, fiscalYearRange } from "@/lib/ledger/service";
import { ActionForm } from "@/components/ActionForm";
import { fiscalYearAction, togglePeriod } from "../actions";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function Periods({ searchParams }: { searchParams: Promise<{ fy?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: ctx.org.id } });
  const fy = Number((await searchParams).fy) || fiscalYearOf(org.fiscalYearStartMonth, new Date());
  const { start, end } = fiscalYearRange(org.fiscalYearStartMonth, fy);
  const months: { year: number; month: number }[] = [];
  for (let d = new Date(start); d <= end; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  const [periods, fyRec, pending] = await Promise.all([
    prisma.fiscalPeriod.findMany({ where: { organizationId: ctx.org.id, OR: months.map((m) => ({ year: m.year, month: m.month })) } }),
    prisma.fiscalYear.findUnique({ where: { organizationId_year: { organizationId: ctx.org.id, year: fy } } }),
    prisma.journalEntry.count({ where: { organizationId: ctx.org.id, status: { in: ["DRAFT", "PENDING_APPROVAL"] }, date: { gte: start, lte: end } } }),
  ]);
  const allowed = can(ctx.role, "period.close");
  const closed = fyRec?.status === "CLOSED";
  const range = `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`;
  return (
    <>
      <div className="top"><h1>Fiscal Year {fy} <span className={`badge ${closed ? "CLOSED" : "OPEN"}`}>{closed ? "CLOSED" : "OPEN"}</span></h1>
        <div className="row" style={{ flex: 0, gap: 8, flexWrap: "nowrap" }}><a className="btn secondary" href={`?fy=${fy - 1}`}>← FY{fy - 1}</a><a className="btn secondary" href={`?fy=${fy + 1}`}>FY{fy + 1} →</a></div></div>
      <p className="muted">{range}. The fiscal year start month is set in Company Settings. <b>Open</b>: posting allowed. <b>Closed</b>: month-end close, can be reopened. <b>Locked</b>: locked by year-end closing.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Period</th><th>Status</th><th>Closed on</th><th /></tr></thead>
        <tbody>
          {months.map(({ year, month }, i) => {
            const p = periods.find((x) => x.year === year && x.month === month);
            const status = p?.status ?? "OPEN";
            return (
              <tr key={`${year}-${month}`}>
                <td>P{i + 1} · {MONTHS[month - 1]} {year}</td><td><span className={`badge ${status === "LOCKED" ? "VOID" : status}`}>{status}</span></td>
                <td>{p?.closedAt?.toISOString().slice(0, 10) ?? ""}</td>
                <td>{allowed && status !== "LOCKED" && (
                  <ActionForm action={togglePeriod}>
                    <input type="hidden" name="period" value={`${year}-${month}`} />
                    <input type="hidden" name="status" value={status === "OPEN" ? "CLOSED" : "OPEN"} />
                    <button className="secondary">{status === "OPEN" ? "Close month" : "Reopen"}</button>
                  </ActionForm>
                )}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      <h2>Year-end closing</h2>
      <div className="card">
        {closed ? (
          <>
            <p>FY{fy} was closed on {fyRec?.closedAt?.toISOString().slice(0, 10)}. Income and expense balances were moved to Retained Earnings and every month is locked.</p>
            {ctx.role === "OWNER" && (
              <ActionForm action={fiscalYearAction} confirm={`Reopen FY${fy}? The closing entry will be reversed.`}>
                <input type="hidden" name="year" value={fy} /><input type="hidden" name="op" value="reopen" />
                <button className="danger">Reopen FY{fy} (owner only)</button>
              </ActionForm>
            )}
          </>
        ) : (
          <>
            <p>Closing the year transfers every income and expense account balance for {range} to Retained Earnings with a closing entry dated {end.toISOString().slice(0, 10)}, then locks all twelve months. Close earlier years first.</p>
            {pending > 0 && <div className="errors">{pending} draft or unapproved entr{pending === 1 ? "y" : "ies"} in this year must be posted or voided first.</div>}
            {allowed && (
              <ActionForm action={fiscalYearAction} confirm={`Close FY${fy}? All its months will be locked.`}>
                <input type="hidden" name="year" value={fy} /><input type="hidden" name="op" value="close" />
                <button disabled={pending > 0}>Close FY{fy}</button>
              </ActionForm>
            )}
          </>
        )}
      </div>
    </>
  );
}
