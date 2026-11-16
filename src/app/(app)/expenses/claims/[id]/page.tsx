import Link from "next/link";
import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { getVoucher, isManagerOf, reviewChecks } from "@/lib/pettycash/service";
import { DETAIL_FIELDS, MODULES, PAYMENTS, PROVIDERS, txType, type Check, type ModuleKey, type PaymentKey } from "@/lib/expense/catalog";
import { Icon } from "@/components/Icon";
import { ActionForm } from "@/components/ActionForm";
import { MODULE_ICON, StatusBadge, peso } from "@/components/ExpenseUi";
import { claimDecisionAction } from "../../../expense-actions";

const STEPS = ["Captured", "Manager", "Finance", "Posted", "Paid"];
function stepOf(status: string, employeePaid: boolean) {
  if (["DRAFT", "RETURNED"].includes(status)) return 0;
  if (status === "SUBMITTED") return 1;
  if (["APPROVED", "HOLD"].includes(status)) return 2;
  if (status === "CLEARED" || status === "BATCHED") return employeePaid ? 4 : 3;
  return 5;
}

function Checks({ title, checks }: { title: string; checks: Check[] }) {
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <ul className="checks">
        {checks.map((c) => <li key={c.key} className={c.ok ? "ok" : c.level}><span className="dot">{c.ok ? "✓" : c.level === "block" ? "!" : "•"}</span><span><b>{c.label}</b><br /><span className="muted">{c.note}</span></span></li>)}
      </ul>
    </div>
  );
}

