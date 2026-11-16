import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { formatPeso } from "@/lib/money";
import { fmtDate, parseDateParam, today } from "@/lib/format";
import { amortizationTable } from "@/lib/debt/service";

const BADGE = { PAID: "POSTED", PARTIAL: "DRAFT", OVERDUE: "BREACH", DUE: "PENDING_APPROVAL", UPCOMING: "VOID" } as const;

export default async function Amortization({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const asOf = parseDateParam((await searchParams).asOf, today());
  if (!(await prisma.loan.findFirst({ where: { id, organizationId: ctx.org.id } }))) notFound();
  const { loan, rows } = await amortizationTable(ctx.org.id, id, new Date(`${asOf}T00:00:00.000Z`));
  const sum = (k: "interest" | "principal" | "payment" | "eirInterest" | "amortization") => rows.reduce((s, r) => s + r[k], 0n);
  return (
    <>
      <div className="top"><h1>Amortization table · {loan.number}</h1>
        <form className="row noprint" style={{ flex: 0, flexWrap: "nowrap" }}><div><label>Status as of</label><input type="date" name="asOf" defaultValue={asOf} /></div><div style={{ flex: 0 }}><button>Show</button></div></form></div>
      <p>{loan.lender} · {Number(loan.interestRate)}% contract rate · effective rate {loan.effectiveRate ? `${Number(loan.effectiveRate).toFixed(4)}%` : "—"} · <Link className="noprint" href={`/debt/${id}`}>back to loan</Link></p>
      <p className="muted">Interest expense follows the effective interest method (PFRS 9): carrying amount × effective rate. The difference from the contract interest amortizes transaction costs. Rows before a drawdown or modification date are kept as they were; later rows are rebuilt.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>#</th><th>Period</th><th>Due date</th><th className="num">Opening principal</th><th className="num">Interest (contract)</th><th className="num">Principal</th><th className="num">Payment</th><th className="num">Closing principal</th>
          <th className="num">Opening carrying amt</th><th className="num">Interest expense (EIR)</th><th className="num">Cost amortization</th><th className="num">Closing carrying amt</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{i + 1}</td><td>{fmtDate(r.periodStart)}</td><td>{fmtDate(r.dueDate)}</td><td className="num">{formatPeso(r.openingPrincipal)}</td><td className="num">{formatPeso(r.interest)}</td>
              <td className="num">{formatPeso(r.principal)}</td><td className="num">{formatPeso(r.payment)}</td><td className="num">{formatPeso(r.closingPrincipal)}</td>
              <td className="num">{formatPeso(r.openingCarrying)}</td><td className="num">{formatPeso(r.eirInterest)}</td><td className="num">{formatPeso(r.amortization)}</td><td className="num">{formatPeso(r.closingCarrying)}</td>
              <td><span className={`badge ${BADGE[r.status]}`}>{r.status}{r.daysPastDue ? ` ${r.daysPastDue}d` : ""}</span>{r.status !== "PAID" && r.paid > 0n && <div className="muted">unpaid {formatPeso(r.unpaid)}</div>}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={13} className="muted">The schedule is generated when the drawdown is recorded.</td></tr>}
          {rows.length > 0 && <tr className="total"><td colSpan={4}>Total</td><td className="num">{formatPeso(sum("interest"))}</td><td className="num">{formatPeso(sum("principal"))}</td><td className="num">{formatPeso(sum("payment"))}</td><td /><td /><td className="num">{formatPeso(sum("eirInterest"))}</td><td className="num">{formatPeso(sum("amortization"))}</td><td /><td /></tr>}
        </tbody>
      </table></div>
    </>
  );
}
