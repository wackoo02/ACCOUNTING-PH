"use client";
import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { leaseWorkflow } from "../../lease-actions";

type Props = {
  id: string; status: string; exempt: boolean; canEdit: boolean; canApprove: boolean; canPost: boolean; canUndo: boolean; hasEvents: boolean;
  nextStart: string | null; monthEnd: string; endDate: string; payment: string; rate: string; escalation: string;
};

export function LeaseActions(p: Props) {
  const [mode, setMode] = useState<"" | "modify" | "terminate">("");
  const op = (o: string, label: string, cls = "", confirm?: string, extra?: React.ReactNode) => (
    <ActionForm action={leaseWorkflow} confirm={confirm}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="op" value={o} />{extra}<button className={cls}>{label}</button></ActionForm>
  );
  const active = p.status === "ACTIVE";
  return (
    <div className="noprint" style={{ flex: 1 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
        {p.status === "DRAFT" && p.canApprove && op("commence", "Approve and start lease", "", "Post the opening entry for this lease?")}
        {p.status === "DRAFT" && p.canEdit && op("delete", "Delete draft", "danger", "Delete this draft lease?")}
        {active && p.canPost && op("post", `Post through ${p.monthEnd}`, "secondary", undefined, <input type="hidden" name="through" value={p.monthEnd} />)}
        {active && p.canPost && !p.exempt && <button type="button" className="secondary" onClick={() => setMode(mode === "modify" ? "" : "modify")}>Modify</button>}
        {active && p.canPost && <button type="button" className="secondary" onClick={() => setMode(mode === "terminate" ? "" : "terminate")}>Terminate early</button>}
        {p.hasEvents && p.canUndo && op("undo", "Undo last posting", "secondary", "Reverse the most recent lease posting?")}
        <button type="button" className="secondary" onClick={() => window.print()}>Print</button>
      </div>
      {mode === "modify" && (
        <ActionForm action={leaseWorkflow} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={p.id} /><input type="hidden" name="op" value="modify" />
          <p className="muted">For a change that is not a separate lease (PFRS 16.44-46): renewal or shortening, new rent, a new discount rate, or giving back part of the space. If the change adds a new asset at its normal price, set it up as a new lease instead.</p>
          <div className="grid">
            <div><label>Effective date</label><input type="date" name="effectiveDate" defaultValue={p.nextStart ?? ""} required /><div className="muted">Within the first unposted month</div></div>
            <div><label>New end date</label><input type="date" name="newEndDate" defaultValue={p.endDate} required /></div>
            <div><label>Payment per period from that date</label><input name="newPaymentAmount" defaultValue={p.payment} required /></div>
            <div><label>Escalation %</label><input name="newEscalationPct" defaultValue={p.escalation} /></div>
            <div><label>Discount rate (annual %)</label><input name="newDiscountRate" placeholder={`Blank = keep ${p.rate}%`} /><div className="muted">Use a revised rate for a modification; keep it for an index change.</div></div>
            <div><label>Decrease in scope %</label><input name="scopeReductionPct" placeholder="0" /><div className="muted">e.g. 50 if half the floor area is given back</div></div>
          </div>
          <label>Description</label><input name="memo" required placeholder="e.g. Renewed for 2 years at P110,000 a month" />
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button>Post modification</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
      {mode === "terminate" && (
        <ActionForm action={leaseWorkflow} className="card" style={{ marginTop: 8 }} confirm="Terminate this lease and take it off the books?">
          <input type="hidden" name="id" value={p.id} /><input type="hidden" name="op" value="terminate" />
          <div className="grid">
            <div><label>Last day of the lease</label><input type="date" name="date" defaultValue={p.nextStart ?? ""} required /><div className="muted">Within the first unposted month</div></div>
            <div><label>Termination penalty (optional)</label><input name="penalty" placeholder="0.00" /></div>
            <div style={{ gridColumn: "span 2" }}><label>Reason</label><input name="reason" required /></div>
          </div>
          <p className="muted">Interest and depreciation up to that day are posted, then the ROU asset and lease liability come off the books; the difference and any penalty go to the gain or loss account.</p>
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">Confirm termination</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
    </div>
  );
}
