import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso } from "@/lib/money";
import { fmtDate, parseDateParam, today } from "@/lib/format";
import { AGING_BUCKETS } from "@/lib/ar/compute";
import { customerStatement } from "@/lib/ar/reports";
import { defaultRecipients } from "@/lib/ar/email";
import { ActionForm } from "@/components/ActionForm";
import { PrintButton } from "@/components/PrintButton";
import { emailAction } from "../../ar-actions";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

type SP = Promise<Record<string, string | undefined>>;
const HREF = { INVOICE: (id: string) => `/receivables/${id}`, CREDIT_MEMO: (id: string) => `/receivables/${id}`, PAYMENT: (id: string) => `/receivables/collections/${id}` };
const TAG = { INVOICE: "SI", CREDIT_MEMO: "CM", PAYMENT: "OR" };

export default async function Statement({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const to = parseDateParam(sp.to, today());
  const from = parseDateParam(sp.from, `${to.slice(0, 7)}-01`);
  const customers = await prisma.customer.findMany({ where: { organizationId: ctx.org.id }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } });
  const st = sp.customer ? await customerStatement(ctx.org.id, sp.customer, new Date(from), new Date(to)) : null;
  const recipients = st ? (await defaultRecipients(ctx.org.id, st.customer.id)).join("; ") : "";
  return (
    <>
      <div className="top"><h1>Statement of Account</h1>{st && <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}><PrintButton /><a className="btn secondary" target="_blank" rel="noreferrer" href={`/api/receivables/pdf?type=statement&id=${st.customer.id}&from=${from}&to=${to}`}>PDF</a></div>}</div>
      <form className="card row noprint">
        <div style={{ flex: 2 }}><label>Customer</label><MasterPicker name="customer" ariaLabel="Customer" defaultValue={sp.customer ?? ""} required placeholder="Type to search…" options={idOpts(customers)} /></div>
        <div><label>From</label><input type="date" name="from" defaultValue={from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={to} /></div>
        <div style={{ flex: 0 }}><button>Show</button></div>
      </form>
      {st && <>
        <div className="card grid">
          <div><label>Customer</label><strong>{st.customer.name}</strong><div className="muted">{st.customer.code}{st.customer.tin ? ` · TIN ${st.customer.tin}` : ""}</div></div>
          <div><label>Period</label>{from} to {to}</div>
          <div><label>Terms / credit limit</label>{st.customer.paymentTermsDays} days · {formatPeso(BigInt(Math.round(Number(st.customer.creditLimit) * 100)))}</div>
          <div><label>Amount due ({st.customer.currencyCode})</label><strong>{formatPeso(st.closing)}</strong></div>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Document</th><th>Description</th><th>Due</th><th className="num">Charges</th><th className="num">Credits</th><th className="num">Balance</th></tr></thead>
          <tbody>
            <tr><td>{from}</td><td /><td><strong>Balance forward</strong></td><td /><td /><td /><td className="num">{formatPeso(st.opening)}</td></tr>
            {st.lines.map((l) => <tr key={`${l.type}${l.id}`}>
              <td>{fmtDate(l.date)}</td><td><Link href={HREF[l.type](l.id)}>{TAG[l.type]} {l.number}</Link></td><td>{l.description}</td><td>{l.dueDate ? fmtDate(l.dueDate) : ""}</td>
              <td className="num">{formatPeso(l.charges, { blankZero: true })}</td><td className="num">{formatPeso(l.credits, { blankZero: true })}</td><td className="num">{formatPeso(l.balance)}</td>
            </tr>)}
            <tr className="total"><td colSpan={6} className="num">Amount due</td><td className="num">{formatPeso(st.closing)}</td></tr>
          </tbody>
        </table></div>
        {st.aging && <>
          <h2>Aging of unpaid invoices as of {to}</h2>
          <div className="card row">{AGING_BUCKETS.map((b, k) => <div key={b} className="stat"><div className="l">{b === "Current" ? "Not yet due" : `${b} days`}</div><div className="n">{formatPeso(st.aging!.rows.filter((r) => r.bucket === k).reduce((s, r) => s + r.open, 0n))}</div></div>)}</div>
        </>}
        {can(ctx.role, "journal.create") && <ActionForm action={emailAction} className="card noprint">
          <input type="hidden" name="docType" value="STATEMENT" /><input type="hidden" name="id" value={st.customer.id} />
          <input type="hidden" name="from" value={from} /><input type="hidden" name="to" value={to} />
          <div className="row">
            <div style={{ flex: 3 }}><label>Email this statement to</label><input name="recipients" defaultValue={recipients} required /></div>
            <div style={{ flex: 3 }}><label>Message (optional)</label><input name="note" placeholder="e.g. Kindly settle the overdue invoices this week." /></div>
            <div style={{ flex: 0 }}><button>Send PDF</button></div>
          </div>
        </ActionForm>}
      </>}
    </>
  );
}
