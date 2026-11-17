"use client";
import { useState } from "react";
import { countWorkflow } from "../../../inventory-actions";
import { ActionForm } from "@/components/ActionForm";
import { MasterPicker } from "@/components/MasterPicker";
import { idOpts } from "@/lib/lookup";

type Line = { id: string; item: string; unit: string; location: string; lotNo: string; systemQty: string; onHand: string; changed: boolean; counted: string; variance: string; note: string };
type Props = { id: string; status: string; canEdit: boolean; canApprove: boolean; canReject: boolean; lines: Line[]; items: { id: string; code: string; name: string }[]; locations: { id: string; code: string }[] };

export function CountSheet({ id, status, canEdit, canApprove, canReject, lines, items, locations }: Props) {
  const [blind, setBlind] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const setOp = (e: React.MouseEvent<HTMLButtonElement>, v: string) => { (e.currentTarget.form!.elements.namedItem("op") as HTMLInputElement).value = v; };
  const op = (o: string, label: string, cls = "") => (
    <ActionForm action={countWorkflow}><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={o} /><button className={cls}>{label}</button></ActionForm>
  );
  return (
    <>
      <div className="row noprint" style={{ gap: 8, marginBottom: 8 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} style={{ width: "auto" }} /> Blind count (hide system quantities)</label>
        <button type="button" className="secondary" onClick={() => window.print()}>Print count sheet</button>
        {canApprove && op("post", "Approve and post variances")}
        {canReject && !rejecting && <button type="button" className="secondary" onClick={() => setRejecting(true)}>Return for recount</button>}
        {status === "DRAFT" && canEdit && op("void", "Cancel count", "danger")}
      </div>
      {rejecting && (
        <ActionForm action={countWorkflow} className="card"><input type="hidden" name="id" value={id} /><input type="hidden" name="op" value="reject" />
          <label>Reason</label><input name="reason" required />
          <div className="row" style={{ gap: 6, marginTop: 8 }}><button className="danger">Return</button><button type="button" className="secondary" onClick={() => setRejecting(false)}>Cancel</button></div>
        </ActionForm>
      )}
      <ActionForm action={countWorkflow}>
        <input type="hidden" name="id" value={id} /><input type="hidden" name="op" defaultValue="save" />
        <div className="table-wrap"><table>
          <thead><tr><th>Bin</th><th>Item</th><th>Unit</th><th>Lot / serial</th>{!blind && <th className="num">System qty</th>}<th className="num" style={{ width: 120 }}>Counted</th>{!blind && <th className="num">Variance</th>}<th>Note</th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <td>{l.location}</td><td>{l.item}</td><td>{l.unit}</td><td>{l.lotNo}</td>
                {!blind && <td className="num">{l.systemQty}{l.changed && status !== "POSTED" && <div className="muted" title="Stock moved after the sheet was made; the variance uses what is on hand now">now {l.onHand}</div>}</td>}
                <td>{canEdit ? <input className="num" name={`q_${l.id}`} defaultValue={l.counted} inputMode="decimal" aria-label={`Count ${l.item}`} /> : l.counted}</td>
                {!blind && <td className="num">{l.variance}</td>}
                <td>{canEdit ? <input name={`n_${l.id}`} defaultValue={l.note} /> : l.note}</td>
              </tr>
            ))}
            {canEdit && [0, 1, 2].map((i) => (
              <tr key={`a${i}`} className="noprint">
                <td><MasterPicker name={`a_loc_${i}`} ariaLabel={`Bin, extra line ${i + 1}`} placeholder="—" emptyLabel="—" options={locations.map((x) => ({ value: x.id, code: x.code, label: "" }))} /></td>
                <td colSpan={2}><MasterPicker name={`a_item_${i}`} ariaLabel={`Item, extra line ${i + 1}`} placeholder="+ Item found, not on the sheet…" emptyLabel="—" options={idOpts(items)} /></td>
                <td><input name={`a_lot_${i}`} placeholder="Lot / serial" /></td>{!blind && <td />}
                <td><input className="num" name={`a_qty_${i}`} inputMode="decimal" /></td>{!blind && <td />}<td />
              </tr>
            ))}
          </tbody>
        </table></div>
        {canEdit && <div className="row noprint" style={{ gap: 8 }}>
          <button className="secondary" onClick={(e) => setOp(e, "save")}>Save counts</button>
          <button onClick={(e) => setOp(e, "save-submit")}>Save and submit for approval</button>
        </div>}
      </ActionForm>
      <div className="print-only card grid sign"><div><label>Counted by</label><br />______________________</div><div><label>Checked by</label><br />______________________</div></div>
    </>
  );
}