export default async function Claim({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("reports.view");
  const { id } = await params;
  const v = await getVoucher(ctx.org.id, id);
  const m = v.module as ModuleKey;
  const saved = (v.checks ?? {}) as { manager?: Check[]; finance?: Check[] };
  const isFinance = can(ctx.role, "expense.finance");
  const financeNow = isFinance && ["APPROVED", "HOLD"].includes(v.status) ? await reviewChecks(ctx.org.id, id) : saved.finance;
  const manager = v.status === "SUBMITTED" && await prisma.$transaction((tx) => isManagerOf(tx, ctx.org.id, ctx.user.id, v.employee?.id ?? null));
  const step = stepOf(v.status, v.paymentMethod === "EMPLOYEE");
  const accounts = await prisma.account.findMany({ where: { id: { in: v.lines.map((l) => l.accountId).filter(Boolean) as string[] } } });
  const acct = new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`]));
  const details = (v.details ?? {}) as Record<string, unknown>;
  const providerName = v.provider ? PROVIDERS[m].find((p) => p.key === v.provider)?.name ?? v.provider : null;
  const rows: [string, React.ReactNode][] = [
    ["Employee", v.employee ? `${v.employee.name} (${v.employee.code})${v.employee.department ? ` · ${v.employee.department}` : ""}` : "Petty cash fund"],
    ["Business purpose", v.purpose ?? "Not given"],
    ["Type", txType(v.transactionType)?.label ?? "General"],
    ...(providerName ? [["Provider", providerName] as [string, string]] : []),
    ...(v.bookingNumber ? [["Booking / order no.", v.bookingNumber] as [string, string]] : []),
    ...DETAIL_FIELDS[m].filter((f) => details[f.key] !== undefined && details[f.key] !== "").map((f) => [f.label, String(details[f.key])] as [string, string]),
    ["Paid by", `${PAYMENTS[v.paymentMethod as PaymentKey].label}${v.paymentAccount ? ` · ${v.paymentAccount.code} ${v.paymentAccount.name}` : ""}${v.fund ? ` · ${v.fund.code}` : ""}`],
    ["Receipt", v.noReceipt ? `None${v.noReceiptReason ? ` (${v.noReceiptReason})` : ""}` : `${v.docType} ${v.docNumber ?? ""} · ${v.vendor.name}`],
    ["Supplier TIN", `${v.vendor.tin || "None"} · ${v.vendor.vatRegistered ? "VAT" : "Non-VAT"}`],
    ...(v.currencyCode && v.foreignTotal ? [["Foreign amount", `${v.currencyCode} ${v.foreignTotal} at ${v.fxRate}`] as [string, string]] : []),
    ["Prepared by", v.createdBy ?? ""],
    ...(v.approvedBy ? [["Manager approval", `${v.approvedBy}${v.approvedAt ? ` · ${new Date(v.approvedAt).toISOString().slice(0, 10)}` : ""}`] as [string, string]] : []),
    ...(v.financeBy ? [["Finance", `${v.financeBy}${v.financeNote ? ` · ${v.financeNote}` : ""}`] as [string, string]] : []),
    ...(v.journal ? [["Journal entry", <Link key="je" href={`/journals/${v.journal.id}`}>{v.journal.number}</Link>] as [string, React.ReactNode]] : []),
  ];
  return (
    <>
      <div className="crumbs"><Link href="/expenses/claims">Claims</Link> / {v.number}</div>
      <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}><Icon name={MODULE_ICON[m]} size={24} />{v.number} <StatusBadge status={v.status} /></h1>
      <div className="steps">{STEPS.map((s, i) => <span key={s} className={i < step ? "done" : i === step ? "now" : ""}>{s}</span>)}</div>
      {v.rejectedReason && <div className="notice">{v.status === "REJECTED" ? "Rejected: " : v.status === "HOLD" ? "On hold: " : "Returned: "}{v.rejectedReason}</div>}
      {v.warnings.length > 0 && <div className="notice">{v.warnings.join(" ")}</div>}
      <div className="grid2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{MODULES[m].label} · {peso(v.totalPaid)} <span className="muted" style={{ fontWeight: 400 }}>on {v.receiptDate}</span></h3>
          <table><tbody>{rows.map(([k, val]) => <tr key={k}><td className="muted" style={{ width: "38%" }}>{k}</td><td>{val}</td></tr>)}</tbody></table>
          <table style={{ marginTop: 12 }}>
            <thead><tr><th>Item</th><th>Account</th><th className="num">Amount</th></tr></thead>
            <tbody>{v.lines.map((l) => <tr key={l.lineNo}><td>{l.description}</td><td>{l.accountId ? acct.get(l.accountId) : ""}</td><td className="num">{peso(l.amount)}</td></tr>)}</tbody>
            <tfoot>
              {Number(v.vatAmount) > 0 && <tr><td colSpan={2}>Input VAT</td><td className="num">{peso(v.vatAmount)}</td></tr>}
              {Number(v.tipAmount) > 0 && <tr><td colSpan={2}>Tip</td><td className="num">{peso(v.tipAmount)}</td></tr>}
              <tr><th colSpan={2}>Total paid</th><th className="num">{peso(v.totalPaid)}</th></tr>
            </tfoot>
          </table>
        </div>
        <div>
          {v.imageId && <div className="card"><h3 style={{ marginTop: 0 }}>Receipt</h3><a href={`/api/receipts/${v.imageId}`} target="_blank" rel="noreferrer"><img src={`/api/receipts/${v.imageId}`} alt="Receipt" style={{ maxWidth: "100%", maxHeight: 420, borderRadius: 8 }} /></a></div>}
          {saved.manager && <Checks title="Manager checks" checks={saved.manager} />}
          {financeNow && <Checks title="Finance checks" checks={financeNow} />}
          {manager && (
            <div className="card noprint">
              <h3 style={{ marginTop: 0 }}>Manager decision</h3>
              <p className="muted">Check the business purpose, budget and cost center.</p>
              <ActionForm action={claimDecisionAction}>
                <input type="hidden" name="id" value={v.id} />
                <label>Note (needed to return or reject)</label><input name="note" />
                <div className="row" style={{ marginTop: 8 }}>
                  <button name="op" value="approve">Approve</button>
                  <button name="op" value="return" className="secondary">Return for fixing</button>
                  <button name="op" value="reject" className="danger">Reject</button>
                </div>
              </ActionForm>
            </div>
          )}
          {isFinance && ["APPROVED", "HOLD"].includes(v.status) && (
            <div className="card noprint">
              <h3 style={{ marginTop: 0 }}>Finance review</h3>
              <p className="muted">Clearing posts the journal: {v.paymentMethod === "EMPLOYEE" ? "Dr expense / Cr Employee Reimbursements Payable" : v.paymentMethod === "PETTY_CASH_FUND" ? "the fund is replenished in a batch" : "Dr expense / Cr the corporate wallet or card"}.</p>
              <ActionForm action={claimDecisionAction}>
                <input type="hidden" name="id" value={v.id} />
                <label>Note (needed to hold, return or reject)</label><input name="note" />
                {financeNow?.some((c) => c.key.startsWith("duplicate:") && !c.ok) && <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}><input type="checkbox" name="override" style={{ width: "auto" }} />Not a duplicate (I checked; note required)</label>}
                <div className="row" style={{ marginTop: 8 }}>
                  <button name="op" value="clear">Clear and post</button>
                  <button name="op" value="hold" className="secondary">Hold</button>
                  <button name="op" value="return" className="secondary">Return</button>
                  <button name="op" value="reject" className="danger">Reject</button>
                </div>
              </ActionForm>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
