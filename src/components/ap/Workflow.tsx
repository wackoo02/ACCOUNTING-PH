"use client";
import { useState } from "react";
import { apWorkflow } from "@/app/(app)/ap-actions";
import { ActionForm } from "../ActionForm";

type Op = "submit" | "approve" | "return" | "void" | "cancel" | "close";
const LABEL: Record<Op, string> = { submit: "Submit for approval", approve: "Approve", return: "Return to preparer", void: "Void", cancel: "Cancel", close: "Close" };

/** Workflow buttons for a purchasing / payables document. Only the allowed ops are passed in. */
export function Workflow({ doc, id, ops, approveLabel, approveHint, voidNote }: { doc: string; id: string; ops: Op[]; approveLabel?: string; approveHint?: string; voidNote?: string }) {
  const [mode, setMode] = useState<"" | Op>("");
  const hidden = (op: string) => <><input type="hidden" name="doc" value={doc} /><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={op} /></>;
  const needsReason = (o: Op) => o === "return" || o === "void" || o === "cancel" || o === "close";
  return (
    <div className="noprint" style={{ flex: "0 0 auto", minWidth: 0 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {ops.includes("submit") && <ActionForm action={apWorkflow}>{hidden("submit")}<button style={{ whiteSpace: "nowrap" }}>{LABEL.submit}</button></ActionForm>}
        {ops.includes("approve") && <ActionForm action={apWorkflow}>{hidden("approve")}<button title={approveHint} style={{ whiteSpace: "nowrap" }}>{approveLabel ?? "Approve"}</button></ActionForm>}
        {ops.filter(needsReason).map((o) => mode !== o && <button key={o} type="button" className={o === "void" || o === "cancel" ? "danger" : "secondary"} style={{ whiteSpace: "nowrap" }} onClick={() => setMode(o)}>{LABEL[o]}</button>)}
        <button type="button" className="secondary" onClick={() => window.print()}>Print</button>
      </div>
      {mode && needsReason(mode) && (
        <ActionForm action={apWorkflow} className="card" style={{ marginTop: 8 }}>
          {hidden(mode)}
          <div className="row">
            <div style={{ flex: 2 }}><label>Reason{mode === "return" ? " (the preparer will see this)" : ""}</label><input name="reason" required /></div>
            {mode === "void" && <div><label>Reversal date (blank = document date)</label><input type="date" name="date" /></div>}
          </div>
          {mode === "void" && voidNote && <p className="muted">{voidNote}</p>}
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className={mode === "return" || mode === "close" ? "" : "danger"}>Confirm {LABEL[mode].toLowerCase()}</button><button type="button" className="secondary" onClick={() => setMode("")}>Back</button></div>
        </ActionForm>
      )}
    </div>
  );
}
