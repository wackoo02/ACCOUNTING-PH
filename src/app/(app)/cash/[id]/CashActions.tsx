"use client";
import { useState } from "react";
import { cashWorkflow } from "../../bank-actions";
import { ActionForm } from "@/components/ActionForm";

type Props = { id: string; status: string; canSubmit: boolean; canApprove: boolean; canVoid: boolean; isCheck: boolean; released: boolean; defaultDate: string };

export function CashActions({ id, status, canSubmit, canApprove, canVoid, isCheck, released, defaultDate }: Props) {
  const [mode, setMode] = useState<"" | "reject" | "void">("");
  const op = (o: string, label: string, cls = "") => (
    <ActionForm action={cashWorkflow}><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={o} />{o === "release" && <input type="hidden" name="date" value={defaultDate} />}<button className={cls}>{label}</button></ActionForm>
  );
  return (
    <div className="noprint">
      <div className="row" style={{ gap: 8 }}>
        {status === "DRAFT" && canSubmit && op("submit", "Submit for approval")}
        {(status === "PENDING_APPROVAL" || status === "DRAFT") && canApprove && op("approve", "Approve and post")}
        {status === "PENDING_APPROVAL" && canApprove && mode !== "reject" && <button type="button" className="secondary" onClick={() => setMode("reject")}>Return to preparer</button>}
        {status === "POSTED" && isCheck && canSubmit && (released ? op("unrelease", "Mark as not released", "secondary") : op("release", "Mark check released today", "secondary"))}
        <button type="button" className="secondary" onClick={() => window.print()}>Print voucher</button>
        {status !== "VOID" && canVoid && mode !== "void" && <button type="button" className="danger" onClick={() => setMode("void")}>Void</button>}
      </div>
      {mode === "reject" && (
        <ActionForm action={cashWorkflow} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="reject" />
          <label>Reason (the preparer will see this)</label><input name="reason" required />
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">Return</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
      {mode === "void" && (
        <ActionForm action={cashWorkflow} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="void" />
          <div className="row">
            <div style={{ flex: 2 }}><label>Reason (e.g. spoiled check, wrong payee, cancelled)</label><input name="reason" required /></div>
            {status === "POSTED" && <div><label>Reversal date (blank = voucher date)</label><input type="date" name="date" /></div>}
          </div>
          {status === "POSTED" && <p className="muted">The GL entry is reversed. A voided check keeps its number so the check series stays complete.</p>}
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">Confirm void</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
    </div>
  );
}
