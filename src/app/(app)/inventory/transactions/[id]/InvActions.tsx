"use client";
import { useState } from "react";
import { inventoryWorkflow } from "../../../inventory-actions";
import { ActionForm } from "@/components/ActionForm";

type Props = { id: string; type: string; status: string; canSubmit: boolean; canPost: boolean; canApprove: boolean; canVoid: boolean };

export function InvActions({ id, type, status, canSubmit, canPost, canApprove, canVoid }: Props) {
  const [mode, setMode] = useState<"" | "reject" | "void">("");
  const op = (o: string, label: string, cls = "") => (
    <ActionForm action={inventoryWorkflow}><input type="hidden" name="id" value={id} /><input type="hidden" name="type" value={type} /><input type="hidden" name="op" value={o} /><button className={cls}>{label}</button></ActionForm>
  );
  return (
    <div className="noprint">
      <div className="row" style={{ gap: 8 }}>
        {status === "DRAFT" && canSubmit && op("submit", "Submit for approval")}
        {canPost && op("post", status === "PENDING_APPROVAL" ? "Approve and post" : "Post")}
        {status === "PENDING_APPROVAL" && canApprove && mode !== "reject" && <button type="button" className="secondary" onClick={() => setMode("reject")}>Return to preparer</button>}
        <button type="button" className="secondary" onClick={() => window.print()}>Print</button>
        {status !== "VOID" && canVoid && mode !== "void" && <button type="button" className="danger" onClick={() => setMode("void")}>Void</button>}
      </div>
      {mode === "reject" && (
        <ActionForm action={inventoryWorkflow} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="reject" />
          <label>Reason (the preparer will see this)</label><input name="reason" required />
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">Return</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
      {mode === "void" && (
        <ActionForm action={inventoryWorkflow} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="void" />
          <div className="row">
            <div style={{ flex: 2 }}><label>Reason</label><input name="reason" required /></div>
            {status === "POSTED" && <div><label>Void date (blank = document date)</label><input type="date" name="date" /></div>}
          </div>
          {status === "POSTED" && <p className="muted">Stock is put back (or taken out again) and the GL entry is reversed. A receipt can only be voided while its stock is still unused.</p>}
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">Confirm void</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
    </div>
  );
}
