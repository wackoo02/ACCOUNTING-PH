// Small shared pieces for the Expense & Mobility and Asset Audit web pages.
import type { IconName } from "@/lib/icons";
import { formatPeso, toCentavos } from "@/lib/money";

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft", SUBMITTED: "With manager", RETURNED: "Returned", REJECTED: "Rejected", APPROVED: "Finance review", HOLD: "On hold",
  CLEARED: "Cleared", BATCHED: "In replenishment", REPLENISHED: "Replenished", REIMBURSED: "Reimbursed",
};
export const MODULE_ICON: Record<string, IconName> = { PETTY_CASH: "petty-cash", TRAVEL: "travel", TRANSPORT: "transport", DELIVERY: "sent-package" };

export const peso = (v: string | number | null | undefined) => formatPeso(toCentavos(String(v ?? "0")));

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge X-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

/** Horizontal bars for a ranked breakdown. */
export function Breakdown({ title, rows, limit = 8 }: { title: string; rows: { key: string; label: string; amount: string; count: number }[]; limit?: number }) {
  const max = Math.max(...rows.map((r) => Number(r.amount)), 1);
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      {rows.length === 0 ? <p className="muted">No recorded claims in this period.</p> : rows.slice(0, limit).map((r) => (
        <div key={r.key} className="hbar">
          <span className="lbl" title={r.label}>{r.label}</span>
          <span className="track"><i style={{ width: `${(Number(r.amount) / max) * 100}%` }} /></span>
          <b>{peso(r.amount)}</b><span className="muted cnt">{r.count}</span>
        </div>
      ))}
    </div>
  );
}
