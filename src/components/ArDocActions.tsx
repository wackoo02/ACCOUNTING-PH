"use client";
import { useState } from "react";
import { emailAction, invoiceWorkflow, receiptWorkflow } from "@/app/(app)/ar-actions";
import { ActionForm } from "./ActionForm";

type Props = {
  kind: "invoice" | "receipt"; id: string; status: string; pdfHref: string; emailDocType: string; recipients: string;
  canSubmit: boolean; canApprove: boolean; canVoid: boolean; editHref?: string;
};

/** Workflow buttons (submit / approve / return / void), PDF and email for an AR document. */
export function ArDocActions({ kind, id, status, pdfHref, emailDocType, recipients, canSubmit, canApprove, canVoid, editHref }: Props) {
  const [mode, setMode] = useState<"" | "reject" | "void" | "email">("");
  const wf = kind === "invoice" ? invoiceWorkflow : receiptWorkflow;
  const op = (o: string, label: string, cls = "") => (
    <ActionForm action={wf}><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={o} /><button className={cls}>{label}</button></ActionForm>
  );
  return (
    <div className="noprint">
      <div className="row" style={{ gap: 8 }}>
        {status === "DRAFT" && editHref && canSubmit && <a className="btn secondary" href={editHref}>Edit</a>}
        {status === "DRAFT" && canSubmit && op("submit", "Submit for approval")}
        {(status === "PENDING_APPROVAL" || status === "DRAFT") && canApprove && op("approve", kind === "invoice" ? "Approve and issue" : "Approve and post")}
        {status === "PENDING_APPROVAL" && canApprove && <button type="button" className="secondary" onClick={() => setMode("reject")}>Return to preparer</button>}
        <a className="btn secondary" href={pdfHref} target="_blank" rel="noreferrer">{status === "POSTED" ? "Print / PDF" : "Preview PDF"}</a>
        {status === "POSTED" && canSubmit && <button type="button" className="secondary" onClick={() => setMode("email")}>Email to customer</button>}
        {status !== "VOID" && canVoid && <button type="button" className="danger" onClick={() => setMode("void")}>Void</button>}
      </div>
      {mode === "reject" && (
        <ActionForm action={wf} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="reject" />
          <label>Reason (the preparer will see this)</label><input name="reason" required />
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">Return</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
      {mode === "void" && (
        <ActionForm action={wf} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="void" />
          <div className="row">
            <div style={{ flex: 2 }}><label>Reason ({kind === "invoice" ? "e.g. cancelled sale, wrong customer" : "e.g. bounced check, wrong customer"})</label><input name="reason" required /></div>
            {status === "POSTED" && <div><label>Reversal date (blank = document date)</label><input type="date" name="date" /></div>}
          </div>
          {status === "POSTED" && <p className="muted">{kind === "invoice" ? "The serial stays in the series marked cancelled (keep all copies of the printed invoice). The GL entry is reversed." : "The invoices it paid become open again and the GL entry is reversed."}</p>}
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">Confirm void</button><button type="button" className="secondary" onClick={() => setMode("")}>Cancel</button></div>
        </ActionForm>
      )}
      {mode === "email" && (
        <ActionForm action={emailAction} className="card" style={{ marginTop: 8 }}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="docType" value={emailDocType} />
          <label>Send to (separate addresses with ; or ,)</label><input name="recipients" defaultValue={recipients} required />
          <label style={{ marginTop: 8 }}>Message (optional)</label><input name="note" />
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button>Send with PDF attached</button><button type="button" className="secondary" onClick={() => setMode("")}>Close</button></div>
        </ActionForm>
      )}
    </div>
  );
}
