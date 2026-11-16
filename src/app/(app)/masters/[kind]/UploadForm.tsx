"use client";
import { useActionState } from "react";
import { uploadMasters } from "../../actions";
import { Errors } from "@/components/Errors";

export function UploadForm({ kind }: { kind: string }) {
  const [s, a, p] = useActionState(uploadMasters, undefined);
  return (
    <form action={a} className="card noprint">
      <Errors errors={s?.errors} />
      {s?.message && <div className="notice">{s.message}</div>}
      <input type="hidden" name="_kind" value={kind} />
      <div className="row">
        <div style={{ flex: 3 }}><label>Bulk upload from Excel (.xlsx). Existing codes are updated, new codes are added.</label><input type="file" name="file" accept=".xlsx" required /></div>
        <div style={{ flex: 0 }}><button disabled={p}>{p ? "Uploading…" : "Upload"}</button></div>
      </div>
    </form>
  );
}
