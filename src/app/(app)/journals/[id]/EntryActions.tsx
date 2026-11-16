"use client";
import { useState } from "react";
import { reverseEntry, workflowAction } from "../../actions";
import { ActionForm } from "@/components/ActionForm";

type Props = { id: string; status: string; canSubmit: boolean; canApprove: boolean; canVoid: boolean; defaultDate: string };

export function EntryActions({ id, status, canSubmit, canApprove, canVoid, defaultDate }: Props) {
  const [mode, setMode] = useState<"" | "reject" | "reverse">("");
  return (
    <div className="noprint">
      <div className="row" style={{ gap: 8 }}>
        {status === "DRAFT" && canSubmit && (
          <ActionForm action={workflowAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="submit" /><button>Submit for approval</button></ActionForm>
        )}
        {(status === "PENDING_APPROVAL" || status === "DRAFT") && canApprove && (
          <ActionForm action={workflowAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="approve" /><button>Approve and post</button></ActionForm>
        )}
        {status === "PENDING_APPROVAL" && canApprove && mode !== "reject" && <button type="button" className="secondary" onClick={() => setMode("reject")}>Return to preparer</button>}
        {status !== "VOID" && canVoid && mode !== "reverse" && (
          <button type="button" className="danger" onClick={() => setMode("reverse")}>{status === "POSTED" ? "Reverse entry" : "Void"}</button>
        )}
      </div>
      {mode === "reject" && (
        <ActionForm action={workflowAction} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="reject" />
          <label>Reason (the preparer will see this)</label><input name="reason" required />
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">Return</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
      {mode === "reverse" && (
        <ActionForm action={reverseEntry} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={id} />
          {status === "POSTED" && <><label>Reversal posting date</label><input type="date" name="date" defaultValue={defaultDate} /></>}
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">{status === "POSTED" ? "Confirm reversal" : "Confirm void"}</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
    </div>
  );
}
