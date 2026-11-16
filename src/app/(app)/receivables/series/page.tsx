import { requireCtx } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import { SERIES_TYPES } from "@/lib/ar/service";
import { ActionForm } from "@/components/ActionForm";
import { saveSeriesAction } from "../../ar-actions";

const AUTH = { ATP: "Authority to Print (pre-printed / loose-leaf)", CAS: "Computerized Accounting System (CAS) acknowledgement", CRM_POS: "CRM / POS permit to use", EIS: "Electronic Invoicing System (EIS)" };
type S = Awaited<ReturnType<typeof prisma.documentSeries.findMany>>[number];

function SeriesForm({ s }: { s?: S }) {
  const d = (x: Date | null | undefined) => (x ? fmtDate(x) : "");
  return (
    <ActionForm action={saveSeriesAction} className="card">
      {s && <input type="hidden" name="id" value={s.id} />}
      <div className="row">
        <div><label>Document</label><select name="docType" defaultValue={s?.docType ?? "SALES_INVOICE"}>{Object.entries(SERIES_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div style={{ flex: 2 }}><label>Name</label><input name="name" defaultValue={s?.name} placeholder="e.g. Head office sales invoices" required /></div>
        <div><label>Permit type</label><select name="authorityType" defaultValue={s?.authorityType ?? "ATP"}>{Object.entries(AUTH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label>Permit / ATP no.</label><input name="authorityNo" defaultValue={s?.authorityNo ?? ""} /></div>
        <div><label>Date issued</label><input type="date" name="authorityDate" defaultValue={d(s?.authorityDate)} /></div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <div><label>Prefix</label><input name="prefix" defaultValue={s?.prefix ?? ""} placeholder="none" /></div>
        <div><label>First serial</label><input className="num" name="startNo" defaultValue={s?.startNo ?? 1} required /></div>
        <div><label>Last serial (blank = open-ended)</label><input className="num" name="endNo" defaultValue={s?.endNo ?? ""} /></div>
        <div><label>Next serial</label><input className="num" name="nextNo" defaultValue={s?.nextNo ?? ""} placeholder="= first serial" /></div>
        <div><label>Digits</label><input className="num" name="padding" defaultValue={s?.padding ?? 6} /></div>
        <div><label>BIR branch code</label><input name="branchCode" defaultValue={s?.branchCode ?? "00000"} /></div>
        <div><label>Valid until (if any)</label><input type="date" name="validUntil" defaultValue={d(s?.validUntil)} /></div>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <div style={{ flex: 2 }}><label>Printer name (ATP)</label><input name="printerName" defaultValue={s?.printerName ?? ""} /></div>
        <div><label>Printer TIN</label><input name="printerTin" defaultValue={s?.printerTin ?? ""} /></div>
        <div style={{ flex: 2 }}><label>Printer address</label><input name="printerAddress" defaultValue={s?.printerAddress ?? ""} /></div>
        <div><label>Printer accreditation no.</label><input name="printerAccreditationNo" defaultValue={s?.printerAccreditationNo ?? ""} /></div>
        <div><label>Accreditation date</label><input type="date" name="printerAccreditationDate" defaultValue={d(s?.printerAccreditationDate)} /></div>
      </div>
      <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
        <label style={{ flex: 0, whiteSpace: "nowrap" }}><input type="checkbox" name="isDefault" defaultChecked={s?.isDefault ?? true} style={{ width: "auto" }} /> Use this series by default</label>
        {s && <div style={{ flex: 0 }}><select name="isActive" defaultValue={s.isActive ? "on" : "off"}><option value="on">Active</option><option value="off">Inactive</option></select></div>}
        <div style={{ flex: 0 }}><button>{s ? "Save" : "Add series"}</button></div>
      </div>
    </ActionForm>
  );
}

export default async function SeriesPage() {
  const ctx = await requireCtx("reports.view");
  const rows = await prisma.documentSeries.findMany({ where: { organizationId: ctx.org.id }, orderBy: [{ docType: "asc" }, { createdAt: "asc" }] });
  const admin = can(ctx.role, "masters.manage");
  return (
    <>
      <div className="top"><h1>BIR Invoice Series</h1></div>
      <p className="muted">Register each serial range the BIR approved: the Authority to Print for printed invoices, or your CAS / CRM-POS / EIS permit for system-generated ones. Veritus gives each invoice, credit memo and collection receipt the next serial when it is approved, prints the permit and printer details at the bottom, and stops when a range is used up. Without a series, documents get plain numbers (SI-2026-000001) that are fine for testing but not BIR-registered.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Document</th><th>Name</th><th>Permit</th><th>Range</th><th>Next</th><th>Left</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((s) => <tr key={s.id}>
            <td>{SERIES_TYPES[s.docType as keyof typeof SERIES_TYPES] ?? s.docType}</td><td>{s.name}{s.isDefault && <span className="badge POSTED" style={{ marginLeft: 6 }}>default</span>}</td>
            <td>{s.authorityType} {s.authorityNo}{s.authorityDate ? ` · ${fmtDate(s.authorityDate)}` : ""}</td>
            <td>{s.prefix}{s.startNo} – {s.endNo ? `${s.prefix}${s.endNo}` : "open"}</td><td>{s.prefix}{String(s.nextNo).padStart(s.padding, "0")}</td>
            <td style={s.endNo && s.endNo - s.nextNo < 50 ? { color: "var(--danger)" } : undefined}>{s.endNo ? Math.max(0, s.endNo - s.nextNo + 1) : "—"}</td>
            <td>{s.isActive ? "Active" : "Inactive"}</td>
          </tr>)}
          {rows.length === 0 && <tr><td colSpan={7} className="muted">No series yet.</td></tr>}
        </tbody>
      </table></div>
      {admin ? <>
        <h2>Add a series</h2>
        <SeriesForm />
        {rows.map((s) => <details key={s.id}><summary>Edit {s.name}</summary><SeriesForm s={s} /></details>)}
      </> : <p className="muted">Only owners and administrators can change invoice series.</p>}
    </>
  );
}
