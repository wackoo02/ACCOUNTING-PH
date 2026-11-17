"use client";
import { useActionState } from "react";
import { uploadStatement } from "../../bank-actions";
import { Errors } from "@/components/Errors";
import { MasterPicker } from "@/components/MasterPicker";

export function UploadStatement({ banks, defaultBank }: { banks: { id: string; label: string }[]; defaultBank?: string }) {
  const [s, a, p] = useActionState(uploadStatement, undefined);
  return (
    <form action={a} className="card noprint">
      <Errors errors={s?.errors} />
      {s?.message && <div className="notice">{s.message}</div>}
      <div className="row">
        <div><label>Bank account</label><MasterPicker name="bankAccountId" ariaLabel="Bank account" required defaultValue={defaultBank ?? banks[0]?.id} options={banks.map((b) => ({ value: b.id, label: b.label }))} add={{ kind: "banks" }} /></div>
        <div style={{ flex: 2 }}><label>Statement file (.xlsx, from the template)</label><input type="file" name="file" accept=".xlsx" required /></div>
        <div><label>Beginning balance</label><input name="openingBalance" className="num" placeholder="blank = last statement's ending" /></div>
        <div><label>Ending balance</label><input name="closingBalance" className="num" placeholder="blank = from the file" /></div>
        <div style={{ flex: 0 }}><button disabled={p}>{p ? "Uploading…" : "Upload"}</button></div>
      </div>
    </form>
  );
}
