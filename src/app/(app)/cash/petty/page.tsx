import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { formatPeso, toCentavos } from "@/lib/money";
import { fmtDate, today } from "@/lib/format";
import { bookBalance, unreplenished } from "@/lib/bank/cash";
import { ActionForm } from "@/components/ActionForm";
import { replenishAction } from "../../bank-actions";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

export default async function PettyCash() {
  const ctx = await requireCtx("reports.view");
  const [funds, banks] = await Promise.all([
    prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id, kind: "PETTY_CASH" }, orderBy: { code: "asc" } }),
    prisma.bankAccount.findMany({ where: { organizationId: ctx.org.id, kind: { in: ["CURRENT", "SAVINGS"] }, isActive: true }, orderBy: { code: "asc" } }),
  ]);
  const data = await Promise.all(funds.map(async (f) => ({ f, bal: await bookBalance(ctx.org.id, f.glAccountId), pcvs: await unreplenished(ctx.org.id, f.id) })));
  const create = can(ctx.role, "journal.create");
  return (
    <>
      <div className="top"><h1>Petty Cash</h1>{create && <Link className="btn" href="/cash/new?type=PETTY">New petty cash voucher</Link>}</div>
      <p className="muted">Imprest system: each fund has a fixed amount. Petty cash vouchers are expensed when approved. Replenishing creates one transfer from the bank for the total of the vouchers not yet replenished, so cash on hand + unreplenished vouchers = the fund amount.</p>
      {funds.length === 0 && <div className="notice">Add a petty cash fund (kind PETTY_CASH, GL account 1015) under <Link href="/masters/banks">Master Lists → Bank and Cash Accounts</Link>, then fund it with a fund transfer.</div>}
      {data.map(({ f, bal, pcvs }) => {
        const spent = pcvs.reduce((s, p) => s + toCentavos(p.amount.toString()), 0n);
        const limit = toCentavos(f.fundLimit.toString());
        const short = limit - bal - spent;
        return (
          <div className="card" key={f.id}>
            <h2 style={{ marginTop: 0 }}>{f.code} · {f.name}{f.custodian ? <span className="muted"> · custodian {f.custodian}</span> : null}</h2>
            <div className="grid">
              <div className="stat"><div className="l">Fund amount</div><div className="n">{formatPeso(limit)}</div></div>
              <div className="stat"><div className="l">Cash on hand (per books)</div><div className="n">{formatPeso(bal)}</div></div>
              <div className="stat"><div className="l">Vouchers to replenish</div><div className="n">{formatPeso(spent)}</div></div>
              <div className="stat"><div className="l">{short === 0n ? "Fund is complete" : short > 0n ? "Unaccounted (shortage)" : "Over the fund amount"}</div><div className={`n ${short === 0n ? "diff-ok" : "diff-bad"}`}>{formatPeso(short < 0n ? -short : short)}</div></div>
            </div>
            {pcvs.length > 0 && <div className="table-wrap" style={{ marginTop: 10 }}><table>
              <thead><tr><th>Date</th><th>Voucher</th><th>Payee</th><th>Particulars</th><th className="num">Amount</th></tr></thead>
              <tbody>{pcvs.map((p) => <tr key={p.id}><td>{fmtDate(p.date)}</td><td><Link href={`/cash/${p.id}`}>{p.number}</Link></td><td>{p.payee}</td><td>{p.memo}</td><td className="num">{formatPeso(toCentavos(p.amount.toString()))}</td></tr>)}</tbody>
            </table></div>}
            {create && pcvs.length > 0 && (
              <ActionForm action={replenishAction} className="row noprint" style={{ marginTop: 10 }}>
                <input type="hidden" name="fundId" value={f.id} />
                <div className="row">
                  <div><label>Replenish from</label><MasterPicker name="fromBankAccountId" ariaLabel="Replenish from" required options={idOpts(banks)} add={{ kind: "banks" }} defaultValue={banks[0]?.id} /></div>
                  <div><label>Date</label><input type="date" name="date" defaultValue={today()} /></div>
                  <div><label>Method</label><select name="method" defaultValue="CHECK"><option value="CHECK">Check</option><option value="BANK_TRANSFER">Bank transfer</option><option value="CASH">Cash withdrawal</option></select></div>
                  <div><label>Check no. (blank = next)</label><input name="checkNo" /></div>
                  <div style={{ flex: 0 }}><button>Create replenishment for {formatPeso(spent)}</button></div>
                </div>
              </ActionForm>
            )}
          </div>
        );
      })}
    </>
  );
}
