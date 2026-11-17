import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate } from "@/lib/format";
import { cashTypeLabel } from "@/lib/bank/cash";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

type SP = Promise<Record<string, string | undefined>>;

export default async function CashList({ searchParams }: { searchParams: SP }) {
  const ctx = await requireCtx("reports.view");
  const sp = await searchParams;
  const where: Prisma.CashTransactionWhereInput = { organizationId: ctx.org.id };
  if (sp.status) where.status = sp.status;
  if (sp.type === "PETTY") where.number = { startsWith: "PCV" };
  else if (sp.type) where.type = sp.type;
  if (sp.bank) where.OR = [{ bankAccountId: sp.bank }, { toBankAccountId: sp.bank }];
  if (sp.q) where.AND = [{ OR: [{ number: { contains: sp.q, mode: "insensitive" } }, { payee: { contains: sp.q, mode: "insensitive" } }, { memo: { contains: sp.q, mode: "insensitive" } }, { reference: { contains: sp.q, mode: "insensitive" } }, { checkNo: { contains: sp.q } }] }];
  if (sp.from || sp.to) where.date = { ...(sp.from ? { gte: new Date(sp.from) } : {}), ...(sp.to ? { lte: new Date(sp.to) } : {}) };
  const [rows, banks] = await Promise.all([
    prisma.cashTransaction.findMany({ where, orderBy: [{ date: "desc" }, { number: "desc" }], take: 300 }),
    prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id }, orderBy: { code: "asc" } }),
  ]);
  const bank = new Map(banks.map((b) => [b.id, b]));
  const create = can(ctx.role, "journal.create");
  return (
    <>
      <div className="top"><h1>Cash Receipts and Disbursements</h1>
        {create && <div className="row noprint" style={{ gap: 8, flex: 0, flexWrap: "nowrap" }}>
          <Link className="btn" href="/cash/new?type=RECEIPT">New receipt</Link>
          <Link className="btn" href="/cash/new?type=DISBURSEMENT">New disbursement</Link>
          <Link className="btn secondary" href="/cash/new?type=PETTY">Petty cash voucher</Link>
          <Link className="btn secondary" href="/cash/new?type=TRANSFER">Fund transfer</Link>
        </div>}
      </div>
      {banks.length === 0 && <div className="notice">Set up your bank and cash accounts first under <Link href="/masters/banks">Master Lists → Bank and Cash Accounts</Link>.</div>}
      <form className="card row noprint">
        <div><label>Search</label><input name="q" defaultValue={sp.q} placeholder="No., payee, check no., particulars" /></div>
        <div><label>Type</label><select name="type" defaultValue={sp.type ?? ""}><option value="">All</option><option value="RECEIPT">Receipts</option><option value="DISBURSEMENT">Disbursements</option><option value="PETTY">Petty cash vouchers</option><option value="TRANSFER">Transfers</option></select></div>
        <div><label>Account</label><MasterPicker name="bank" ariaLabel="Account" defaultValue={sp.bank ?? ""} emptyLabel="All" placeholder="All" options={idOpts(banks)} /></div>
        <div><label>Status</label><select name="status" defaultValue={sp.status ?? ""}><option value="">All</option><option>DRAFT</option><option value="PENDING_APPROVAL">FOR APPROVAL</option><option>POSTED</option><option>VOID</option></select></div>
        <div><label>From</label><input type="date" name="from" defaultValue={sp.from} /></div>
        <div><label>To</label><input type="date" name="to" defaultValue={sp.to} /></div>
        <div style={{ flex: 0 }}><button>Filter</button></div>
      </form>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>No.</th><th>Type</th><th>Account</th><th>Payee / payor</th><th>Particulars</th><th>Check no.</th><th>Status</th><th className="num">Receipts</th><th className="num">Payments</th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const amt = toCentavos(r.amount.toString());
            const b = bank.get(r.bankAccountId);
            return (
              <tr key={r.id}>
                <td>{fmtDate(r.date)}</td><td><Link href={`/cash/${r.id}`}>{r.number}</Link></td><td>{cashTypeLabel(r)}</td>
                <td>{b?.code}{r.toBankAccountId ? ` → ${bank.get(r.toBankAccountId)?.code}` : ""}</td><td>{r.payee}</td><td>{r.memo}</td><td>{r.checkNo}</td>
                <td><span className={`badge ${r.status}`}>{r.status === "PENDING_APPROVAL" ? "FOR APPROVAL" : r.status}</span></td>
                <td className="num">{r.type === "RECEIPT" ? `${r.currencyCode !== "PHP" ? r.currencyCode + " " : ""}${formatPeso(amt)}` : ""}</td>
                <td className="num">{r.type !== "RECEIPT" ? `${r.currencyCode !== "PHP" ? r.currencyCode + " " : ""}${formatPeso(amt)}` : ""}</td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={10} className="muted">No vouchers found.</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}
