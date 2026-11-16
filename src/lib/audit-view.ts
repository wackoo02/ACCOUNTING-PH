// Turn audit log before/after snapshots into a readable list of changed fields.
export function diffFields(before: unknown, after: unknown): { field: string; from: string; to: string }[] {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return [];
  const b = before as Record<string, unknown>, a = after as Record<string, unknown>;
  const skip = new Set(["updatedAt", "createdAt", "id", "organizationId"]);
  const out: { field: string; from: string; to: string }[] = [];
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (skip.has(k)) continue;
    const f = show(b[k]), t = show(a[k]);
    if (f !== t) out.push({ field: k, from: f, to: t });
  }
  return out;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) {
    // Journal lines: summarise as "account dr/cr" rows.
    return v.map((x) => {
      if (x && typeof x === "object" && "accountId" in x) {
        const l = x as Record<string, unknown>;
        return `#${l.lineNo} ${l.accountId} Dr ${l.debit} Cr ${l.credit}${l.currencyCode && l.currencyCode !== "PHP" ? ` (${l.currencyCode} ${l.fxDebit}/${l.fxCredit} @ ${l.fxRate})` : ""}`;
      }
      return JSON.stringify(x);
    }).join("; ");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export const ACTION_LABELS: Record<string, string> = {
  "inventory.create": "Created", "inventory.update": "Edited (draft)", "inventory.submit": "Submitted for approval", "inventory.post": "Posted",
  "inventory.reject": "Returned to preparer", "inventory.void": "Voided", "count.create": "Count sheet created", "count.update": "Counts entered",
  "count.submit": "Count submitted", "count.reject": "Returned for recount", "count.post": "Count approved and posted", "count.void": "Count cancelled",
  "journal.create": "Created (draft)",
  "journal.create_submit": "Created and submitted for approval",
  "journal.create_post": "Created and posted",
  "journal.update": "Edited",
  "journal.submit": "Submitted for approval",
  "journal.approve_post": "Approved and posted",
  "journal.reject": "Returned to preparer",
  "journal.void": "Voided",
  "journal.reverse": "Reversed",
  "loan.create": "Loan created",
  "loan.update": "Loan edited",
  "loan.drawdown": "Drawdown posted",
  "loan.accrual": "Interest accrued",
  "loan.reclass": "Current portion reclassified",
  "loan.modification": "Terms modified",
  "loan.write_off": "Settled: costs written off",
  "loan.undo": "Transaction undone",
  "loan.payment_posted": "Payment voucher posted",
  "loan.payment_void": "Payment voucher voided",
  "loan.covenant_add": "Covenant added",
  "loan.covenant_update": "Covenant updated",
  "loan.covenant_remove": "Covenant removed",
  "cash.create": "Created (draft)",
  "cash.update": "Edited",
  "cash.submit": "Submitted for approval",
  "cash.post": "Approved and posted",
  "cash.reject": "Returned to preparer",
  "cash.void": "Voided",
  "check.release": "Check released to payee",
  "check.unrelease": "Check marked not released",
  "bank.statement_upload": "Bank statement uploaded",
  "bank.statement_delete": "Bank statement deleted",
  "bank.match": "Bank lines matched and cleared",
  "bank.unmatch": "Bank match undone",
  "bank.clear_no_statement": "Cleared without a statement line",
  "bank.reconcile": "Bank reconciliation finalized",
  "bank.reopen": "Bank reconciliation reopened",
  "ar.create": "Created (draft)",
  "ar.update": "Edited",
  "ar.submit": "Submitted for approval",
  "ar.post": "Approved and issued",
  "ar.reject": "Returned to preparer",
  "ar.void": "Voided",
  "ar.apply": "Applied to invoices",
  "ar.email": "Emailed to customer",
  "ar.series": "Invoice series changed",
  "billing.save": "Billing contract saved",
  "billing.run": "Invoices generated",
};
